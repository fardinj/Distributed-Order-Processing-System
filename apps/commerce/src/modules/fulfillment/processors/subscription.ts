import type { Sql } from '../../../../../../packages/runtime/src/outbox.js';
import type { WorkItem } from '../settlement.js';
export async function fulfillSubscription(sql: Sql, item: WorkItem) {
  if (
    (await sql.query('SELECT item_id FROM subscription_extensions WHERE item_id=$1', [item.id]))
      .length
  )
    return;
  await sql.query(
    'INSERT INTO subscriptions(customer_id,product_id,expires_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT DO NOTHING RETURNING product_id',
    [item.customer_id, item.product_id],
  );
  const previous = (
    await sql.query<{ expires_at: Date }>(
      'SELECT expires_at FROM subscriptions WHERE customer_id=$1 AND product_id=$2 FOR UPDATE',
      [item.customer_id, item.product_id],
    )
  )[0]!.expires_at;
  const next = (
    await sql.query<{ expires_at: Date }>(
      `UPDATE subscriptions SET expires_at=greatest(expires_at,clock_timestamp())+$3*interval '1 day'
  WHERE customer_id=$1 AND product_id=$2 RETURNING expires_at`,
      [item.customer_id, item.product_id, item.subscription_days],
    )
  )[0]!.expires_at;
  await sql.query(
    `INSERT INTO subscription_extensions(item_id,customer_id,product_id,days,previous_expires_at,new_expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING item_id`,
    [item.id, item.customer_id, item.product_id, item.subscription_days, previous, next],
  );
}
