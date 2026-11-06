import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Sql } from '../../../../../packages/runtime/src/outbox.js';

export interface WorkItem {
  id: string;
  order_id: string;
  product_id: string;
  type: string;
  quantity: number;
  subscription_days: number | null;
  amount: string;
  status: string;
  disposition: string;
  generation: number;
  attempt_count: number;
  customer_id: string;
  checkout_revision: number;
  payment_operation_key: string;
  cancellation_requested: boolean;
}
@Injectable()
export class Settlement {
  async history(sql: Sql, orderId: string, type: string, metadata: unknown) {
    await sql.query(
      'INSERT INTO order_events(id,order_id,type,metadata) VALUES($1,$2,$3,$4::jsonb) RETURNING id',
      [randomUUID(), orderId, type, JSON.stringify(metadata)],
    );
  }
  async releaseAllocation(sql: Sql, itemId: string) {
    const holds = await sql.query<{
      id: string;
      product_id: string;
      quantity: number;
      missing: boolean;
    }>(
      `SELECT r.id,r.product_id,r.quantity,EXISTS(SELECT 1 FROM stock_dispositions d WHERE d.reservation_id=r.id) AS missing
    FROM reservations r WHERE r.item_id=$1 AND r.status IN ('ALLOCATED','DISPUTED') ORDER BY r.id FOR UPDATE`,
      [itemId],
    );
    for (const hold of holds) {
      await sql.query("UPDATE reservations SET status='RELEASED' WHERE id=$1 RETURNING id", [
        hold.id,
      ]);
      if (!hold.missing)
        await sql.query(
          `UPDATE inventory SET available=CASE WHEN requires_review THEN available ELSE available+$2 END,version=version+1,updated_at=clock_timestamp() WHERE product_id=$1 RETURNING product_id`,
          [hold.product_id, hold.quantity],
        );
    }
  }
  async refund(
    sql: Sql,
    item: WorkItem,
    reason: string,
    missing?: { reservationId: string; actor: string },
  ) {
    if (item.status === 'SUCCEEDED')
      throw new Error('Succeeded items cannot enter refund resolution');
    const existing = (
      await sql.query<{ id: string }>('SELECT id FROM item_refund_dispositions WHERE item_id=$1', [
        item.id,
      ])
    )[0];
    if (existing) return existing.id;
    const id = randomUUID();
    const key = `refund:${id}`;
    const zero = BigInt(item.amount) === 0n;
    await sql.query(
      `INSERT INTO item_refund_dispositions(id,item_id,order_id,operation_key,amount_minor,reason,status)
    VALUES($1,$2,$3,$4,$5::numeric,$6,$7) RETURNING id`,
      [id, item.id, item.order_id, key, item.amount, reason, zero ? 'SUCCEEDED' : 'PENDING'],
    );
    if (missing) {
      await sql.query(
        "INSERT INTO stock_dispositions(reservation_id,disposition_id,kind,actor_id,reason) VALUES($1,$2,'MISSING',$3,$4) RETURNING reservation_id",
        [missing.reservationId, id, missing.actor, reason],
      );
      await sql.query(
        "UPDATE reservations SET status='DISPUTED' WHERE id=$1 AND status='ALLOCATED' RETURNING id",
        [missing.reservationId],
      );
    }
    await sql.query(
      "UPDATE order_items SET status='FAILED',disposition='REFUND',next_attempt_at=NULL WHERE id=$1 RETURNING id",
      [item.id],
    );
    await sql.query(
      "UPDATE fulfillment_jobs SET status='CANCELLED' WHERE item_id=$1 RETURNING item_id",
      [item.id],
    );
    if (!zero)
      await sql.query(
        `INSERT INTO outbox(id,kind,aggregate_id,generation,payload) VALUES($1,'RefundRequested',$2,1,$3::jsonb) RETURNING id`,
        [
          randomUUID(),
          id,
          JSON.stringify({
            schemaVersion: 1,
            dispositionId: id,
            operationKey: key,
            orderId: item.order_id,
            itemId: item.id,
            customerId: item.customer_id,
            paymentOperationKey: item.payment_operation_key,
            revision: item.checkout_revision,
            amountMinor: item.amount,
            currency: 'IRR',
            reason,
            correlationId: id,
          }),
        ],
      );
    else await this.releaseAllocation(sql, item.id);
    await this.history(sql, item.order_id, 'ItemRefundRequested', {
      itemId: item.id,
      dispositionId: id,
      amountMinor: item.amount,
      reason,
      zeroValue: zero,
    });
    return id;
  }
  async aggregate(sql: Sql, orderId: string) {
    const order = (
      await sql.query<{ status: string; amount: string; cancellation_requested: boolean }>(
        'SELECT status,total_minor::text AS amount,cancellation_requested FROM orders WHERE id=$1',
        [orderId],
      )
    )[0]!;
    const finance = (
      await sql.query<{ status: string; confirmed: string }>(
        'SELECT status,refunded_minor::text AS confirmed FROM order_financial_projections WHERE order_id=$1',
        [orderId],
      )
    )[0];
    if (finance?.status !== 'SUCCEEDED') return;
    const rows = await sql.query<{
      status: string;
      disposition: string;
      refund_status: string | null;
    }>(
      `SELECT i.status,i.disposition,d.status AS refund_status FROM order_items i LEFT JOIN item_refund_dispositions d ON d.item_id=i.id
    WHERE i.order_id=$1 AND NOT(i.status='CANCELLED' AND i.disposition='CANCEL')`,
      [orderId],
    );
    const requested = (
      await sql.query<{ amount: string }>(
        'SELECT coalesce(sum(amount_minor),0)::text AS amount FROM item_refund_dispositions WHERE order_id=$1',
        [orderId],
      )
    )[0]!.amount;
    const pending = BigInt(requested) - BigInt(finance.confirmed);
    if (pending < 0n) throw new Error('Confirmed return exceeds local refund obligations');
    const allSuccess = rows.length > 0 && rows.every((i) => i.status === 'SUCCEEDED');
    const settled =
      rows.length > 0 &&
      rows.every((i) => i.status === 'SUCCEEDED' || i.refund_status === 'SUCCEEDED');
    const runnable = rows.some(
      (i) =>
        i.disposition === 'FULFILL' && ['PENDING', 'PROCESSING', 'RETRY_WAIT'].includes(i.status),
    );
    const next = order.cancellation_requested
      ? settled
        ? 'CANCELLED'
        : 'CANCELLATION_PENDING'
      : allSuccess
        ? 'COMPLETED'
        : settled
          ? 'RESOLVED'
          : runnable
            ? 'PROCESSING'
            : rows.some((i) => i.status === 'MANUAL_REVIEW')
              ? 'MANUAL_REVIEW'
              : 'ATTENTION_REQUIRED';
    const summary =
      BigInt(finance.confirmed) === 0n
        ? 'NONE'
        : BigInt(finance.confirmed) === BigInt(order.amount)
          ? 'REFUNDED'
          : 'PARTIALLY_REFUNDED';
    await sql.query(
      'UPDATE order_financial_projections SET pending_refund_minor=$2::numeric,pending=$3,summary=$4 WHERE order_id=$1 RETURNING order_id',
      [orderId, pending.toString(), pending > 0n, summary],
    );
    if (next !== order.status) {
      const version = (
        await sql.query<{ workflow_version: number }>(
          'UPDATE orders SET status=$2,workflow_version=workflow_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING workflow_version',
          [orderId, next],
        )
      )[0]!.workflow_version;
      await this.history(sql, orderId, 'OrderStatusChanged', { status: next, version });
      await sql.query(
        "INSERT INTO outbox(id,kind,aggregate_id,generation,payload) VALUES($1,'OrderStatusChanged',$2,$3,$4::jsonb) RETURNING id",
        [
          randomUUID(),
          orderId,
          version,
          JSON.stringify({ schemaVersion: 1, orderId, status: next, correlationId: orderId }),
        ],
      );
    }
    if (settled) {
      const released = await sql.query(
        'UPDATE admission_slots SET released_at=clock_timestamp() WHERE order_id=$1 AND released_at IS NULL RETURNING order_id',
        [orderId],
      );
      if (released.length)
        await sql.query('UPDATE admission_budget SET used=used-1 WHERE id=1 RETURNING id');
    }
  }
}
