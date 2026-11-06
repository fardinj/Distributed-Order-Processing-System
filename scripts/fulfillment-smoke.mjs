import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from 'pg';
import { connect } from 'amqplib';
const secret = async (name) => (await readFile(`/run/secrets/${name}_password`, 'utf8')).trim();
const pass = (message) => console.log(`PASS ${message}`);
async function token(id, name) {
  const r = await fetch('http://identity:8080/identity/realms/tops/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: await secret(name),
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(r.status, 200);
  return (await r.json()).access_token;
}
const [a, b, admin, billing] = await Promise.all([
  token('fixture-customer-a', 'fixture_customer_a'),
  token('fixture-customer-b', 'fixture_customer_b'),
  token('fixture-admin', 'fixture_admin'),
  token('billing-service', 'billing_service'),
]);
async function api(path, bearer = a, method = 'GET', body, key) {
  const r = await fetch(`http://gateway:3000/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, body: await r.json() };
}
const clients = new Map();
async function db(owner, sql, values = []) {
  if (!clients.has(owner)) {
    const c = new Client({
      host: 'postgres',
      database: owner,
      user: `${owner}_migrator`,
      password: await secret(`${owner}_migration`),
      connectionTimeoutMillis: 2000,
    });
    await c.connect();
    clients.set(owner, c);
  }
  return (await clients.get(owner).query(sql, values)).rows;
}
async function until(work, message, timeout = 45000) {
  const end = Date.now() + timeout;
  do {
    const value = await work();
    if (value) return value;
    await pause(200);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${message}`);
}
const products = [];
async function product(type, price = '50', days = 30) {
  const r = await api(
    '/admin/products',
    admin,
    'POST',
    {
      name: `Fulfillment ${randomUUID()}`,
      type,
      priceMinor: price,
      ...(type === 'SUBSCRIPTION' ? { subscriptionDays: days } : {}),
      reason: 'Step 5 isolated fixture',
    },
    randomUUID(),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  products.push(r.body.id);
  if (type === 'PHYSICAL')
    assert.equal(
      (
        await api(
          `/admin/inventory/${r.body.id}/adjustments`,
          admin,
          'POST',
          { expectedVersion: 1, delta: 10, reason: 'Fulfillment fixture stock' },
          randomUUID(),
        )
      ).status,
      201,
    );
  return r.body;
}
async function checkout(lines) {
  const r = await api(
    '/orders',
    a,
    'POST',
    { items: lines.map(([p, quantity = 1]) => ({ productId: p.id, quantity })) },
    randomUUID(),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function control(item, outcome = 'SUCCESS', defer = false, failUntil = 1) {
  await db(
    'commerce',
    `INSERT INTO fulfillment_simulation_rules(item_id,outcome,not_before,fail_until_attempt) VALUES($1,$2,clock_timestamp()+$3*interval '1 second',$4)
 ON CONFLICT(item_id) DO UPDATE SET outcome=EXCLUDED.outcome,not_before=EXCLUDED.not_before,fail_until_attempt=EXCLUDED.fail_until_attempt`,
    [item.id, outcome, defer ? 3600 : 0, failUntil],
  );
}
async function pay(o) {
  const r = await api(`/orders/${o.id}/payment`, a, 'POST', {
    expectedRevision: o.checkoutRevision,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return until(async () => {
    const r = (await api(`/orders/${o.id}`)).body;
    return r.financial.status === 'SUCCEEDED' ? r : undefined;
  }, 'captured payment');
}
async function final(o, status) {
  return until(async () => {
    const r = (await api(`/orders/${o.id}`)).body;
    return r.status === status ? r : undefined;
  }, `order ${status}`);
}
async function unpause(o) {
  for (const item of o.items) {
    await db(
      'commerce',
      'UPDATE fulfillment_simulation_rules SET not_before=clock_timestamp() WHERE item_id=$1',
      [item.id],
    );
    await db(
      'commerce',
      'UPDATE fulfillment_jobs SET available_at=clock_timestamp() WHERE item_id=$1',
      [item.id],
    );
  }
}
async function binding(work) {
  const c = await connect(
    `amqp://billing:${encodeURIComponent(await secret('billing_rabbitmq'))}@rabbitmq:5672/tops`,
  );
  c.on('error', () => {});
  const ch = await c.createChannel();
  ch.on('error', () => {});
  await ch.unbindQueue('billing.q.events', 'commerce.events', '#');
  try {
    return await work();
  } finally {
    await ch.bindQueue('billing.q.events', 'commerce.events', '#');
    await c.close();
  }
}
async function publish(owner, row, changes = {}) {
  const c = await connect(
    `amqp://${owner}:${encodeURIComponent(await secret(`${owner}_rabbitmq`))}@rabbitmq:5672/tops`,
  );
  c.on('error', () => {});
  const ch = await c.createConfirmChannel();
  ch.on('error', () => {});
  const env = {
    schemaVersion: 1,
    id: randomUUID(),
    producer: owner,
    kind: row.kind,
    aggregateId: row.aggregate_id,
    generation: row.generation,
    correlationId: row.payload.correlationId,
    payload: row.payload,
    ...changes,
  };
  try {
    await new Promise((resolve, reject) =>
      ch.publish(
        `${owner}.events`,
        env.kind,
        Buffer.from(JSON.stringify(env)),
        { persistent: true, mandatory: true, messageId: env.id },
        (e) => (e ? reject(e) : resolve()),
      ),
    );
  } finally {
    await c.close();
  }
  return env.id;
}
const phase = process.argv[2] ?? 'main';
try {
  if (phase.startsWith('prepare-')) {
    const p = await product(
      'DIGITAL',
      '123456789012345678901234567890123456789012345678901234567890',
    );
    const o = await checkout([[p]]);
    await control(o.items[0], 'PERMANENT', true);
    await pay(o);
    await writeFile(
      `/verification/fulfillment-${phase.slice(8)}.json`,
      JSON.stringify({ order: o, productId: p.id }),
    );
    pass('paid fixture prepared before outage; fulfillment is durably deferred');
  } else if (phase.startsWith('run-')) {
    const state = JSON.parse(
      await readFile(`/verification/fulfillment-${phase.slice(4)}.json`, 'utf8'),
    );
    await unpause(state.order);
    const d = await until(
      async () =>
        (
          await db('commerce', 'SELECT * FROM item_refund_dispositions WHERE order_id=$1', [
            state.order.id,
          ])
        )[0],
      'durable refund obligation',
    );
    if (phase === 'run-bank')
      await until(
        async () =>
          (
            await db(
              'billing',
              "SELECT id FROM refunds WHERE disposition_id=$1 AND status='UNKNOWN'",
              [d.id],
            )
          ).length,
        'unknown provider return',
      );
    else
      assert.equal(
        (
          await db(
            'commerce',
            "SELECT published_at FROM outbox WHERE aggregate_id=$1 AND kind='RefundRequested'",
            [d.id],
          )
        )[0].published_at,
        null,
      );
    const o = (await api(`/orders/${state.order.id}`)).body;
    assert.equal(o.financial.refundedMinor, '0');
    assert.equal(o.financial.pendingRefundMinor, o.totalMinor);
    assert.equal(
      (await db('commerce', 'SELECT released_at FROM admission_slots WHERE order_id=$1', [o.id]))[0]
        .released_at,
      null,
    );
    pass(
      'outage preserves full unpaid refund obligation and admission, with zero confirmed returned money',
    );
  } else if (phase.startsWith('recover-')) {
    const state = JSON.parse(
      await readFile(`/verification/fulfillment-${phase.slice(8)}.json`, 'utf8'),
    );
    products.push(state.productId);
    if (phase === 'recover-bank')
      await db(
        'billing',
        'UPDATE refunds SET next_reconcile_at=clock_timestamp() WHERE disposition_id IN(SELECT disposition_id FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=$1)',
        [state.order.id],
      );
    const o = await final(state.order, 'RESOLVED');
    assert.equal(o.financial.summary, 'REFUNDED');
    assert.equal(o.financial.refundedMinor, o.totalMinor);
    assert.equal(o.fulfillment.digitalGrants.length, 0);
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_refunds WHERE charge_key=$1', [
          o.paymentOperationKey,
        ])
      ).length,
      1,
    );
    pass('restored dependency/owners recover one exact refund without re-running fulfillment');
  } else {
    if (process.env.FULFILLMENT_SECOND_ORIGIN)
      await until(async () => {
        try {
          return (await fetch(`${process.env.FULFILLMENT_SECOND_ORIGIN}/health/live`)).ok;
        } catch {
          return false;
        }
      }, 'second Commerce worker');
    const digital = await product('DIGITAL', '20'),
      sub = await product('SUBSCRIPTION', '30', 13),
      physical = await product('PHYSICAL', '10');
    const all = await checkout([[digital], [sub], [physical, 3]]);
    await pay(all);
    const completed = await final(all, 'COMPLETED');
    assert.ok(completed.items.every((i) => i.status === 'SUCCEEDED'));
    assert.equal(completed.fulfillment.digitalGrants.length, 1);
    assert.equal(completed.fulfillment.subscriptionExtensions.length, 1);
    assert.equal(completed.fulfillment.shipments.length, 1);
    assert.equal((await api(`/admin/products/${physical.id}`, admin)).body.stock.available, '7');
    assert.equal(
      (
        await db('commerce', 'SELECT released_at FROM admission_slots WHERE order_id=$1', [all.id])
      )[0].released_at instanceof Date,
      true,
    );
    await db(
      'commerce',
      "UPDATE fulfillment_jobs SET status='READY',available_at=clock_timestamp() WHERE item_id=ANY($1::uuid[])",
      [all.items.map((i) => i.id)],
    );
    await until(
      async () =>
        !(
          await db(
            'commerce',
            "SELECT item_id FROM fulfillment_jobs WHERE item_id=ANY($1::uuid[]) AND status<>'DONE'",
            [all.items.map((i) => i.id)],
          )
        ).length,
      'duplicate work no-op',
    );
    assert.equal(
      (
        await db('commerce', 'SELECT item_id FROM shipments WHERE item_id=ANY($1::uuid[])', [
          all.items.map((i) => i.id),
        ])
      ).length,
      1,
    );
    assert.equal(
      (
        await db(
          'commerce',
          'SELECT item_id FROM subscription_extensions WHERE item_id=ANY($1::uuid[])',
          [all.items.map((i) => i.id)],
        )
      ).length,
      1,
    );
    pass(
      'all typed processors complete atomically; duplicate work does not repeat grants, extensions, shipments or stock decrement',
    );

    const renewal = await product('SUBSCRIPTION', '25', 30);
    const r1 = await checkout([[renewal]]),
      r2 = await checkout([[renewal]]);
    const customer = r1.customerId;
    await db(
      'commerce',
      "INSERT INTO subscriptions(customer_id,product_id,expires_at) VALUES($1,$2,date_trunc('milliseconds',clock_timestamp()+interval '10 days'))",
      [customer, renewal.id],
    );
    const baseline = (
      await db(
        'commerce',
        'SELECT expires_at FROM subscriptions WHERE customer_id=$1 AND product_id=$2',
        [customer, renewal.id],
      )
    )[0].expires_at;
    await control(r1.items[0], 'SUCCESS', true);
    await control(r2.items[0], 'SUCCESS', true);
    await Promise.all([pay(r1), pay(r2)]);
    const current = (await api(`/admin/products/${renewal.id}`, admin)).body;
    assert.equal(
      (
        await api(
          `/admin/products/${renewal.id}`,
          admin,
          'PATCH',
          {
            expectedVersion: current.version,
            subscriptionDays: 90,
            reason: 'Paid duration must remain thirty days',
          },
          randomUUID(),
        )
      ).status,
      200,
    );
    await unpause(r1);
    await unpause(r2);
    await Promise.all([final(r1, 'COMPLETED'), final(r2, 'COMPLETED')]);
    const expiry = (
      await db(
        'commerce',
        'SELECT expires_at FROM subscriptions WHERE customer_id=$1 AND product_id=$2',
        [customer, renewal.id],
      )
    )[0].expires_at;
    assert.equal(expiry.getTime() - baseline.getTime(), 60 * 86400000);
    pass(
      'two concurrent paid renewals add exactly two fixed 30-day snapshots despite later catalog edits',
    );

    const transient = await product('DIGITAL', '7');
    const retry = await checkout([[transient]]);
    await control(retry.items[0], 'TRANSIENT', false, 1);
    await pay(retry);
    await until(
      async () => (await api(`/orders/${retry.id}`)).body.items[0].status === 'RETRY_WAIT',
      'scheduled transient retry',
    );
    assert.equal(
      (
        await db('commerce', 'SELECT item_id FROM digital_grants WHERE item_id=$1', [
          retry.items[0].id,
        ])
      ).length,
      0,
    );
    assert.equal(
      (
        await db(
          'commerce',
          'SELECT product_id FROM digital_entitlements WHERE customer_id=$1 AND product_id=$2',
          [retry.customerId, transient.id],
        )
      ).length,
      0,
    );
    const due = (
      await db(
        'commerce',
        'SELECT extract(epoch FROM(next_attempt_at-clock_timestamp())) AS seconds FROM order_items WHERE id=$1',
        [retry.items[0].id],
      )
    )[0].seconds;
    assert.ok(Number(due) > 8 && Number(due) <= 12);
    await final(retry, 'COMPLETED');
    assert.equal(
      (
        await db('commerce', 'SELECT attempt_count FROM order_items WHERE id=$1', [
          retry.items[0].id,
        ])
      )[0].attempt_count,
      2,
    );
    pass(
      'failed local effect rolls back grant/entitlement and retries after a real increasing SQL timer, then succeeds once',
    );

    const keep = await product('DIGITAL'),
      missing = await product('PHYSICAL');
    const mixed = await checkout([[keep], [missing]]);
    const missingItem = mixed.items.find((i) => i.type === 'PHYSICAL');
    await control(missingItem, 'SUCCESS', true);
    await pay(mixed);
    await until(
      async () =>
        (await api(`/orders/${mixed.id}`)).body.items.find((i) => i.type === 'DIGITAL').status ===
        'SUCCEEDED',
      'successful line retained',
    );
    const inv = (await api(`/admin/products/${missing.id}`, admin)).body.stock;
    assert.equal(
      (
        await api(
          `/admin/inventory/${missing.id}/reconcile`,
          admin,
          'POST',
          {
            expectedVersion: inv.version,
            countedOnHand: 0,
            reason: 'Confirmed warehouse count mistake',
          },
          randomUUID(),
        )
      ).status,
      201,
    );
    await unpause(mixed);
    await final(mixed, 'MANUAL_REVIEW');
    assert.equal(
      (
        await db('commerce', 'SELECT attempt_count FROM order_items WHERE id=$1', [missingItem.id])
      )[0].attempt_count,
      0,
    );
    const path = `/admin/orders/${mixed.id}/items/${missingItem.id}/shortage`,
      body = {
        expectedGeneration: 0,
        reason: 'Warehouse confirmed this whole line does not exist',
      },
      key = randomUUID();
    assert.equal((await api(path, a, 'POST', body, key)).status, 403);
    assert.equal(
      (await api(path, admin, 'POST', { ...body, expectedGeneration: 1 }, randomUUID())).status,
      409,
    );
    const disposition = await binding(async () => {
      const r = await api(path, admin, 'POST', body, key);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await db(
        'bank',
        "INSERT INTO bank_refund_simulation_assignments(operation_key,outcome) VALUES($1,'TIMEOUT_AFTER')",
        [`refund:${r.body.dispositionId}`],
      );
      return r.body;
    });
    assert.equal(
      (await api(path, admin, 'POST', body, key)).body.dispositionId,
      disposition.dispositionId,
    );
    assert.equal(
      (await api(path, admin, 'POST', { ...body, reason: 'Changed reason conflict' }, key)).status,
      409,
    );
    await until(
      async () =>
        (
          await db(
            'billing',
            "SELECT id FROM refunds WHERE disposition_id=$1 AND status='UNKNOWN' AND lease_token IS NULL",
            [disposition.dispositionId],
          )
        ).length,
      'lost refund response',
    );
    await db(
      'billing',
      "UPDATE refunds SET next_reconcile_at=clock_timestamp()+interval '1 hour' WHERE disposition_id=$1",
      [disposition.dispositionId],
    );
    await until(
      async () => (await api(`/orders/${mixed.id}/refunds`)).body.items[0]?.status === 'UNKNOWN',
      'projected unknown refund',
    );
    const unknown = (await api(`/orders/${mixed.id}`)).body;
    assert.equal(unknown.financial.refundedMinor, '0');
    assert.equal(unknown.financial.pendingRefundMinor, '50');
    assert.equal(unknown.financial.summary, 'NONE');
    await db(
      'billing',
      'UPDATE refunds SET next_reconcile_at=clock_timestamp() WHERE disposition_id=$1',
      [disposition.dispositionId],
    );
    const partial = await final(mixed, 'RESOLVED');
    assert.equal(partial.totalMinor, '100');
    assert.equal(partial.financial.refundedMinor, '50');
    assert.equal(partial.financial.summary, 'PARTIALLY_REFUNDED');
    assert.equal(partial.financial.pendingRefundMinor, '0');
    assert.equal(partial.fulfillment.digitalGrants.length, 1);
    assert.equal(partial.fulfillment.shipments.length, 0);
    assert.equal((await api(`/admin/products/${missing.id}`, admin)).body.stock.available, '0');
    assert.equal((await api(`/orders/${mixed.id}/refunds`, b)).status, 404);
    const logs = (
      await api(`/orders/${mixed.id}/refunds/${disposition.dispositionId}/logs?limit=1`)
    ).body;
    assert.equal(logs.items.length, 1);
    assert.ok(logs.nextCursor);
    const nextLogs = (
      await api(
        `/orders/${mixed.id}/refunds/${disposition.dispositionId}/logs?limit=1&cursor=${logs.nextCursor}`,
      )
    ).body;
    assert.notEqual(logs.items[0].id, nextLogs.items[0].id);
    pass(
      'admin shortage keeps successful 50, refunds failed 50 of 100 once, retains logs and never relists nonexistent stock; UNKNOWN is not returned money',
    );

    const command = (
      await db(
        'commerce',
        "SELECT * FROM outbox WHERE aggregate_id=$1 AND kind='RefundRequested'",
        [disposition.dispositionId],
      )
    )[0];
    await publish('commerce', command);
    const invalid = await publish('commerce', command, {
      payload: { ...command.payload, amountMinor: '49' },
    });
    await until(
      async () =>
        (
          await db(
            'billing',
            "SELECT message_id FROM inbox_messages WHERE message_id=$1 AND status='QUARANTINED'",
            [invalid],
          )
        ).length,
      'wrong amount quarantined',
    );
    const statuses = await db(
      'billing',
      "SELECT * FROM outbox WHERE aggregate_id=$1 AND kind='RefundStatusChanged' ORDER BY generation DESC",
      [disposition.dispositionId],
    );
    for (const row of statuses) await publish('billing', row);
    await pause(1000);
    assert.equal((await api(`/orders/${mixed.id}`)).body.financial.refundedMinor, '50');
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_refunds WHERE charge_key=$1', [
          partial.paymentOperationKey,
        ])
      ).length,
      1,
    );
    pass(
      'duplicate/refordered refund commands/results preserve one operation, monetary totals and append-only history; changed amounts are quarantined',
    );

    const p1 = await product('PHYSICAL'),
      p2 = await product('PHYSICAL');
    const full = await checkout([[p1], [p2]]);
    for (const item of full.items) await control(item, 'PERMANENT');
    await pay(full);
    const refunded = await final(full, 'RESOLVED');
    assert.equal(refunded.financial.summary, 'REFUNDED');
    assert.equal(refunded.financial.refundedMinor, '100');
    assert.equal(refunded.fulfillment.shipments.length, 0);
    assert.ok(refunded.items.every((i) => i.status === 'FAILED'));
    assert.equal((await api(`/admin/products/${p1.id}`, admin)).body.stock.available, '10');
    assert.equal((await api(`/admin/products/${p2.id}`, admin)).body.stock.available, '10');
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_refunds WHERE charge_key=$1', [
          refunded.paymentOperationKey,
        ])
      ).length,
      2,
    );
    pass(
      'two concurrent whole-line obligations return exactly captured 100, roll back shipments and settle as RESOLVED rather than COMPLETED',
    );

    const zero = await product('DIGITAL', '0');
    const free = await checkout([[zero]]);
    await control(free.items[0], 'PERMANENT');
    await pay(free);
    const z = await final(free, 'RESOLVED');
    assert.equal(z.financial.refundedMinor, '0');
    assert.equal(z.financial.summary, 'NONE');
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_refunds WHERE charge_key=$1', [
          z.paymentOperationKey,
        ])
      ).length,
      0,
    );
    pass('zero-price failed line settles without inventing a bank return');

    const delayedProduct = await product('DIGITAL', '11');
    const delayed = await checkout([[delayedProduct]]);
    await control(delayed.items[0], 'PERMANENT', true);
    await pay(delayed);
    await binding(async () => {
      await unpause(delayed);
      const d = await until(
        async () =>
          (
            await db('commerce', 'SELECT id FROM item_refund_dispositions WHERE order_id=$1', [
              delayed.id,
            ])
          )[0],
        'pending refund fixture',
      );
      await db(
        'bank',
        "INSERT INTO bank_refund_simulation_assignments(operation_key,outcome,fault_count) VALUES($1,'TIMEOUT_BEFORE',1)",
        [`refund:${d.id}`],
      );
    });
    const delayedDone = await final(delayed, 'RESOLVED');
    assert.equal(delayedDone.financial.refundedMinor, '11');
    const bankRetry = (
      await db('bank', 'SELECT attempt_count,status FROM bank_refunds WHERE charge_key=$1', [
        delayedDone.paymentOperationKey,
      ])
    )[0];
    assert.equal(bankRetry.status, 'SUCCEEDED');
    assert.equal(bankRetry.attempt_count, 2);
    pass(
      'timeout before returning money retries the original pending refund key and confirms one return',
    );

    const reviewProduct = await product('DIGITAL', '17');
    const review = await checkout([[reviewProduct]]);
    await control(review.items[0], 'PERMANENT', true);
    await pay(review);
    const reviewId = await binding(async () => {
      await unpause(review);
      const d = await until(
        async () =>
          (
            await db('commerce', 'SELECT id FROM item_refund_dispositions WHERE order_id=$1', [
              review.id,
            ])
          )[0],
        'declined refund fixture',
      );
      await db(
        'bank',
        "INSERT INTO bank_refund_simulation_assignments(operation_key,outcome) VALUES($1,'FAIL')",
        [`refund:${d.id}`],
      );
      return d.id;
    });
    await until(
      async () =>
        (await api(`/orders/${review.id}/refunds`)).body.items[0]?.status === 'REVIEW_REQUIRED',
      'provider decline visible',
    );
    const held = (await api(`/orders/${review.id}`)).body;
    assert.equal(held.financial.refundedMinor, '0');
    assert.equal(held.financial.pendingRefundMinor, '17');
    assert.equal(
      (
        await db('commerce', 'SELECT released_at FROM admission_slots WHERE order_id=$1', [
          review.id,
        ])
      )[0].released_at,
      null,
    );
    assert.equal(
      (
        await db(
          'commerce',
          "SELECT id FROM review_cases WHERE resource_id=$1 AND reason='REFUND_REQUIRES_REVIEW' AND status='OPEN'",
          [reviewId],
        )
      ).length,
      1,
    );
    pass(
      'definitive refund decline remains owed and counted for review; no returned money or completion is fabricated',
    );

    await db('commerce', 'BEGIN');
    try {
      await assert.rejects(
        db('commerce', "UPDATE order_items SET status='SUCCEEDED' WHERE id=$1", [missingItem.id]),
        (error) => error.code === '23514',
      );
    } finally {
      await db('commerce', 'ROLLBACK');
    }
    await db('commerce', 'BEGIN');
    try {
      await assert.rejects(
        db(
          'commerce',
          'INSERT INTO digital_grants(item_id,customer_id,product_id) VALUES($1,$2,$3)',
          [all.items.find((i) => i.type === 'PHYSICAL').id, all.customerId, physical.id],
        ),
        (error) => error.code === '23514',
      );
    } finally {
      await db('commerce', 'ROLLBACK');
    }
    const captured = (await db('billing', 'SELECT id FROM payments WHERE order_id=$1', [all.id]))[0]
      .id;
    await db('billing', 'BEGIN');
    try {
      await db(
        'billing',
        'INSERT INTO payment_lines(payment_id,item_id,amount_minor) VALUES($1,$2,1)',
        [captured, randomUUID()],
      );
      await assert.rejects(
        db('billing', 'SET CONSTRAINTS ALL IMMEDIATE'),
        (error) => error.code === '23514',
      );
    } finally {
      await db('billing', 'ROLLBACK');
    }
    const over = await fetch('http://bank-simulator:3000/internal/refunds', {
      method: 'POST',
      headers: { authorization: `Bearer ${billing}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        operationKey: `refund:${randomUUID()}`,
        chargeKey: completed.paymentOperationKey,
        amountMinor: (BigInt(completed.totalMinor) + 1n).toString(),
        currency: 'IRR',
      }),
    });
    assert.equal(over.status, 409);
    const denied = await fetch('http://bank-simulator:3000/internal/refunds', {
      method: 'POST',
      headers: { authorization: `Bearer ${a}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    const large = '1'.repeat(60000);
    const largeA = await product('DIGITAL', large),
      largeB = await product('DIGITAL', large);
    const used = (await db('commerce', 'SELECT used FROM admission_budget WHERE id=1'))[0].used;
    const largeKey = randomUUID();
    const oversized = await api(
      '/orders',
      a,
      'POST',
      {
        items: [
          { productId: largeA.id, quantity: 1 },
          { productId: largeB.id, quantity: 1 },
        ],
      },
      largeKey,
    );
    assert.equal(oversized.status, 413);
    assert.equal(
      (
        await db(
          'commerce',
          "SELECT id FROM idempotency_records WHERE operation='order:create' AND key=$1",
          [largeKey],
        )
      ).length,
      0,
    );
    assert.equal(
      (await db('commerce', 'SELECT used FROM admission_budget WHERE id=1'))[0].used,
      used,
    );
    const single = await checkout([[largeA]]);
    assert.equal(single.totalMinor, large);
    await db(
      'commerce',
      "UPDATE orders SET checkout_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [single.id],
    );
    await final(single, 'CHECKOUT_EXPIRED');
    pass(
      'computed oversized snapshots reject before acceptance without a leaked key/slot; a 60000-digit single-line IRR value remains exact',
    );
    await db('commerce', 'BEGIN');
    try {
      await assert.rejects(
        db('commerce', 'UPDATE orders SET cancellation_requested=true WHERE id=$1', [all.id]),
        (error) => error.code === '23514',
      );
    } finally {
      await db('commerce', 'ROLLBACK');
    }
    const cancelledProduct = await product('DIGITAL', '9');
    const cancelledOrder = await checkout([[cancelledProduct]]);
    await control(cancelledOrder.items[0], 'SUCCESS', true);
    await pay(cancelledOrder);
    assert.equal(
      (
        await db(
          'commerce',
          "UPDATE orders SET cancellation_requested=true,status='CANCELLATION_PENDING' WHERE id=$1 AND fulfillment_started_at IS NULL RETURNING id",
          [cancelledOrder.id],
        )
      ).length,
      1,
    );
    await unpause(cancelledOrder);
    const stopped = await final(cancelledOrder, 'CANCELLED');
    assert.equal(stopped.fulfillment.digitalGrants.length, 0);
    assert.equal(stopped.financial.refundedMinor, '9');
    pass(
      'parent-serialized cancellation wins before first start and refunds; SQL rejects intent after fulfillment has crossed its immutable cutoff',
    );
    pass(
      'SQL rejects refunded-item success, wrong typed effects and invalid captured-line totals; Bank rejects excess budgets and customer callers',
    );
  }
} finally {
  for (const id of products) {
    const p = await api(`/admin/products/${id}`, admin);
    if (p.status === 200 && p.body.active)
      await api(
        `/admin/products/${id}/deactivate`,
        admin,
        'POST',
        {
          expectedVersion: p.body.version,
          reason: 'Fulfillment fixture complete; retain evidence',
        },
        randomUUID(),
      );
  }
  await Promise.all([...clients.values()].map((c) => c.end()));
}
