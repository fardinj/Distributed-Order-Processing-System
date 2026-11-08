import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink, readFile, writeFile } from 'node:fs/promises';
import { token, api, db, close, product, deactivate, save, load, until, pass } from './client.mjs';
const phase = process.argv[3];
try {
  if (phase === 'admission-pause') {
    const prior = (
      await db('commerce', 'SELECT accepting_new FROM admission_budget WHERE id=1')
    )[0];
    await save('source-admission', prior);
    await db('commerce', 'UPDATE admission_budget SET accepting_new=false WHERE id=1 RETURNING id');
    pass('new source admission paused without clearing accepted slots');
  } else if (phase === 'admission-resume') {
    const prior = await load('source-admission');
    await db('commerce', 'UPDATE admission_budget SET accepting_new=$1 WHERE id=1 RETURNING id', [
      prior.accepting_new,
    ]);
    pass('original admission switch restored');
  } else if (phase === 'clean-smoke') {
    await until(
      async () =>
        (await db('commerce', 'SELECT storage_healthy FROM admission_budget WHERE id=1'))[0]
          ?.storage_healthy,
      'fresh storage monitor opens admission',
    );
    await until(
      async () =>
        (await db('commerce', 'SELECT storage_healthy FROM admission_budget WHERE id=1'))[0]
          ?.storage_healthy,
      'fresh storage monitor opens admission',
    );
    const admin = await token('fixture-admin', 'fixture_admin'),
      customer = await token('fixture-customer-a', 'fixture_customer_a');
    const products = [];
    try {
      for (const kind of ['DIGITAL', 'SUBSCRIPTION', 'PHYSICAL'])
        products.push(await product(admin, kind));
      const physical = products[2];
      assert.equal(
        (
          await api(
            `/admin/inventory/${physical.id}/adjustments`,
            admin,
            'POST',
            { expectedVersion: 1, delta: 2, reason: 'Fresh installation stock fixture' },
            randomUUID(),
          )
        ).status,
        201,
      );
      const created = await api(
        '/orders',
        customer,
        'POST',
        { items: products.map((p) => ({ productId: p.id, quantity: 1 })) },
        randomUUID(),
      );
      assert.equal(created.status, 201);
      const o = created.body;
      assert.equal(
        (await api(`/orders/${o.id}/payment`, customer, 'POST', { expectedRevision: 1 })).status,
        201,
      );
      const completed = await until(async () => {
        const current = (await api(`/orders/${o.id}`, customer)).body;
        return current?.status === 'COMPLETED' ? current : null;
      }, 'fresh install typed order');
      assert.equal(completed.fulfillment.digitalGrants.length, 1);
      assert.equal(completed.fulfillment.subscriptionExtensions.length, 1);
      assert.equal(completed.fulfillment.shipments.length, 1);
      await save('clean-room-results', {
        orderId: o.id,
        totalMinor: completed.totalMinor,
        status: completed.status,
      });
      pass('fresh credentials/volumes execute one paid order with all three typed effects');
    } finally {
      for (const p of products) await deactivate(admin, p);
    }
  } else if (phase === 'stock-race') {
    const admin = await token('fixture-admin', 'fixture_admin'),
      tokens = await Promise.all([
        token('fixture-customer-a', 'fixture_customer_a'),
        token('fixture-customer-b', 'fixture_customer_b'),
      ]);
    const p = await product(admin, 'PHYSICAL', '10');
    assert.equal(
      (
        await api(
          `/admin/inventory/${p.id}/adjustments`,
          admin,
          'POST',
          { expectedVersion: 1, delta: 5, reason: 'Five units for 100 competing checkouts' },
          randomUUID(),
        )
      ).status,
      201,
    );
    const attempts = Array.from({ length: 100 }, (_, n) => ({
      key: randomUUID(),
      actor: tokens[n % 2],
    }));
    const create = (a) =>
      api('/orders', a.actor, 'POST', { items: [{ productId: p.id, quantity: 1 }] }, a.key);
    const replies = await Promise.all(attempts.map(create));
    for (let i = 0; i < replies.length; i++)
      if ([0, 502, 503].includes(replies[i].status)) replies[i] = await create(attempts[i]);
    assert.equal(replies.filter((r) => r.status === 201).length, 5);
    assert.ok(replies.every((r) => [201, 409].includes(r.status)));
    const inventory = (
      await db(
        'commerce',
        'SELECT available::text AS available FROM inventory WHERE product_id=$1',
        [p.id],
      )
    )[0];
    assert.equal(inventory.available, '0');
    for (let i = 0; i < replies.length; i++)
      if (replies[i].status === 201) {
        const o = replies[i].body;
        assert.equal(
          (
            await api(
              `/orders/${o.id}/cancel`,
              attempts[i].actor,
              'POST',
              {
                expectedVersion: o.workflowVersion,
                reason: 'Contention fixture completed without payment',
              },
              randomUUID(),
            )
          ).status,
          201,
        );
      }
    assert.equal(
      (
        await db(
          'commerce',
          'SELECT available::text AS available FROM inventory WHERE product_id=$1',
          [p.id],
        )
      )[0].available,
      '5',
    );
    await deactivate(admin, p);
    await save('stock-race', { offered: 100, accepted: 5, conflicts: 95, returnedUnits: '5' });
    pass(
      '100 competing checkouts with transparent retries reserve at most five units; cancellation releases each once',
    );
  } else if (phase === 'bank-evidence') {
    const s = await load('fulfillment-bank');
    const row = (
      await db(
        'billing',
        'SELECT r.lookup_count,r.status FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.order_id=$1',
        [s.order.id],
      )
    )[0];
    assert.equal(row.status, 'UNKNOWN');
    assert.ok(row.lookup_count > 3);
    await save('bank-outage-evidence', row);
    pass(
      'financial reconciliation continues beyond three actual provider attempts during a 45-second outage',
    );
  } else if (phase === 'prepare-db') {
    const admin = await token('fixture-admin', 'fixture_admin'),
      customer = await token('fixture-customer-a', 'fixture_customer_a');
    const p = await product(admin),
      key = randomUUID();
    const o = await api(
      '/orders',
      customer,
      'POST',
      { items: [{ productId: p.id, quantity: 1 }] },
      key,
    );
    assert.equal(o.status, 201);
    await save('db-outage', { order: o.body, product: p, key, rejectedKey: randomUUID() });
    await writeFile('/verification/db-outage-token.private', customer, { mode: 0o600 });
    pass('accepted order/identity recorded before database outage');
  } else if (phase === 'db-down') {
    const s = await load('db-outage'),
      customer = await readFile('/verification/db-outage-token.private', 'utf8');
    for (const [path, method, body, key] of [
      [`/orders/${s.order.id}`, 'GET'],
      ['/orders', 'POST', { items: [{ productId: s.product.id, quantity: 1 }] }, s.rejectedKey],
    ]) {
      const result = await api(path, customer, method, body, key);
      assert.ok(
        [502, 503].includes(result.status),
        `unsafe database operation got ${result.status}`,
      );
    }
    assert.equal((await api('/orders', '', 'GET')).status, 401);
    pass(
      'database outage returns bounded failures for unsafe reads/writes and retains authentication',
    );
  } else if (phase === 'recover-db') {
    const s = await load('db-outage'),
      customer = await token('fixture-customer-a', 'fixture_customer_a');
    const replay = await api(
      '/orders',
      customer,
      'POST',
      { items: [{ productId: s.product.id, quantity: 1 }] },
      s.key,
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, s.order.id);
    assert.equal(
      (
        await db(
          'commerce',
          "SELECT id FROM idempotency_records WHERE operation='order:create' AND key=$1",
          [s.rejectedKey],
        )
      ).length,
      0,
    );
    assert.equal(
      (await api(`/orders/${s.order.id}/payment`, customer, 'POST', { expectedRevision: 1 }))
        .status,
      201,
    );
    await until(
      async () => (await api(`/orders/${s.order.id}`, customer)).body?.status === 'COMPLETED',
      'restored accepted order',
    );
    assert.equal(
      (
        await db('commerce', 'SELECT item_id FROM digital_grants WHERE item_id=$1', [
          s.order.items[0].id,
        ])
      ).length,
      1,
    );
    await deactivate(await token('fixture-admin', 'fixture_admin'), s.product);
    await unlink('/verification/db-outage-token.private');
    pass(
      'database/owner restart preserves one accepted order and grants once; outage write left no accepted key',
    );
  } else if (phase === 'prepare-identity') {
    const customer = await token('fixture-customer-a', 'fixture_customer_a');
    assert.equal((await api('/orders', customer)).status, 200);
    await writeFile('/verification/identity-token.private', customer, { mode: 0o600 });
    pass('known signed identity warmed before provider outage');
  } else if (phase === 'identity-warm' || phase === 'identity-cold') {
    const customer = await readFile('/verification/identity-token.private', 'utf8');
    if (phase === 'identity-cold')
      await until(
        async () => (await api('/orders', '')).status === 401,
        'cold gateway started while Identity is unavailable',
        30000,
      );
    assert.equal((await api('/orders', '')).status, 401);
    const result = await api('/orders', customer);
    assert.equal(result.status, phase === 'identity-warm' ? 200 : 503);
    pass(
      phase === 'identity-warm'
        ? 'cached signed token remains usable during provider outage; anonymous request stays denied'
        : 'cold verifier fails closed with 503 while Identity is unavailable',
    );
  } else if (phase === 'recover-identity') {
    const customer = await token('fixture-customer-a', 'fixture_customer_a');
    assert.equal((await api('/orders', customer)).status, 200);
    await unlink('/verification/identity-token.private');
    pass('Identity restoration re-enables real verification; private temporary token removed');
  } else if (phase === 'prepare-restore') {
    const admin = await token('fixture-admin', 'fixture_admin'),
      customer = await token('fixture-customer-a', 'fixture_customer_a'),
      p = await product(admin, 'DIGITAL', '12345678901234567890123456789012345678901234567890');
    const result = await api(
      '/orders',
      customer,
      'POST',
      { items: [{ productId: p.id, quantity: 1 }] },
      randomUUID(),
    );
    assert.equal(result.status, 201);
    const o = result.body;
    await db(
      'commerce',
      "INSERT INTO fulfillment_simulation_rules(item_id,not_before) VALUES($1,clock_timestamp()+interval '1 hour')",
      [o.items[0].id],
    );
    assert.equal(
      (await api(`/orders/${o.id}/payment`, customer, 'POST', { expectedRevision: 1 })).status,
      201,
    );
    await until(
      async () => (await api(`/orders/${o.id}`, customer)).body?.financial?.status === 'SUCCEEDED',
      'restore fixture captured',
    );
    await save('restore-fixture', { order: o, product: p });
    pass('large exact paid but unfulfilled order is durable before backup');
  } else if (phase === 'resume-restore') {
    const s = await load('restore-fixture');
    await db(
      'commerce',
      'UPDATE fulfillment_simulation_rules SET not_before=clock_timestamp() WHERE item_id=$1',
      [s.order.items[0].id],
    );
    await db(
      'commerce',
      'UPDATE fulfillment_jobs SET available_at=clock_timestamp() WHERE item_id=$1',
      [s.order.items[0].id],
    );
    const customer = await token('fixture-customer-a', 'fixture_customer_a');
    await until(
      async () => (await api(`/orders/${s.order.id}`, customer)).body?.status === 'COMPLETED',
      'restored paid work completes',
    );
    const current = (await api(`/orders/${s.order.id}`, customer)).body;
    assert.equal(current.totalMinor, s.order.totalMinor);
    assert.equal(current.fulfillment.digitalGrants.length, 1);
    assert.equal(
      (await db('billing', 'SELECT id FROM payments WHERE order_id=$1', [s.order.id])).length,
      1,
    );
    assert.equal(
      (
        await db('bank', 'SELECT operation_key FROM bank_operations WHERE operation_key=$1', [
          `payment:${s.order.id}`,
        ])
      ).length,
      1,
    );
    await deactivate(await token('fixture-admin', 'fixture_admin'), s.product);
    pass('paid work from snapshot resumes with one grant/charge and exact original IRR');
  } else throw new Error('Unknown explicit outage phase');
} finally {
  await close();
}
