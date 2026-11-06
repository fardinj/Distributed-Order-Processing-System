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
const [a, b, admin, billingToken, commerceToken] = await Promise.all([
  token('fixture-customer-a', 'fixture_customer_a'),
  token('fixture-customer-b', 'fixture_customer_b'),
  token('fixture-admin', 'fixture_admin'),
  token('billing-service', 'billing_service'),
  token('commerce-service', 'commerce_service'),
]);
async function http(url, bearer, method = 'GET', body, key) {
  const r = await fetch(url, {
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
const api = (path, bearer = a, method = 'GET', body, key) =>
  http(`http://gateway:3000/api${path}`, bearer, method, body, key);
const bank = (path, method = 'GET', body, bearer = billingToken) =>
  http(`http://bank-simulator:3000/internal/charges${path}`, bearer, method, body);
const clients = new Map();
async function db(owner, sql, values = []) {
  if (!clients.has(owner)) {
    const client = new Client({
      host: 'postgres',
      database: owner,
      user: `${owner}_migrator`,
      password: await secret(`${owner}_migration`),
      connectionTimeoutMillis: 2000,
    });
    await client.connect();
    clients.set(owner, client);
  }
  return (await clients.get(owner).query(sql, values)).rows;
}
async function until(work, message, timeout = 35000) {
  const end = Date.now() + timeout;
  do {
    const value = await work();
    if (value) return value;
    await pause(250);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${message}`);
}
const products = [];
const unpaid = [];
const amount = '123456789012345678901234567890123456789012345678901234567890';
async function product(quantity = 10) {
  const r = await api(
    '/admin/products',
    admin,
    'POST',
    {
      name: `Payment test ${randomUUID()}`,
      type: 'PHYSICAL',
      priceMinor: amount,
      reason: 'Step 4 test product',
    },
    randomUUID(),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  products.push(r.body.id);
  const stock = await api(
    `/admin/inventory/${r.body.id}/adjustments`,
    admin,
    'POST',
    { expectedVersion: 1, delta: quantity, reason: 'Step 4 stock fixture' },
    randomUUID(),
  );
  assert.equal(stock.status, 201);
  return r.body;
}
async function checkout(p, quantity = 1) {
  const r = await api(
    '/orders',
    a,
    'POST',
    { items: [{ productId: p.id, quantity }] },
    randomUUID(),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  unpaid.push(r.body.id);
  // Step-4 regression inspects allocated/undispatched work. Defer only this fixture's
  // jobs so step-5 processors cannot cross the cancellation cutoff during the check.
  for (const item of r.body.items)
    await db(
      'commerce',
      "INSERT INTO fulfillment_simulation_rules(item_id,not_before) VALUES($1,clock_timestamp()+interval '1 hour')",
      [item.id],
    );
  return r.body;
}
const pay = (o, revision = o.checkoutRevision, bearer = a) =>
  api(`/orders/${o.id}/payment`, bearer, 'POST', { expectedRevision: revision });
async function assignment(o, reference) {
  await db(
    'bank',
    'INSERT INTO bank_simulation_assignments(operation_key,reference) VALUES($1,$2)',
    [`payment:${o.id}`, reference],
  );
}
async function final(o, status) {
  return until(async () => {
    const r = await api(`/orders/${o.id}`);
    return r.body.financial.status === status ? r.body : undefined;
  }, `Commerce ${status}`);
}
async function due(o) {
  await db('billing', 'UPDATE payments SET next_reconcile_at=clock_timestamp() WHERE order_id=$1', [
    o.id,
  ]);
}
async function expire(o) {
  await db(
    'commerce',
    "UPDATE orders SET checkout_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND status IN ('CHECKOUT_RESERVED','BASKET_CHANGED','PAYING','PAYMENT_REVIEW')",
    [o.id],
  );
  await db(
    'commerce',
    "UPDATE reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE status='ACTIVE' AND item_id IN(SELECT id FROM order_items WHERE order_id=$1)",
    [o.id],
  );
}
async function nearDeadline(o, seconds = 0) {
  await db(
    'bank',
    `WITH t AS(SELECT clock_timestamp()-interval '15 minutes'+$3*interval '1 second' AS at)
 INSERT INTO bank_operations(operation_key,amount_minor,status,initiated_at,deadline_at,simulation_outcome)
 SELECT $1,$2::numeric,'PENDING',at,at+interval '15 minutes','TIMEOUT_BEFORE' FROM t`,
    [`payment:${o.id}`, o.totalMinor, seconds],
  );
}
async function publish(owner, envelope) {
  const c = await connect(
    `amqp://${owner}:${encodeURIComponent(await secret(`${owner}_rabbitmq`))}@rabbitmq:5672/tops`,
  );
  c.on('error', () => {});
  const ch = await c.createConfirmChannel();
  ch.on('error', () => {});
  try {
    await new Promise((resolve, reject) =>
      ch.publish(
        `${owner}.events`,
        envelope.kind,
        Buffer.from(JSON.stringify(envelope)),
        { persistent: true, mandatory: true, messageId: envelope.id },
        (e) => (e ? reject(e) : resolve()),
      ),
    );
  } finally {
    await c.close();
  }
}
function envelope(owner, row) {
  return {
    schemaVersion: 1,
    id: row.id,
    producer: owner,
    kind: row.kind,
    aggregateId: row.aggregate_id,
    generation: row.generation,
    correlationId: row.payload.correlationId,
    payload: row.payload,
  };
}
async function cancelIntent(o) {
  await db('commerce', 'BEGIN');
  try {
    await db('commerce', 'SELECT id FROM orders WHERE id=$1 FOR UPDATE', [o.id]);
    await db(
      'commerce',
      "UPDATE orders SET cancellation_requested=true,status='CANCELLATION_PENDING' WHERE id=$1",
      [o.id],
    );
    const command = (
      await db(
        'commerce',
        "SELECT payload FROM outbox WHERE aggregate_id=$1 AND kind='PaymentRequested'",
        [o.id],
      )
    )[0].payload;
    await db(
      'commerce',
      "INSERT INTO outbox(id,kind,aggregate_id,generation,payload) VALUES($1,'PaymentCancellationRequested',$2,$3,$4::jsonb)",
      [randomUUID(), o.id, command.revision, JSON.stringify(command)],
    );
    await db('commerce', 'COMMIT');
  } catch (e) {
    await db('commerce', 'ROLLBACK');
    throw e;
  }
}
const phase = process.argv[2] ?? 'main';
try {
  if (phase === 'bank-outage-create' || phase === 'broker-outage-create') {
    const p = await product();
    const o = await checkout(p, 2);
    assert.equal((await pay(o)).status, 201);
    if (phase === 'bank-outage-create') {
      await final(o, 'UNKNOWN');
      const row = (
        await db('billing', 'SELECT next_reconcile_at,status FROM payments WHERE order_id=$1', [
          o.id,
        ])
      )[0];
      assert.equal(row.status, 'UNKNOWN');
      assert.ok(row.next_reconcile_at);
    } else {
      assert.equal(
        (await db('billing', 'SELECT id FROM payments WHERE order_id=$1', [o.id])).length,
        0,
      );
    }
    const pending = (await api(`/orders/${o.id}`)).body;
    assert.equal(pending.reservations[0].status, 'PAYMENT_PENDING');
    await expire(o);
    await pause(1200);
    assert.equal((await api(`/orders/${o.id}`)).body.reservations[0].status, 'PAYMENT_PENDING');
    await writeFile(
      `/verification/${phase}.json`,
      JSON.stringify({ orderId: o.id, productId: p.id }),
    );
    pass(`${phase}: accepted payment keeps stock and durable recovery, never guesses failure`);
  } else if (phase === 'bank-outage-recover' || phase === 'broker-outage-recover') {
    const state = JSON.parse(
      await readFile(`/verification/${phase.replace('recover', 'create')}.json`, 'utf8'),
    );
    products.push(state.productId);
    unpaid.push(state.orderId);
    if (phase === 'bank-outage-recover')
      await until(
        async () =>
          (await db('billing', 'SELECT id FROM payments WHERE order_id=$1', [state.orderId]))
            .length,
        'payment command arrives',
      );
    await due({ id: state.orderId });
    const o = await final({ id: state.orderId }, 'SUCCEEDED');
    assert.equal(o.reservations[0].status, 'ALLOCATED');
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_operations WHERE operation_key=$1', [
          `payment:${state.orderId}`,
        ])
      ).length,
      1,
    );
    assert.equal(
      (
        await db(
          'commerce',
          'SELECT j.item_id FROM fulfillment_jobs j JOIN order_items i ON i.id=j.item_id WHERE i.order_id=$1',
          [state.orderId],
        )
      ).length,
      1,
    );
    pass(`${phase}: owner restarts recover one charge/result/allocation/fulfillment job`);
  } else {
    const p = await product(20);
    const o = await checkout(p, 2);
    assert.equal((await pay(o, 1, b)).status, 404);
    assert.equal(
      (await api(`/orders/${o.id}/payment`, a, 'POST', { expectedRevision: 1, amountMinor: '1' }))
        .status,
      400,
    );
    assert.equal(
      (
        await bank(
          '/init',
          'POST',
          { operationKey: `payment:${randomUUID()}`, amountMinor: '1', currency: 'IRR' },
          a,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await bank(
          '/init',
          'POST',
          { operationKey: `payment:${randomUUID()}`, amountMinor: '1', currency: 'IRR' },
          commerceToken,
        )
      ).status,
      403,
    );
    assert.equal(
      (await http('http://gateway:3000/api/internal/charges/init', billingToken, 'POST', {}))
        .status,
      404,
    );
    const replies = await Promise.all(Array.from({ length: 20 }, () => pay(o)));
    assert.ok(
      replies.every((r) => r.status === 201),
      JSON.stringify(replies.filter((r) => r.status !== 201)),
    );
    const paid = await final(o, 'SUCCEEDED');
    assert.equal(paid.status, 'PROCESSING');
    assert.equal(paid.reservations[0].status, 'ALLOCATED');
    assert.equal(paid.reservations[0].expiresAt, null);
    assert.equal(paid.financial.pending, false);
    assert.equal(
      (
        await db('billing', 'SELECT amount_minor::text AS amount FROM payments WHERE order_id=$1', [
          o.id,
        ])
      )[0].amount,
      (BigInt(amount) * 2n).toString(),
    );
    assert.equal(
      (
        await db(
          'bank',
          'SELECT amount_minor::text AS amount FROM bank_operations WHERE operation_key=$1',
          [paid.paymentOperationKey],
        )
      )[0].amount,
      paid.totalMinor,
    );
    assert.equal(
      (
        await db(
          'commerce',
          'SELECT j.item_id FROM fulfillment_jobs j JOIN order_items i ON i.id=j.item_id WHERE i.order_id=$1',
          [o.id],
        )
      ).length,
      1,
    );
    assert.equal((await api(`/admin/products/${p.id}`, admin)).body.stock.available, '18');
    assert.equal(
      (
        await bank('/init', 'POST', {
          operationKey: paid.paymentOperationKey,
          amountMinor: '1',
          currency: 'IRR',
        })
      ).status,
      409,
    );
    assert.equal((await pay(o)).body.paymentOperationKey, paid.paymentOperationKey);
    pass(
      'authenticated concurrent payment entry creates one exact-IRR charge, allocated stock and one durable fulfillment job',
    );

    const decline = await checkout(p);
    await assignment(decline, 'FAIL');
    assert.equal((await pay(decline)).status, 201);
    const failed = await final(decline, 'FAILED');
    assert.equal(failed.status, 'PAYMENT_FAILED');
    assert.equal(failed.reservations.length, 0);
    assert.equal((await api(`/admin/products/${p.id}`, admin)).body.stock.available, '18');
    assert.equal(
      (
        await db('commerce', 'SELECT released_at FROM admission_slots WHERE order_id=$1', [
          decline.id,
        ])
      )[0].released_at instanceof Date,
      true,
    );
    const bankCount = (
      await db('bank', 'SELECT operation_key FROM bank_operations WHERE operation_key=$1', [
        `payment:${decline.id}`,
      ])
    ).length;
    await pay(decline);
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_operations WHERE operation_key=$1', [
          `payment:${decline.id}`,
        ])
      ).length,
      bankCount,
    );
    pass(
      'definitive decline releases stock/slot once; repeated entry never creates a replacement charge',
    );

    const lost = await checkout(p);
    await assignment(lost, 'TIMEOUT_AFTER');
    await pay(lost);
    await final(lost, 'UNKNOWN');
    assert.equal(
      (
        await db('bank', 'SELECT status FROM bank_operations WHERE operation_key=$1', [
          `payment:${lost.id}`,
        ])
      )[0].status,
      'SUCCEEDED',
    );
    await due(lost);
    const recovered = await final(lost, 'SUCCEEDED');
    assert.equal(recovered.reservations[0].status, 'ALLOCATED');
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_operations WHERE operation_key=$1', [
          `payment:${lost.id}`,
        ])
      ).length,
      1,
    );
    pass(
      'timeout after successful charge projects UNKNOWN, then reconciles the original success without charging twice',
    );

    const pending = await checkout(p);
    await assignment(pending, 'TIMEOUT_BEFORE');
    await pay(pending);
    await final(pending, 'UNKNOWN');
    await expire(pending);
    await pause(1200);
    assert.equal(
      (await api(`/orders/${pending.id}`)).body.reservations[0].status,
      'PAYMENT_PENDING',
    );
    let previous = 0;
    for (let index = 0; index < 4; index++) {
      const before = (
        await db('billing', 'SELECT lookup_count FROM payments WHERE order_id=$1', [pending.id])
      )[0].lookup_count;
      await due(pending);
      const row = await until(async () => {
        const r = (
          await db(
            'billing',
            `SELECT lookup_count,lease_token,status,extract(epoch FROM(next_reconcile_at-clock_timestamp())) AS delay FROM payments WHERE order_id=$1`,
            [pending.id],
          )
        )[0];
        return r.lookup_count > before && !r.lease_token ? r : undefined;
      }, 'next scheduled lookup');
      assert.equal(row.status, 'UNKNOWN');
      assert.ok(Number(row.delay) > previous);
      previous = Number(row.delay);
    }
    assert.ok(
      (await db('billing', 'SELECT lookup_count FROM payments WHERE order_id=$1', [pending.id]))[0]
        .lookup_count >= 5,
    );
    assert.equal(
      (await api(`/orders/${pending.id}`)).body.reservations[0].status,
      'PAYMENT_PENDING',
    );
    pass(
      'unknown payment retains stock beyond checkout timer and retries more than three times with increasing durable delay',
    );
    const beforeLease = (
      await db('billing', 'SELECT lookup_count FROM payments WHERE order_id=$1', [pending.id])
    )[0].lookup_count;
    await db(
      'billing',
      "UPDATE payments SET lease_token=$2,lease_until=clock_timestamp()+interval '2 seconds',next_reconcile_at=clock_timestamp() WHERE order_id=$1",
      [pending.id, randomUUID()],
    );
    await pause(700);
    assert.equal(
      (await db('billing', 'SELECT lookup_count FROM payments WHERE order_id=$1', [pending.id]))[0]
        .lookup_count,
      beforeLease,
    );
    await until(async () => {
      const row = (
        await db('billing', 'SELECT lookup_count,lease_token FROM payments WHERE order_id=$1', [
          pending.id,
        ])
      )[0];
      return row.lookup_count > beforeLease && !row.lease_token;
    }, 'abandoned payment claim recovery');
    pass(
      'unexpired payment claim prevents overlap; expired claim recovers using the same bank operation',
    );

    const expiring = await checkout(p);
    await nearDeadline(expiring, 2);
    await pay(expiring);
    const expired = await final(expiring, 'FAILED');
    assert.equal(expired.status, 'PAYMENT_FAILED');
    const times = (
      await db(
        'bank',
        'SELECT extract(epoch FROM(deadline_at-initiated_at)) AS seconds,status FROM bank_operations WHERE operation_key=$1',
        [`payment:${expiring.id}`],
      )
    )[0];
    assert.equal(Number(times.seconds), 900);
    assert.equal(times.status, 'FAILED');
    assert.equal(
      (await bank(`/${encodeURIComponent(`payment:${expiring.id}`)}/execute`, 'POST')).body.status,
      'FAILED',
    );
    const durableSuccessKey = `payment:${randomUUID()}`;
    await db(
      'bank',
      `WITH t AS(SELECT clock_timestamp()-interval '16 minutes' AS at) INSERT INTO bank_operations(operation_key,amount_minor,status,reference,initiated_at,deadline_at)
    SELECT $1,1,'SUCCEEDED','deadline-success-fixture',at,at+interval '15 minutes' FROM t`,
      [durableSuccessKey],
    );
    assert.equal(
      (await bank(`/${encodeURIComponent(durableSuccessKey)}`)).body.status,
      'SUCCEEDED',
    );
    pass(
      'bank-owned deadline is exactly 900 seconds; due pending fails, cannot later charge, and committed success stays successful',
    );

    const changedProduct = await product(2);
    const changed = await checkout(changedProduct, 2);
    await expire(changed);
    await until(
      async () => (await api(`/orders/${changed.id}`)).body.status === 'CHECKOUT_EXPIRED',
      'checkout expiry',
    );
    const stock = (await api(`/admin/products/${changedProduct.id}`, admin)).body.stock;
    assert.equal(
      (
        await api(
          `/admin/inventory/${changedProduct.id}/adjustments`,
          admin,
          'POST',
          {
            expectedVersion: stock.version,
            delta: -1,
            reason: 'Expired payment entry stock changed',
          },
          randomUUID(),
        )
      ).status,
      201,
    );
    const basket = await pay(changed);
    assert.equal(basket.body.status, 'BASKET_CHANGED');
    assert.equal(basket.body.checkoutRevision, 2);
    assert.equal(basket.body.checkout.confirmed, false);
    assert.equal(
      (
        await db(
          'commerce',
          "SELECT id FROM outbox WHERE aggregate_id=$1 AND kind='PaymentRequested'",
          [changed.id],
        )
      ).length,
      0,
    );
    assert.equal(
      (await api(`/orders/${changed.id}/checkout/confirm`, a, 'POST', { expectedRevision: 2 }))
        .status,
      201,
    );
    assert.equal((await pay(changed, 1)).status, 409);
    assert.equal((await pay(changed, 2)).status, 201);
    await final(changed, 'SUCCEEDED');
    const unchanged = await checkout(p);
    await expire(unchanged);
    await until(
      async () => (await api(`/orders/${unchanged.id}`)).body.status === 'CHECKOUT_EXPIRED',
      'unchanged checkout expiry',
    );
    const resumed = await pay(unchanged);
    assert.equal(resumed.status, 201);
    assert.equal(resumed.body.checkoutRevision, 2);
    assert.equal((await pay(unchanged, 1)).status, 201);
    await final(unchanged, 'SUCCEEDED');
    pass(
      'expired gateway entry atomically reacquires stock; changed revision requires confirmation, unchanged revision proceeds under one stable key',
    );

    const original = (
      await db(
        'billing',
        "SELECT * FROM outbox WHERE aggregate_id=$1 AND kind='PaymentStatusChanged' AND payload->>'status'='SUCCEEDED' ORDER BY generation DESC LIMIT 1",
        [o.id],
      )
    )[0];
    await publish('billing', envelope('billing', original));
    const stale = {
      ...envelope('billing', original),
      id: randomUUID(),
      generation: 1,
      payload: { ...original.payload, sourceVersion: 1, status: 'PENDING', bankReference: null },
    };
    await publish('billing', stale);
    const forged = {
      ...envelope('billing', original),
      id: randomUUID(),
      generation: original.generation + 100,
      payload: { ...original.payload, sourceVersion: original.generation + 100, amountMinor: '1' },
    };
    await publish('billing', forged);
    await until(
      async () =>
        (
          await db(
            'commerce',
            "SELECT message_id FROM inbox_messages WHERE message_id=$1 AND status='QUARANTINED'",
            [forged.id],
          )
        ).length,
      'mismatched payment result quarantined',
    );
    assert.equal((await api(`/orders/${o.id}`)).body.financial.status, 'SUCCEEDED');
    assert.equal(
      (
        await db(
          'commerce',
          'SELECT j.item_id FROM fulfillment_jobs j JOIN order_items i ON i.id=j.item_id WHERE i.order_id=$1',
          [o.id],
        )
      ).length,
      1,
    );
    pass(
      'duplicate/stale results do not regress paid stock or duplicate jobs; wrong monetary identity is quarantined',
    );

    const early = await checkout(p);
    const connection = await connect(
      `amqp://billing:${encodeURIComponent(await secret('billing_rabbitmq'))}@rabbitmq:5672/tops`,
    );
    connection.on('error', () => {});
    const ch = await connection.createChannel();
    ch.on('error', () => {});
    try {
      await ch.unbindQueue('billing.q.events', 'commerce.events', '#');
      await pay(early);
      await db(
        'commerce',
        "UPDATE outbox SET claim_token=$2,lease_until=clock_timestamp()+interval '1 hour',available_at=clock_timestamp()+interval '1 hour' WHERE aggregate_id=$1 AND kind='PaymentRequested'",
        [early.id, randomUUID()],
      );
      await cancelIntent(early);
    } finally {
      await ch.bindQueue('billing.q.events', 'commerce.events', '#');
      await connection.close();
    }
    await until(
      async () => (await api(`/orders/${early.id}`)).body.status === 'CANCELLED',
      'no-charge cancellation acknowledgment',
    );
    assert.equal(
      (
        await db(
          'bank',
          'SELECT operation_key FROM bank_charge_cancellations WHERE operation_key=$1',
          [`payment:${early.id}`],
        )
      ).length,
      1,
    );
    await db(
      'commerce',
      "UPDATE outbox SET claim_token=NULL,lease_until=NULL,available_at=clock_timestamp() WHERE aggregate_id=$1 AND kind='PaymentRequested'",
      [early.id],
    );
    await until(
      async () =>
        (
          await db(
            'commerce',
            "SELECT published_at FROM outbox WHERE aggregate_id=$1 AND kind='PaymentRequested'",
            [early.id],
          )
        )[0].published_at,
      'delayed original command delivered',
    );
    await pause(1000);
    assert.equal(
      (await db('billing', 'SELECT status FROM payments WHERE order_id=$1', [early.id]))[0].status,
      'FAILED',
    );
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_operations WHERE operation_key=$1', [
          `payment:${early.id}`,
        ])
      ).length,
      0,
    );
    pass(
      'cancellation before original command durably fences bank initialization, releases once, and delayed payment stays a no-op',
    );
    const cancelledInit = await bank('/init', 'POST', {
      operationKey: `payment:${early.id}`,
      amountMinor: early.totalMinor,
      currency: 'IRR',
    });
    assert.equal(cancelledInit.body.status, 'FAILED');
    assert.equal(
      (await bank(`/${encodeURIComponent(`payment:${early.id}`)}/execute`, 'POST')).body.status,
      'FAILED',
    );

    await cancelIntent(pending);
    await due(pending);
    await until(
      async () => (await api(`/orders/${pending.id}`)).body.status === 'CANCELLED',
      'unknown no-charge cancellation',
    );
    await cancelIntent(o);
    await due(o);
    await until(
      async () =>
        ['CANCELLATION_PENDING', 'CANCELLED'].includes((await api(`/orders/${o.id}`)).body.status),
      'charged cancellation remains pending',
    );
    await until(
      async () =>
        (
          await db('billing', 'SELECT status FROM payment_cancellations WHERE operation_key=$1', [
            `payment:${o.id}`,
          ])
        )[0]?.status &&
        ['REFUND_REQUIRED', 'RESOLVED'].includes(
          (
            await db('billing', 'SELECT status FROM payment_cancellations WHERE operation_key=$1', [
              `payment:${o.id}`,
            ])
          )[0].status,
        ),
      'charged cancellation authoritative result',
    );
    await until(
      async () =>
        (
          await db('commerce', 'SELECT status FROM fulfillment_jobs WHERE item_id=$1', [
            paid.items[0].id,
          ])
        )[0]?.status === 'CANCELLED',
      'ready fulfillment suppressed',
    );
    assert.equal((await api(`/orders/${o.id}`)).body.financial.status, 'SUCCEEDED');
    const cancelled = (await api(`/orders/${o.id}`)).body;
    if (cancelled.financial.summary === 'REFUNDED') assert.equal(cancelled.reservations.length, 0);
    else assert.equal(cancelled.reservations[0].status, 'ALLOCATED');
    pass(
      'unknown cancellation releases only after bank fence; already charged cancellation preserves success/stock and suppresses ready work for later refund',
    );
  }
} finally {
  for (const id of unpaid) await expire({ id });
  if (phase === 'main' || phase.endsWith('-recover'))
    for (const id of unpaid) {
      await db(
        'commerce',
        'UPDATE fulfillment_simulation_rules SET not_before=clock_timestamp() WHERE item_id IN(SELECT id FROM order_items WHERE order_id=$1)',
        [id],
      );
      await db(
        'commerce',
        "UPDATE fulfillment_jobs SET available_at=clock_timestamp() WHERE item_id IN(SELECT id FROM order_items WHERE order_id=$1) AND status IN ('READY','DEFERRED')",
        [id],
      );
    }
  for (const id of products) {
    const current = await api(`/admin/products/${id}`, admin);
    if (current.status === 200 && current.body.active)
      await api(
        `/admin/products/${id}/deactivate`,
        admin,
        'POST',
        {
          expectedVersion: current.body.version,
          reason: 'Payment fixture completed; preserve ledger evidence',
        },
        randomUUID(),
      );
  }
  await Promise.all([...clients.values()].map((c) => c.end()));
}
