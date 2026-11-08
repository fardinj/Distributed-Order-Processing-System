import { randomUUID } from 'node:crypto';
import type { Sql } from '../../../../../../packages/runtime/src/outbox.js';
import type { WorkItem } from '../settlement.js';
export async function fulfillPhysical(sql: Sql, item: WorkItem) {
  const hold = (
    await sql.query<{ id: string; quantity: number }>(
      "SELECT id,quantity FROM reservations WHERE item_id=$1 AND status='ALLOCATED' ORDER BY id FOR UPDATE",
      [item.id],
    )
  )[0];
  if (!hold || hold.quantity !== item.quantity)
    throw new Error('Paid allocation prerequisite missing');
  const created = await sql.query<{ reference: string }>(
    'INSERT INTO shipments(item_id,reservation_id,reference) VALUES($1,$2,$3) ON CONFLICT(item_id) DO NOTHING RETURNING reference',
    [item.id, hold.id, `shipment-${randomUUID()}`],
  );
  if (created.length)
    await sql.query(
      'INSERT INTO order_events(id,order_id,type,metadata) VALUES($1,$2,$3,$4::jsonb)',
      [
        randomUUID(),
        item.order_id,
        'ShipmentCreated',
        JSON.stringify({ itemId: item.id, reference: created[0]!.reference }),
      ],
    );
  await sql.query(
    "UPDATE reservations SET status='CONSUMED' WHERE id=$1 AND status='ALLOCATED' RETURNING id",
    [hold.id],
  );
  // Sellable inventory was decremented at checkout; shipment never decrements it again.
}
