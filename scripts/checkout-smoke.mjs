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
const [a, b, admin] = await Promise.all([
  token('fixture-customer-a', 'fixture_customer_a'),
  token('fixture-customer-b', 'fixture_customer_b'),
  token('fixture-admin', 'fixture_admin'),
]);
let createCounter = 0;
async function api(path, bearer = a, method = 'GET', body, key) {
  const origin =
    process.env.CHECKOUT_SECOND_ORIGIN &&
    path === '/orders' &&
    method === 'POST' &&
    createCounter++ % 2
      ? process.env.CHECKOUT_SECOND_ORIGIN
      : 'http://gateway:3000/api';
  const r = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, body: await r.json(), retryAfter: r.headers.get('retry-after') };
}
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
async function until(work, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await work();
    if (result) return result;
    await pause(250);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${message}`);
}
const products = [];
const orders = new Set();
async function product(type = 'PHYSICAL', quantity = 10) {
  const r = await api(
    '/admin/products',
    admin,
    'POST',
    {
      name: `Checkout check ${randomUUID()}`,
      type,
      priceMinor: '123456789012345678901234567890123456789012345678901234567890',
      reason: 'Step 3 fixture setup',
    },
    randomUUID(),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  products.push(r.body.id);
  if (type === 'PHYSICAL') {
    const stock = await api(
      `/admin/inventory/${r.body.id}/adjustments`,
      admin,
      'POST',
      { delta: quantity, expectedVersion: 1, reason: 'Step 3 test inventory' },
      randomUUID(),
    );
    assert.equal(stock.status, 201, JSON.stringify(stock.body));
  }
  return r.body;
}
async function create(items, key = randomUUID(), bearer = a) {
  const result = await api('/orders', bearer, 'POST', { items }, key);
  if (result.status === 201) orders.add(result.body.id);
  return result;
}
async function expire(ids) {
  if (!ids.length) return;
  await db(
    'commerce',
    `UPDATE orders SET checkout_expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])
    AND status IN ('CHECKOUT_RESERVED','BASKET_CHANGED')`,
    [ids],
  );
  await db(
    'commerce',
    `UPDATE reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE status='ACTIVE'
    AND item_id IN (SELECT id FROM order_items WHERE order_id=ANY($1::uuid[]))`,
    [ids],
  );
  await until(
    async () =>
      !(
        await db(
          'commerce',
          `SELECT order_id FROM admission_slots WHERE order_id=ANY($1::uuid[]) AND released_at IS NULL`,
          [ids],
        )
      ).length,
    'fixture holds expire and capacity released',
  );
}
async function ready(id, revision) {
  return until(async () => {
    const r = await api(`/orders/${id}`);
    return r.body.preparationVersion === revision ? r.body : undefined;
  }, 'preparation acknowledgment');
}
async function cleanup() {
  await expire([...orders]);
  for (const id of products) {
    const current = await api(`/admin/products/${id}`, admin);
    if (current.status === 200 && current.body.active)
      assert.equal(
        (
          await api(
            `/admin/products/${id}/deactivate`,
            admin,
            'POST',
            {
              expectedVersion: current.body.version,
              reason: 'Step 3 fixture completed; retain evidence',
            },
            randomUUID(),
          )
        ).status,
        201,
      );
  }
}
async function broker(owner) {
  const conn = await connect(
    `amqp://${owner}:${encodeURIComponent(await secret(`${owner}_rabbitmq`))}@rabbitmq:5672/tops?heartbeat=10`,
  );
  conn.on('error', () => {});
  const channel = await conn.createConfirmChannel();
  channel.on('error', () => {});
  return { conn, channel };
}
async function publish(channel, kind, envelope) {
  await new Promise((resolve, reject) =>
    channel.publish(
      'commerce.events',
      kind,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        mandatory: true,
        messageId: envelope.id,
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}
const phase = process.argv[2] ?? 'main';
try {
  if (process.env.CHECKOUT_SECOND_ORIGIN)
    await until(async () => {
      try {
        return (
          await fetch(`${process.env.CHECKOUT_SECOND_ORIGIN}/health/live`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        return false;
      }
    }, 'temporary Commerce replica starts');
  if (phase === 'outage-create') {
    const p = await product();
    const key = randomUUID();
    const r = await create([{ productId: p.id, quantity: 2 }], key);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rows = await db(
      'commerce',
      "SELECT published_at FROM outbox WHERE aggregate_id=$1 AND kind='CheckoutPrepared'",
      [r.body.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].published_at, null);
    assert.equal(
      (
        await db('billing', 'SELECT order_id FROM prepared_checkouts WHERE order_id=$1', [
          r.body.id,
        ])
      ).length,
      0,
    );
    await writeFile(
      '/verification/checkout-outage.json',
      JSON.stringify({ id: r.body.id, productId: p.id, key }),
    );
    pass(
      'broker unavailable: checkout accepted once with stock, SQL slot and unpublished durable outbox; no charge',
    );
    // Retain this known fixture across the broker/worker restart for recovery verification.
  } else if (phase === 'outage-recover') {
    const state = JSON.parse(await readFile('/verification/checkout-outage.json', 'utf8'));
    orders.add(state.id);
    products.push(state.productId);
    const current = await ready(state.id, 1);
    const replay = await create([{ productId: state.productId, quantity: 2 }], state.key);
    assert.equal(replay.body.id, state.id);
    assert.equal(replay.body.expiresAt, current.expiresAt);
    assert.equal(
      (
        await db(
          'commerce',
          'SELECT * FROM admission_slots WHERE order_id=$1 AND released_at IS NULL',
          [state.id],
        )
      ).length,
      1,
    );
    assert.equal(
      (await db('billing', 'SELECT id FROM payments WHERE order_id=$1', [state.id])).length,
      0,
    );
    pass(
      'broker restored after owner restart: outbox drains, preparation and replay recover once, no payment created',
    );
    await cleanup();
  } else {
    const p = await product();
    const digital = await product('DIGITAL');
    const key = randomUUID();
    const input = [
      { productId: p.id, quantity: 1 },
      { productId: digital.id, quantity: 1 },
      { productId: p.id, quantity: 1 },
    ];
    const parallel = await Promise.all(Array.from({ length: 50 }, () => create(input, key)));
    assert.ok(
      parallel.every((r) => r.status === 201),
      JSON.stringify(parallel.filter((r) => r.status !== 201)),
    );
    assert.equal(new Set(parallel.map((r) => r.body.id)).size, 1);
    const first = parallel[0].body;
    assert.equal(first.items.length, 2);
    assert.equal(first.totalMinor, (BigInt(p.priceMinor) * 3n).toString());
    assert.equal((await api(`/admin/products/${p.id}`, admin)).body.stock.available, '8');
    const merged = await create(
      [
        { productId: digital.id, quantity: 1 },
        { productId: p.id, quantity: 2 },
      ],
      key,
    );
    assert.equal(merged.body.id, first.id);
    assert.equal(merged.body.expiresAt, first.expiresAt);
    assert.equal((await create([{ productId: p.id, quantity: 3 }], key)).status, 409);
    const other = await create([{ productId: p.id, quantity: 1 }], key, b);
    assert.equal(other.status, 201);
    assert.notEqual(other.body.id, first.id);
    assert.equal((await api(`/orders/${first.id}`, b)).status, 404);
    assert.equal(
      (await api(`/orders/${first.id}/checkout/refresh`, b, 'POST', { expectedRevision: 1 }))
        .status,
      404,
    );
    assert.equal((await api('/orders?limit=101')).status, 400);
    const page = (await api('/orders?limit=1')).body;
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const nextPage = (await api(`/orders?limit=1&cursor=${page.nextCursor}`)).body;
    assert.equal(nextPage.items.length, 1);
    assert.notEqual(page.items[0].id, nextPage.items[0].id);
    pass(
      '50 concurrent canonical replays: one order/slot/hold generation, exact IRR; payload conflict and owner boundaries',
    );

    const countsBefore = (await db('commerce', 'SELECT used FROM admission_budget WHERE id=1'))[0]
      .used;
    assert.equal(
      (
        await create([
          { productId: digital.id, quantity: 1 },
          { productId: digital.id, quantity: 1 },
        ])
      ).status,
      400,
    );
    const badkey = randomUUID();
    assert.equal(
      (
        await create(
          [
            { productId: p.id, quantity: 100 },
            { productId: digital.id, quantity: 1 },
          ],
          badkey,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await db(
          'commerce',
          "SELECT id FROM idempotency_records WHERE operation='order:create' AND key=$1",
          [badkey],
        )
      ).length,
      0,
    );
    assert.equal(
      (await db('commerce', 'SELECT used FROM admission_budget WHERE id=1'))[0].used,
      countsBefore,
    );
    assert.equal(
      (
        await api(
          '/orders',
          a,
          'POST',
          { items: [{ productId: p.id, quantity: 1 }], totalMinor: '1' },
          randomUUID(),
        )
      ).status,
      400,
    );
    const last = await product('PHYSICAL', 1);
    const race = await Promise.all([
      create([{ productId: last.id, quantity: 1 }]),
      create([{ productId: last.id, quantity: 1 }]),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await api(`/admin/products/${last.id}`, admin)).body.stock.available, '0');
    pass(
      'last-unit contention has one winner; invalid/multi-line allocation rolls back key, order and slot',
    );

    await ready(first.id, 1);
    await expire([first.id]);
    assert.equal((await api(`/orders/${first.id}`)).body.status, 'CHECKOUT_EXPIRED');
    const expiredReplay = await create(input, key);
    assert.equal(expiredReplay.body.status, 'CHECKOUT_EXPIRED');
    assert.equal(
      (
        await db('commerce', 'SELECT released_at FROM admission_slots WHERE order_id=$1', [
          first.id,
        ])
      )[0].released_at instanceof Date,
      true,
    );
    const stock = (await api(`/admin/products/${p.id}`, admin)).body.stock;
    assert.equal(
      (
        await api(
          `/admin/inventory/${p.id}/adjustments`,
          admin,
          'POST',
          {
            delta: 1 - Number(stock.available),
            expectedVersion: stock.version,
            reason: 'Force changed stock after expiry',
          },
          randomUUID(),
        )
      ).status,
      201,
    );
    const changed = await api(`/orders/${first.id}/checkout/refresh`, a, 'POST', {
      expectedRevision: 1,
    });
    assert.equal(changed.status, 201, JSON.stringify(changed.body));
    assert.equal(changed.body.status, 'BASKET_CHANGED');
    assert.equal(changed.body.checkoutRevision, 2);
    assert.equal(changed.body.checkout.confirmed, false);
    assert.equal(changed.body.reservations[0].quantity, 1);
    assert.equal(changed.body.reservations[0].generation, 2);
    assert.equal(
      (await api(`/orders/${first.id}/checkout/confirm`, a, 'POST', { expectedRevision: 1 }))
        .status,
      409,
    );
    const confirmed = await api(`/orders/${first.id}/checkout/confirm`, a, 'POST', {
      expectedRevision: 2,
    });
    assert.equal(confirmed.body.checkout.confirmed, true);
    const confirmReplay = await api(`/orders/${first.id}/checkout/confirm`, a, 'POST', {
      expectedRevision: 2,
    });
    assert.equal(
      confirmReplay.body.events.filter((event) => event.type === 'CheckoutConfirmed').length,
      1,
    );
    const activeRefresh = await api(`/orders/${first.id}/checkout/refresh`, a, 'POST', {
      expectedRevision: 2,
    });
    assert.equal(activeRefresh.body.expiresAt, confirmed.body.expiresAt);
    assert.equal((await create(input, key)).body.checkoutRevision, 2);
    const prepared = await ready(first.id, 2);
    assert.equal(prepared.preparationPending, false);
    assert.equal(prepared.financial.status, 'NOT_REQUESTED');
    assert.equal(prepared.financial.sourceVersion, 0);
    const billing = (
      await db(
        'billing',
        'SELECT revision,total_minor::text AS total FROM prepared_checkouts WHERE order_id=$1',
        [first.id],
      )
    )[0];
    assert.equal(billing.revision, 2);
    assert.equal(billing.total, prepared.totalMinor);
    assert.equal(
      (await db('billing', 'SELECT id FROM payments WHERE order_id=$1', [first.id])).length,
      0,
    );
    pass(
      'expiry releases once and replay stays expired; stock reacquisition creates versioned changed basket requiring confirmation',
    );

    const budget = (await db('commerce', 'SELECT * FROM admission_budget WHERE id=1'))[0];
    try {
      await db('commerce', 'UPDATE admission_budget SET accepting_new=false WHERE id=1');
      assert.equal((await create(input, key)).body.id, first.id);
      const blockedKey = randomUUID();
      const blocked = await create([{ productId: digital.id, quantity: 1 }], blockedKey);
      assert.equal(blocked.status, 503);
      assert.equal(blocked.retryAfter, '2');
      assert.equal(
        (
          await db(
            'commerce',
            "SELECT id FROM idempotency_records WHERE operation='order:create' AND key=$1",
            [blockedKey],
          )
        ).length,
        0,
      );
    } finally {
      await db('commerce', 'UPDATE admission_budget SET accepting_new=$1 WHERE id=1', [
        budget.accepting_new,
      ]);
    }
    const capacity = (await db('commerce', 'SELECT capacity FROM admission_budget WHERE id=1'))[0]
      .capacity;
    try {
      await db('commerce', 'UPDATE admission_budget SET capacity=used WHERE id=1 AND used>0');
      assert.equal((await create([{ productId: digital.id, quantity: 1 }])).status, 503);
    } finally {
      await db('commerce', 'UPDATE admission_budget SET capacity=$1 WHERE id=1', [capacity]);
    }
    pass(
      'shared SQL admission limit/maintenance gate reject new work while replay remains available',
    );

    const commerce = await broker('commerce');
    const billingBroker = await broker('billing');
    try {
      const row = (
        await db(
          'commerce',
          "SELECT * FROM outbox WHERE aggregate_id=$1 AND kind='CheckoutPrepared' AND generation=1",
          [first.id],
        )
      )[0];
      const envelope = {
        schemaVersion: 1,
        id: row.id,
        producer: 'commerce',
        kind: row.kind,
        aggregateId: row.aggregate_id,
        generation: row.generation,
        correlationId: row.payload.correlationId,
        payload: row.payload,
      };
      await publish(commerce.channel, row.kind, envelope);
      await pause(800);
      assert.equal(
        (await db('billing', 'SELECT * FROM consumer_receipts WHERE message_id=$1', [row.id]))
          .length,
        1,
      );
      assert.equal(
        (
          await db('billing', 'SELECT revision FROM prepared_checkouts WHERE order_id=$1', [
            first.id,
          ])
        )[0].revision,
        2,
      );
      await publish(commerce.channel, row.kind, {
        ...envelope,
        payload: { ...row.payload, totalMinor: '1' },
      });
      await until(
        async () =>
          (
            await db(
              'billing',
              "SELECT id FROM message_quarantine WHERE reason='MESSAGE_ID_COLLISION' AND evidence->>'id'=$1",
              [row.id],
            )
          ).length,
        'conflicting redelivery quarantined',
      );
      const poison = { ...envelope, id: randomUUID(), kind: 'UnexpectedCommand' };
      await publish(commerce.channel, poison.kind, poison);
      await until(
        async () =>
          (
            await db(
              'billing',
              "SELECT message_id FROM inbox_messages WHERE message_id=$1 AND status='QUARANTINED'",
              [poison.id],
            )
          ).length,
        'poison quarantined',
      );
      assert.equal(
        (await db('billing', 'SELECT * FROM consumer_receipts WHERE message_id=$1', [poison.id]))
          .length,
        0,
      );
      // Simulate a publisher dying after broker confirm, leaving an expired SQL claim.
      await db(
        'commerce',
        "UPDATE outbox SET published_at=NULL,claim_token=$2,lease_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [row.id, randomUUID()],
      );
      await pause(700);
      assert.equal(
        (await db('commerce', 'SELECT published_at FROM outbox WHERE id=$1', [row.id]))[0]
          .published_at,
        null,
      );
      await until(
        async () =>
          (await db('commerce', 'SELECT published_at FROM outbox WHERE id=$1', [row.id]))[0]
            .published_at,
        'lease recovery publishes',
      );
      assert.equal(
        (await db('billing', 'SELECT * FROM consumer_receipts WHERE message_id=$1', [row.id]))
          .length,
        1,
      );
      pass(
        'duplicate/stale delivery is idempotent; conflicting/poison input quarantined; expired publisher lease recovers',
      );

      await billingBroker.channel.unbindQueue('billing.q.events', 'commerce.events', '#');
      let unrouted;
      try {
        unrouted = await create([{ productId: digital.id, quantity: 1 }]);
        assert.equal(unrouted.status, 201);
        await until(async () => {
          const r = (
            await db(
              'commerce',
              "SELECT published_at,attempts FROM outbox WHERE aggregate_id=$1 AND kind='CheckoutPrepared'",
              [unrouted.body.id],
            )
          )[0];
          return r.attempts > 0 && r.published_at === null;
        }, 'mandatory return retains SQL work');
      } finally {
        await billingBroker.channel.bindQueue('billing.q.events', 'commerce.events', '#');
      }
      await ready(unrouted.body.id, 1);
      pass(
        'unroutable mandatory publish remains unpublished and recovers after binding restoration',
      );
    } finally {
      await commerce.conn.close();
      await billingBroker.conn.close();
    }

    const deferred = await create([{ productId: digital.id, quantity: 1 }]);
    assert.equal(deferred.status, 201);
    await ready(deferred.body.id, 1);
    await db('billing', 'BEGIN');
    try {
      await db('billing', 'SELECT order_id FROM prepared_checkouts WHERE order_id=$1 FOR UPDATE', [
        deferred.body.id,
      ]);
      await expire([deferred.body.id]);
      assert.equal(
        (
          await api(`/orders/${deferred.body.id}/checkout/refresh`, a, 'POST', {
            expectedRevision: 1,
          })
        ).status,
        201,
      );
      await until(
        async () =>
          (
            await db(
              'billing',
              `SELECT message_id FROM inbox_messages WHERE envelope->>'aggregateId'=$1
        AND envelope->>'generation'='2' AND status='PENDING' AND attempts>0`,
              [deferred.body.id],
            )
          ).length,
        'transient row lock produces durable retry',
      );
      assert.equal((await api(`/orders/${deferred.body.id}`)).body.preparationPending, true);
    } finally {
      await db('billing', 'ROLLBACK');
    }
    await ready(deferred.body.id, 2);
    pass(
      'SQL lock timeout rolls back domain effect and receipt, persists backoff, then completes after lock release',
    );

    const capacityConsumer = `capacity-${randomUUID()}`;
    let staged;
    try {
      // Identified synthetic future-due rows occupy capacity without becoming domain work.
      await db(
        'billing',
        `INSERT INTO inbox_messages(consumer,message_id,envelope,available_at)
        SELECT $1,gen_random_uuid(),'{}'::jsonb,clock_timestamp()+interval '1 hour' FROM generate_series(1,10000)`,
        [capacityConsumer],
      );
      staged = await create([{ productId: digital.id, quantity: 1 }]);
      assert.equal(staged.status, 201);
      await until(
        async () =>
          (
            await db(
              'commerce',
              "SELECT published_at FROM outbox WHERE aggregate_id=$1 AND kind='CheckoutPrepared'",
              [staged.body.id],
            )
          )[0]?.published_at,
        'broker durably accepts capacity-blocked envelope',
      );
      await pause(2000);
      assert.equal(
        (
          await db(
            'billing',
            "SELECT message_id FROM inbox_messages WHERE envelope->>'aggregateId'=$1",
            [staged.body.id],
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await db('billing', 'SELECT order_id FROM prepared_checkouts WHERE order_id=$1', [
            staged.body.id,
          ])
        ).length,
        0,
      );
    } finally {
      await db('billing', 'DELETE FROM inbox_messages WHERE consumer=$1', [capacityConsumer]);
    }
    await ready(staged.body.id, 1);
    pass(
      'full durable inbox stops ACK/staging; broker retains accepted envelope until SQL capacity returns',
    );

    // Only this fixture simulates step-4 payment ownership; never expose a public force-state endpoint.
    await db('commerce', 'BEGIN');
    await db(
      'commerce',
      "UPDATE orders SET status='PAYING',checkout_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    await db(
      'commerce',
      "UPDATE reservations SET status='PAYMENT_PENDING',expires_at=NULL WHERE item_id IN (SELECT id FROM order_items WHERE order_id=$1) AND status='ACTIVE'",
      [first.id],
    );
    await db('commerce', 'COMMIT');
    try {
      await pause(1500);
      assert.equal(
        (await api(`/orders/${first.id}`)).body.reservations[0].status,
        'PAYMENT_PENDING',
      );
    } finally {
      await db('commerce', 'BEGIN');
      await db(
        'commerce',
        "UPDATE orders SET status='CHECKOUT_RESERVED',checkout_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1",
        [first.id],
      );
      await db(
        'commerce',
        "UPDATE reservations SET status='ACTIVE',expires_at=clock_timestamp()+interval '5 minutes' WHERE item_id IN (SELECT id FROM order_items WHERE order_id=$1) AND status='PAYMENT_PENDING'",
        [first.id],
      );
      await db('commerce', 'COMMIT');
    }
    const currentStock = (await api(`/admin/products/${p.id}`, admin)).body.stock;
    const discrepancy = await api(
      `/admin/inventory/${p.id}/reconcile`,
      admin,
      'POST',
      {
        countedOnHand: 0,
        expectedVersion: currentStock.version,
        reason: 'Warehouse miscount expiry fixture',
      },
      randomUUID(),
    );
    assert.equal(discrepancy.status, 201);
    assert.equal(discrepancy.body.requiresReview, true);
    await expire([first.id]);
    assert.equal((await api(`/admin/products/${p.id}`, admin)).body.stock.available, '0');
    pass(
      'payment-owned hold survives stale checkout expiry; admin-shortage expiry does not relist nonexistent units',
    );
    await cleanup();
    const accounting = (
      await db(
        'commerce',
        'SELECT used,(SELECT count(*)::int FROM admission_slots WHERE released_at IS NULL) AS actual FROM admission_budget WHERE id=1',
      )
    )[0];
    assert.equal(accounting.used, accounting.actual);
    pass(
      'admission counter matches live slots; known fixture orders expire without clearing any existing data',
    );
  }
} finally {
  // On a failed main check, still release only this run's known checkout fixtures.
  if (phase === 'main') await cleanup();
  await Promise.all([...clients.values()].map((client) => client.end()));
}
