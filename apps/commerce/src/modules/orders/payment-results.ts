import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  InvalidMessage,
  type Envelope,
  type Sql,
} from '../../../../../packages/runtime/src/outbox.js';

const result = z
  .object({
    schemaVersion: z.literal(1),
    orderId: z.uuid(),
    customerId: z.string().max(128),
    operationKey: z.string().max(150),
    revision: z.int().positive().max(2147483647),
    amountMinor: z.string().regex(/^(0|[1-9][0-9]*)$/),
    currency: z.literal('IRR'),
    sourceVersion: z.int().positive().max(2147483647),
    status: z.enum(['PENDING', 'PROCESSING', 'UNKNOWN', 'SUCCEEDED', 'FAILED']),
    bankReference: z.string().max(200).nullable(),
    bankDeadlineAt: z.iso.datetime().nullable(),
    reason: z.string().max(80),
    correlationId: z.string().max(80),
  })
  .strict();
@Injectable()
export class PaymentResults {
  async apply(sql: Sql, event: Envelope) {
    const parsed = result.safeParse(event.payload);
    if (!parsed.success) throw new InvalidMessage('INVALID_PAYMENT_RESULT');
    const p = parsed.data;
    if (
      event.aggregateId !== p.orderId ||
      event.generation !== p.sourceVersion ||
      p.operationKey !== `payment:${p.orderId}`
    )
      throw new InvalidMessage('PAYMENT_RESULT_IDENTITY_MISMATCH');
    const order = (
      await sql.query<{
        customer_id: string;
        checkout_revision: number;
        payment_version: number;
        payment_operation_key: string | null;
        amount: string;
        cancellation_requested: boolean;
      }>(
        'SELECT customer_id,checkout_revision,payment_version,payment_operation_key,total_minor::text AS amount,cancellation_requested FROM orders WHERE id=$1 FOR UPDATE',
        [p.orderId],
      )
    )[0];
    if (
      !order ||
      order.payment_operation_key !== p.operationKey ||
      order.customer_id !== p.customerId ||
      order.checkout_revision !== p.revision ||
      order.amount !== p.amountMinor
    )
      throw new InvalidMessage('PAYMENT_RESULT_SNAPSHOT_MISMATCH');
    if (p.sourceVersion <= order.payment_version) return;
    const previous = (
      await sql.query<{ status: string }>(
        'SELECT status FROM order_financial_projections WHERE order_id=$1',
        [p.orderId],
      )
    )[0];
    if (
      previous &&
      ['SUCCEEDED', 'FAILED'].includes(previous.status) &&
      previous.status !== p.status
    )
      throw new InvalidMessage('PAYMENT_RESULT_TERMINAL_REGRESSION');
    if (p.status === 'SUCCEEDED' && !p.bankReference)
      throw new InvalidMessage('MISSING_BANK_REFERENCE');
    const final = p.status === 'SUCCEEDED' || p.status === 'FAILED';
    if (final) {
      await sql.query('SELECT id FROM admission_budget WHERE id=1 FOR UPDATE');
      const items = await sql.query<{ id: string; product_id: string }>(
        "SELECT id,product_id FROM order_items WHERE order_id=$1 AND status<>'CANCELLED' ORDER BY id FOR UPDATE",
        [p.orderId],
      );
      const ids = items.map((i) => i.product_id);
      await sql.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
        ids,
      ]);
      await sql.query(
        'SELECT product_id FROM inventory WHERE product_id=ANY($1::uuid[]) ORDER BY product_id FOR UPDATE',
        [ids],
      );
      const holds = await sql.query<{ id: string; product_id: string; quantity: number }>(
        `SELECT r.id,r.product_id,r.quantity FROM reservations r JOIN order_items i ON i.id=r.item_id
      WHERE i.order_id=$1 AND r.status='PAYMENT_PENDING' ORDER BY r.id FOR UPDATE OF r`,
        [p.orderId],
      );
      if (p.status === 'SUCCEEDED') {
        for (const hold of holds)
          await sql.query(
            "UPDATE reservations SET status='ALLOCATED' WHERE id=$1 AND status='PAYMENT_PENDING' RETURNING id",
            [hold.id],
          );
        if (order.cancellation_requested)
          await sql.query(
            `UPDATE fulfillment_jobs SET status='CANCELLED' WHERE item_id IN
          (SELECT id FROM order_items WHERE order_id=$1) AND status IN ('READY','DEFERRED') RETURNING item_id`,
            [p.orderId],
          );
        if (!order.cancellation_requested)
          for (const item of items)
            await sql.query(
              'INSERT INTO fulfillment_jobs(item_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING item_id',
              [item.id],
            );
      } else {
        for (const hold of holds) {
          await sql.query(
            "UPDATE reservations SET status='RELEASED' WHERE id=$1 AND status='PAYMENT_PENDING' RETURNING id",
            [hold.id],
          );
          await sql.query(
            `UPDATE inventory SET available=CASE WHEN requires_review THEN available ELSE available+$2 END,
          version=version+1,updated_at=clock_timestamp() WHERE product_id=$1 RETURNING product_id`,
            [hold.product_id, hold.quantity],
          );
        }
        const released = await sql.query(
          'UPDATE admission_slots SET released_at=clock_timestamp() WHERE order_id=$1 AND released_at IS NULL RETURNING order_id',
          [p.orderId],
        );
        if (released.length)
          await sql.query('UPDATE admission_budget SET used=used-1 WHERE id=1 RETURNING id');
      }
    }
    const status =
      p.status === 'SUCCEEDED'
        ? order.cancellation_requested
          ? 'CANCELLATION_PENDING'
          : 'PROCESSING'
        : p.status === 'FAILED'
          ? order.cancellation_requested
            ? 'CANCELLED'
            : 'PAYMENT_FAILED'
          : order.cancellation_requested
            ? 'CANCELLATION_PENDING'
            : p.status === 'UNKNOWN'
              ? 'PAYMENT_REVIEW'
              : 'PAYING';
    await sql.query(
      'UPDATE orders SET status=$2,payment_version=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING id',
      [p.orderId, status, p.sourceVersion],
    );
    await sql.query(
      `UPDATE order_financial_projections SET source_version=$2,status=$3,pending=$4,operation_key=$5,
    bank_reference=$6,bank_deadline_at=$7,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING order_id`,
      [
        p.orderId,
        p.sourceVersion,
        p.status,
        !final,
        p.operationKey,
        p.bankReference,
        p.bankDeadlineAt,
      ],
    );
    await sql.query(
      'INSERT INTO order_events(id,order_id,type,metadata) VALUES($1,$2,$3,$4::jsonb) RETURNING id',
      [
        randomUUID(),
        p.orderId,
        `Payment${p.status}`,
        JSON.stringify({
          sourceVersion: p.sourceVersion,
          reason: p.reason,
          bankReference: p.bankReference,
          correlationId: p.correlationId,
        }),
      ],
    );
  }
}
