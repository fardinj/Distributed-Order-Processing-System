import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, chmod, writeFile, unlink, readFile } from 'node:fs/promises';
import { token, api, db, close, product, deactivate, save, load, until, pass } from './client.mjs';
const action = process.argv[3],
  phase = process.argv[4],
  type = process.argv[5];
const directory = '/verification/crash-control';
async function effects(s) {
  const table = {
    DIGITAL: 'digital_grants',
    SUBSCRIPTION: 'subscription_extensions',
    PHYSICAL: 'shipments',
  }[s.type];
  assert.ok(table);
  return Number(
    (
      await db('commerce', `SELECT count(*)::int AS n FROM ${table} WHERE item_id=$1`, [s.itemId])
    )[0].n,
  );
}
try {
  if (action === 'prepare') {
    assert.ok(['after_effect', 'after_commit'].includes(phase));
    assert.ok(['DIGITAL', 'SUBSCRIPTION', 'PHYSICAL'].includes(type));
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o777);
    await unlink(`${directory}/barrier-reached.json`).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    const admin = await token('fixture-admin', 'fixture_admin'),
      customer = await token('fixture-customer-a', 'fixture_customer_a'),
      p = await product(admin, type);
    if (type === 'PHYSICAL')
      assert.equal(
        (
          await api(
            `/admin/inventory/${p.id}/adjustments`,
            admin,
            'POST',
            { expectedVersion: 1, delta: 2, reason: 'Crash verification physical fixture' },
            randomUUID(),
          )
        ).status,
        201,
      );
    const result = await api(
      '/orders',
      customer,
      'POST',
      { items: [{ productId: p.id, quantity: 1 }] },
      randomUUID(),
    );
    assert.equal(result.status, 201);
    const o = result.body,
      itemId = o.items[0].id;
    await db(
      'commerce',
      "INSERT INTO fulfillment_simulation_rules(item_id,not_before) VALUES($1,clock_timestamp()+interval '1 hour')",
      [itemId],
    );
    assert.equal(
      (await api(`/orders/${o.id}/payment`, customer, 'POST', { expectedRevision: 1 })).status,
      201,
    );
    await until(
      async () => (await api(`/orders/${o.id}`, customer)).body?.financial?.status === 'SUCCEEDED',
      'crash fixture capture',
    );
    await save('crash-fixture', { phase, type, orderId: o.id, itemId, product: p });
    await writeFile(`${directory}/control.json`, JSON.stringify({ itemId, phase }), {
      mode: 0o644,
    });
    await chmod(`${directory}/control.json`, 0o644);
    pass(`prepared ${type} ${phase}; already paid, only fixture dispatch deferred`);
  } else {
    const s = await load('crash-fixture');
    if (action === 'release') {
      await db(
        'commerce',
        'UPDATE fulfillment_simulation_rules SET not_before=clock_timestamp() WHERE item_id=$1',
        [s.itemId],
      );
      await db(
        'commerce',
        'UPDATE fulfillment_jobs SET available_at=clock_timestamp() WHERE item_id=$1',
        [s.itemId],
      );
    } else if (action === 'checkpoint' || action === 'killed') {
      const marker = JSON.parse(await readFile(`${directory}/barrier-reached.json`, 'utf8'));
      assert.equal(marker.itemId, s.itemId);
      assert.equal(marker.phase, s.phase);
      const committed = s.phase === 'after_commit',
        n = await effects(s);
      assert.equal(n, committed ? 1 : 0);
      assert.equal(
        (
          await db(
            'commerce',
            'SELECT count(*)::int AS n FROM fulfillment_attempts WHERE item_id=$1',
            [s.itemId],
          )
        )[0].n,
        committed ? 1 : 0,
      );
      if (s.type === 'PHYSICAL') {
        const r = (
          await db('commerce', 'SELECT status FROM reservations WHERE item_id=$1', [s.itemId])
        )[0];
        assert.equal(r.status, committed ? 'CONSUMED' : 'ALLOCATED');
        assert.equal(
          (
            await db('commerce', 'SELECT available::text AS n FROM inventory WHERE product_id=$1', [
              s.product.id,
            ])
          )[0].n,
          '1',
        );
      }
      if (action === 'killed') {
        // Replay the local job after a committed effect too; uniqueness/status must prevent re-execution.
        if (committed)
          await db(
            'commerce',
            "UPDATE fulfillment_jobs SET status='READY',available_at=clock_timestamp() WHERE item_id=$1",
            [s.itemId],
          );
      }
      pass(`${action} ${s.type} ${s.phase}: committed effects/attempts=${n}`);
    } else if (action === 'recover') {
      const customer = await token('fixture-customer-a', 'fixture_customer_a');
      await until(
        async () => (await api(`/orders/${s.orderId}`, customer)).body?.status === 'COMPLETED',
        'crash recovery completes',
      );
      await until(
        async () =>
          (
            await db('commerce', 'SELECT status FROM fulfillment_jobs WHERE item_id=$1', [s.itemId])
          )[0]?.status === 'DONE',
        'duplicate job settled',
      );
      assert.equal(await effects(s), 1);
      assert.equal(
        (
          await db(
            'commerce',
            'SELECT count(*)::int AS n FROM fulfillment_attempts WHERE item_id=$1',
            [s.itemId],
          )
        )[0].n,
        1,
      );
      assert.equal(
        (
          await db(
            'billing',
            "SELECT count(*)::int AS n FROM payments WHERE order_id=$1 AND status='SUCCEEDED' AND amount_minor=100",
            [s.orderId],
          )
        )[0].n,
        1,
      );
      assert.equal(
        (
          await db(
            'bank',
            "SELECT count(*)::int AS n FROM bank_operations WHERE operation_key=$1 AND status='SUCCEEDED' AND amount_minor=100",
            [`payment:${s.orderId}`],
          )
        )[0].n,
        1,
      );
      assert.equal(
        (
          await db(
            'commerce',
            'SELECT count(*)::int AS n FROM admission_slots WHERE order_id=$1 AND released_at IS NULL',
            [s.orderId],
          )
        )[0].n,
        0,
      );
      if (s.type === 'PHYSICAL')
        assert.equal(
          (
            await db('commerce', 'SELECT available::text AS n FROM inventory WHERE product_id=$1', [
              s.product.id,
            ])
          )[0].n,
          '1',
        );
      await deactivate(await token('fixture-admin', 'fixture_admin'), s.product);
      await save(`crash-${s.type.toLowerCase()}-${s.phase}`, {
        ...s,
        checkedAt: new Date().toISOString(),
        passed: true,
      });
      pass(`${s.type} ${s.phase}: one effect/attempt/charge, slot released`);
    } else throw new Error('Explicit crash phase required');
  }
} finally {
  await close();
}
