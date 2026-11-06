import type { Sql } from '../../../../../../packages/runtime/src/outbox.js';
import type { WorkItem } from '../settlement.js';
export async function fulfillDigital(sql: Sql, item: WorkItem) {
  await sql.query(
    'INSERT INTO digital_entitlements(customer_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING product_id',
    [item.customer_id, item.product_id],
  );
  await sql.query(
    'INSERT INTO digital_grants(item_id,customer_id,product_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING item_id',
    [item.id, item.customer_id, item.product_id],
  );
}
