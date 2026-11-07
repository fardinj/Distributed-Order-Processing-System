import assert from 'node:assert/strict';
import { db, load, close, save, pass } from './client.mjs';
try {
  const report = await load('load-results'),
    ids = report.orderIds;
  assert.ok(ids?.length > 0);
  const commerce = (
    await db(
      'commerce',
      `SELECT count(DISTINCT o.id)::int AS orders,count(DISTINCT o.id) FILTER(WHERE o.status='COMPLETED')::int AS completed,count(DISTINCT i.id)::int AS items,count(DISTINCT g.item_id)::int AS grants,count(DISTINCT a.id)::int AS attempts,count(DISTINCT s.order_id) FILTER(WHERE s.released_at IS NULL)::int AS retained_slots FROM orders o JOIN order_items i ON i.order_id=o.id LEFT JOIN digital_grants g ON g.item_id=i.id LEFT JOIN fulfillment_attempts a ON a.item_id=i.id LEFT JOIN admission_slots s ON s.order_id=o.id WHERE o.id=ANY($1::uuid[])`,
      [ids],
    )
  )[0];
  const billing = (
    await db(
      'billing',
      "SELECT count(*)::int AS payments,count(*) FILTER(WHERE status='SUCCEEDED' AND amount_minor=100)::int AS correct FROM payments WHERE order_id=ANY($1::uuid[])",
      [ids],
    )
  )[0];
  const bank = (
    await db(
      'bank',
      "SELECT count(*)::int AS operations,count(*) FILTER(WHERE status='SUCCEEDED' AND amount_minor=100)::int AS correct FROM bank_operations WHERE operation_key=ANY($1::text[])",
      [ids.map((id) => `payment:${id}`)],
    )
  )[0];
  for (const value of [
    commerce.orders,
    commerce.completed,
    commerce.items,
    commerce.grants,
    commerce.attempts,
    billing.payments,
    billing.correct,
    bank.operations,
    bank.correct,
  ])
    assert.equal(value, ids.length);
  assert.equal(commerce.retained_slots, 0);
  const budget = (
    await db(
      'commerce',
      'SELECT used,capacity,accepting_new,(SELECT count(*)::int FROM admission_slots WHERE released_at IS NULL) AS slots FROM admission_budget WHERE id=1',
    )
  )[0];
  assert.equal(budget.used, budget.slots);
  assert.ok(budget.used <= budget.capacity);
  assert.equal(budget.accepting_new, (await load('source-admission')).accepting_new);
  await save('final-invariants', {
    run: report.run,
    checkedAt: new Date().toISOString(),
    commerce,
    billing,
    bank,
    budget,
  });
  pass(
    'after outages and backup rehearsal, every load identity/effect/charge and global admission accounting remain intact',
  );
} finally {
  await close();
}
