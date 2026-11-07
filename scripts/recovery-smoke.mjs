import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from 'pg';
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
async function api(path, bearer = a, method = 'GET', body, key) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await fetch(`http://gateway:3000/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await pause(250);
    }
  }
  return { status: r.status, mode: r.headers.get('x-rate-limit-mode'), body: await r.json() };
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
      name: `Recovery ${randomUUID()}`,
      type,
      priceMinor: price,
      ...(type === 'SUBSCRIPTION' ? { subscriptionDays: days } : {}),
      reason: 'Step 6 isolated fixture',
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

const phase = process.argv[2] ?? 'main';
const cancel = (o, key = randomUUID(), bearer = a) =>
  api(
    `/orders/${o.id}/cancel`,
    bearer,
    'POST',
    { expectedVersion: o.workflowVersion, reason: 'Customer requests cancellation' },
    key,
  );
const state = async (o) => (await api(`/orders/${o.id}`)).body;
async function accelerate(o) {
  await db(
    'commerce',
    "UPDATE order_items SET next_attempt_at=clock_timestamp() WHERE order_id=$1 AND status='RETRY_WAIT'",
    [o.id],
  );
  await db(
    'commerce',
    "UPDATE fulfillment_jobs SET available_at=clock_timestamp() WHERE item_id IN(SELECT id FROM order_items WHERE order_id=$1) AND status='DEFERRED'",
    [o.id],
  );
}
try {
  if (phase === 'redis-down') {
    const p = await product('DIGITAL', '13');
    const catalog = await api(`/products/${p.id}`);
    assert.equal(catalog.status, 200);
    assert.equal(catalog.mode, 'local-degraded');
    assert.equal((await api('/orders', '', 'GET')).status, 401);
    assert.equal((await api('/admin/products', a)).status, 403);
    const o = await checkout([[p]]);
    await pay(o);
    assert.equal((await final(o, 'COMPLETED')).fulfillment.digitalGrants.length, 1);
    pass(
      'Redis outage bypasses cache and scheduler lock, keeps API/auth available and commits exactly one SQL effect',
    );
    for (let n = 0; n < 120; n++)
      assert.equal((await api('/orders', b, 'POST', {}, randomUUID())).status, 400);
    const limited = await api('/orders', b, 'POST', {}, randomUUID());
    assert.equal(limited.status, 429);
    assert.equal(limited.mode, 'local-degraded');
    pass('Redis outage still enforces the documented per-instance new-request quota with 429');
  } else if (phase === 'storage-sensed') {
    const observation = (
      await db(
        'commerce',
        "SELECT storage_healthy,storage_checked_at>clock_timestamp()-interval '30 seconds' AS fresh FROM admission_budget WHERE id=1",
      )
    )[0];
    assert.equal(observation.storage_healthy, false);
    assert.equal(observation.fresh, true);
    const p = await product('DIGITAL', '17');
    assert.equal(
      (await api('/orders', a, 'POST', { items: [{ productId: p.id, quantity: 1 }] }, randomUUID()))
        .status,
      503,
    );
    pass(
      'actual filesystem monitor with a private high reserve threshold closes new admission without filling or deleting disk',
    );
  } else if (phase === 'storage-down') {
    const p = await product('DIGITAL', '17');
    const o = await checkout([[p]]);
    const admitted = await checkout([[p]]);
    try {
      await db(
        'commerce',
        'UPDATE admission_budget SET storage_healthy=false,storage_checked_at=clock_timestamp() WHERE id=1',
      );
      const rejected = await api(
        '/orders',
        a,
        'POST',
        { items: [{ productId: p.id, quantity: 1 }] },
        randomUUID(),
      );
      assert.equal(rejected.status, 503);
      assert.equal((await cancel(o)).status, 201);
      assert.equal((await state(o)).status, 'CANCELLED');
      await pay(admitted);
      await final(admitted, 'COMPLETED');
      await db(
        'commerce',
        "UPDATE admission_budget SET storage_healthy=true,storage_checked_at=clock_timestamp()-interval '31 seconds' WHERE id=1",
      );
      assert.equal(
        (
          await api(
            '/orders',
            a,
            'POST',
            { items: [{ productId: p.id, quantity: 1 }] },
            randomUUID(),
          )
        ).status,
        503,
      );
      pass(
        'low-storage admission rejects new work with 503 while an accepted cancellation completes',
      );
    } finally {
      await db(
        'commerce',
        'UPDATE admission_budget SET storage_healthy=true,storage_checked_at=clock_timestamp() WHERE id=1',
      );
    }
  } else {
    const { Dependencies } = await import('../dist/packages/runtime/src/dependencies.js');
    const { Auxiliary } = await import('../dist/packages/runtime/src/auxiliary.js');
    const deps = new Dependencies({
      name: 'commerce',
      port: 3000,
      upstreams: {},
      redis: { url: 'redis://redis:6379', password: await secret('redis') },
    });
    try {
      const aux = new Auxiliary(deps);
      const identity = randomUUID();
      assert.equal((await aux.quota(identity, 'verification', 2)).allowed, true);
      assert.equal((await aux.quota(identity, 'verification', 2)).allowed, true);
      const third = await aux.quota(identity, 'verification', 2);
      assert.deepEqual([third.allowed, third.mode], [false, 'shared']);
      let reads = 0;
      assert.equal(await aux.cached(identity, async () => ++reads), 1);
      assert.equal(await aux.cached(identity, async () => ++reads), 1);
      let release, started;
      const entered = new Promise((resolve) => {
        started = resolve;
      });
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const lockName = `verify-${identity}`;
      const running = aux.overlap(lockName, async () => {
        started();
        await held;
      });
      await entered;
      let overlapped = false;
      await aux.overlap(lockName, async () => {
        overlapped = true;
      });
      assert.equal(overlapped, false);
      await deps.optionalRedis((r) =>
        r.set(`tops:scheduler:${lockName}`, 'replacement-owner', { PX: 1000 }),
      );
      release();
      await running;
      assert.equal(
        await deps.optionalRedis((r) => r.get(`tops:scheduler:${lockName}`)),
        'replacement-owner',
      );
      pass(
        'real Redis caches reads, enforces shared quotas, excludes scheduler overlap and preserves replacement lock ownership',
      );
    } finally {
      await deps.onModuleDestroy();
    }

    const p = await product('PHYSICAL', '11');
    const unpaid = await checkout([[p, 2]]);
    assert.equal((await cancel(unpaid, randomUUID(), b)).status, 404);
    const key = randomUUID();
    const stopped = await cancel(unpaid, key);
    assert.equal(stopped.status, 201, JSON.stringify(stopped.body));
    assert.deepEqual((await cancel(unpaid, key)).body, stopped.body);
    assert.equal((await state(unpaid)).status, 'CANCELLED');
    assert.equal((await api(`/admin/products/${p.id}`, admin)).body.stock.available, '10');
    assert.equal(
      (await api(`/orders/${unpaid.id}/payment`, a, 'POST', { expectedRevision: 1 })).status,
      409,
    );
    pass(
      'unpaid cancellation releases stock/slot once, replays idempotently, and enforces ownership',
    );

    const digital = await product('DIGITAL', '19');
    assert.equal((await api(`/products/${digital.id}`)).body.priceMinor, '19');
    assert.equal(
      (
        await api(
          `/admin/products/${digital.id}`,
          admin,
          'PATCH',
          { expectedVersion: 1, priceMinor: '23', reason: 'Validate SQL prices behind cache' },
          randomUUID(),
        )
      ).status,
      200,
    );
    const repriced = await checkout([[digital]]);
    assert.equal(repriced.totalMinor, '23');
    assert.equal((await cancel(repriced)).status, 201);
    assert.equal(
      (
        await api(
          `/admin/products/${digital.id}`,
          admin,
          'PATCH',
          {
            expectedVersion: 2,
            priceMinor: '19',
            reason: 'Restore fixture price after cache test',
          },
          randomUUID(),
        )
      ).status,
      200,
    );
    pass(
      'checkout prices come from PostgreSQL even while the catalog read cache may retain an older price',
    );
    const paid = await checkout([[digital]]);
    await control(paid.items[0], 'SUCCESS', true);
    const captured = await pay(paid);
    assert.equal((await cancel(captured)).status, 201);
    const refunded = await final(paid, 'CANCELLED');
    assert.equal(refunded.financial.refundedMinor, '19');
    assert.equal(refunded.fulfillment.digitalGrants.length, 0);
    pass(
      'public paid cancellation suppresses dispatch and reports confirmed full return separately',
    );

    // Race actual public cancellation against a runnable worker; either valid outcome is permitted.
    for (let n = 0; n < 3; n++) {
      const o = await checkout([[digital]]);
      await control(o.items[0], 'SUCCESS', true);
      const current = await pay(o);
      const [, result] = await Promise.all([unpause(o), cancel(current)]);
      assert.ok([201, 409].includes(result.status), JSON.stringify(result));
      const done = await final(o, result.status === 201 ? 'CANCELLED' : 'COMPLETED');
      assert.equal(done.fulfillment.digitalGrants.length, result.status === 201 ? 0 : 1);
      assert.equal(done.financial.refundedMinor, result.status === 201 ? '19' : '0');
      if (result.status === 409) assert.equal((await cancel(done)).status, 409);
    }
    pass('concurrent public cancellation/worker races have one winner and never grant plus refund');

    const recover = await checkout([[digital]]);
    await control(recover.items[0], 'TRANSIENT', true, 4);
    await pay(recover);
    await unpause(recover);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await until(
        async () =>
          (
            await db('commerce', 'SELECT attempt_count FROM order_items WHERE id=$1', [
              recover.items[0].id,
            ])
          )[0].attempt_count >= attempt,
        `attempt ${attempt}`,
      );
      if (attempt < 4) await accelerate(recover);
    }
    let waiting = await state(recover);
    assert.equal(waiting.items[0].status, 'RETRY_WAIT');
    assert.ok(new Date(waiting.items[0].nextAttemptAt).getTime() - Date.now() >= 55000);
    await accelerate(recover);
    const finished = await final(recover, 'COMPLETED');
    assert.equal(finished.items[0].attemptCount, 5);
    assert.equal(
      (await api(`/orders/${recover.id}/items/${recover.items[0].id}/attempts`)).body.items.length,
      5,
    );
    assert.equal(
      (
        await api(
          `/orders/${recover.id}/items/${recover.items[0].id}/retry`,
          a,
          'POST',
          {
            expectedGeneration: 0,
            expectedRetryVersion: finished.items[0].retryVersion,
            reason: 'Do not rerun a success',
          },
          randomUUID(),
        )
      ).status,
      409,
    );
    pass(
      'four transient failures defer, fifth attempt succeeds once; attempt history remains visible and success cannot rerun',
    );

    const review = await checkout([[digital]]);
    await control(review.items[0], 'TRANSIENT', true, 12);
    await pay(review);
    await unpause(review);
    for (let attempt = 1; attempt <= 12; attempt++) {
      await until(
        async () =>
          (
            await db('commerce', 'SELECT attempt_count FROM order_items WHERE id=$1', [
              review.items[0].id,
            ])
          )[0].attempt_count >= attempt,
        `cost attempt ${attempt}`,
      );
      if (attempt < 12) await accelerate(review);
    }
    // Private clock fixture advances only eligibility age; all 12 attempts actually executed.
    await db(
      'commerce',
      "UPDATE order_items SET recovery_started_at=clock_timestamp()-interval '31 minutes' WHERE id=$1",
      [review.items[0].id],
    );
    await accelerate(review);
    const human = await final(review, 'MANUAL_REVIEW');
    const caseId = (
      await db(
        'commerce',
        "SELECT id FROM review_cases WHERE resource_id=$1 AND reason='RECOVERY_COST' AND status='OPEN'",
        [review.items[0].id],
      )
    )[0].id;
    assert.equal((await api(`/admin/manual-review/${caseId}`, a)).status, 403);
    assert.equal((await api(`/admin/manual-review/${caseId}`, admin)).status, 200);
    const input = {
      expectedGeneration: human.items[0].generation,
      expectedRetryVersion: human.items[0].retryVersion,
      reason: 'Dependency repaired; permit one audited cycle',
    };
    const path = `/orders/${review.id}/items/${review.items[0].id}/retry`;
    assert.equal((await api(path, a, 'POST', input, randomUUID())).status, 409);
    assert.equal(
      (
        await api(
          path,
          admin,
          'POST',
          { ...input, expectedRetryVersion: input.expectedRetryVersion - 1 },
          randomUUID(),
        )
      ).status,
      409,
    );
    await control(review.items[0], 'SUCCESS');
    const retryKey = randomUUID();
    const resumed = await api(path, admin, 'POST', input, retryKey);
    assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
    assert.deepEqual((await api(path, admin, 'POST', input, retryKey)).body, resumed.body);
    const resolved = await final(review, 'COMPLETED');
    assert.equal(resolved.items[0].attemptCount, 13);
    assert.equal(resolved.fulfillment.digitalGrants.length, 1);
    pass(
      'cost plus elapsed failure evidence opens durable review; admin cycle is guarded, audited, idempotent and retains 13 attempts',
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
        { expectedVersion: p.body.version, reason: 'Recovery fixture complete; retain evidence' },
        randomUUID(),
      );
  }
  await Promise.all([...clients.values()].map((c) => c.end()));
}
