import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  InvalidMessage,
  type Envelope,
  type Sql,
} from '../../../../../packages/runtime/src/outbox.js';
import { Settlement } from './settlement.js';
const money = z.string().regex(/^(0|[1-9][0-9]*)$/);
const contract = z
  .object({
    schemaVersion: z.literal(1),
    dispositionId: z.uuid(),
    refundId: z.uuid(),
    operationKey: z.string(),
    orderId: z.uuid(),
    itemId: z.uuid(),
    customerId: z.string(),
    paymentOperationKey: z.string(),
    revision: z.int().positive(),
    amountMinor: money,
    currency: z.literal('IRR'),
    sourceVersion: z.int().positive(),
    status: z.enum(['PENDING', 'PROCESSING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED']),
    financialVersion: z.int().positive(),
    refundedMinor: money,
    pendingRefundMinor: money,
    bankReference: z.string().nullable(),
    correlationId: z.string(),
    log: z
      .object({
        id: z.uuid(),
        type: z.string().max(80),
        metadata: z.record(z.string(), z.unknown()),
        createdAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();
@Injectable()
export class RefundResults {
  constructor(private readonly settlement: Settlement) {}
  async apply(sql: Sql, event: Envelope) {
    const parsed = contract.safeParse(event.payload);
    if (!parsed.success) throw new InvalidMessage('INVALID_REFUND_RESULT');
    const p = parsed.data;
    if (
      event.aggregateId !== p.dispositionId ||
      event.generation !== p.sourceVersion ||
      p.operationKey !== `refund:${p.dispositionId}`
    )
      throw new InvalidMessage('REFUND_RESULT_IDENTITY_MISMATCH');
    const order = (
      await sql.query<{
        customer_id: string;
        payment_operation_key: string;
        checkout_revision: number;
        amount: string;
      }>(
        'SELECT customer_id,payment_operation_key,checkout_revision,total_minor::text AS amount FROM orders WHERE id=$1 FOR UPDATE',
        [p.orderId],
      )
    )[0];
    if (
      !order ||
      order.customer_id !== p.customerId ||
      order.payment_operation_key !== p.paymentOperationKey ||
      order.checkout_revision !== p.revision
    )
      throw new InvalidMessage('REFUND_RESULT_ORDER_MISMATCH');
    await sql.query('SELECT id FROM admission_budget WHERE id=1 FOR UPDATE');
    const d = (
      await sql.query<{
        item_id: string;
        amount: string;
        status: string;
        source_version: number;
        billing_refund_id: string | null;
      }>(
        'SELECT item_id,amount_minor::text AS amount,status,source_version,billing_refund_id FROM item_refund_dispositions WHERE id=$1 AND order_id=$2 FOR UPDATE',
        [p.dispositionId, p.orderId],
      )
    )[0];
    if (
      !d ||
      d.item_id !== p.itemId ||
      d.amount !== p.amountMinor ||
      (d.billing_refund_id && d.billing_refund_id !== p.refundId)
    )
      throw new InvalidMessage('REFUND_RESULT_LINE_MISMATCH');
    const requested = (
      await sql.query<{ amount: string }>(
        'SELECT coalesce(sum(amount_minor),0)::text AS amount FROM item_refund_dispositions WHERE order_id=$1',
        [p.orderId],
      )
    )[0]!.amount;
    if (
      BigInt(p.refundedMinor) > BigInt(requested) ||
      BigInt(p.refundedMinor) + BigInt(p.pendingRefundMinor) > BigInt(order.amount)
    )
      throw new InvalidMessage('REFUND_RESULT_BUDGET_MISMATCH');
    await sql.query(
      'INSERT INTO refund_projection_logs(id,disposition_id,type,metadata,created_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING id',
      [p.log.id, p.dispositionId, p.log.type, JSON.stringify(p.log.metadata), p.log.createdAt],
    );
    if (p.sourceVersion > d.source_version) {
      if (d.status === 'SUCCEEDED' && p.status !== 'SUCCEEDED')
        throw new InvalidMessage('REFUND_TERMINAL_REGRESSION');
      if (p.status === 'SUCCEEDED' && !p.bankReference)
        throw new InvalidMessage('REFUND_REFERENCE_MISSING');
      await sql.query('SELECT id FROM order_items WHERE id=$1 FOR UPDATE', [p.itemId]);
      const product = (
        await sql.query<{ product_id: string }>('SELECT product_id FROM order_items WHERE id=$1', [
          p.itemId,
        ])
      )[0]!.product_id;
      await sql.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [product]);
      await sql.query('SELECT product_id FROM inventory WHERE product_id=$1 FOR UPDATE', [product]);
      await sql.query(
        `UPDATE item_refund_dispositions SET status=$2,source_version=$3,billing_refund_id=$4,bank_reference=$5 WHERE id=$1 RETURNING id`,
        [p.dispositionId, p.status, p.sourceVersion, p.refundId, p.bankReference],
      );
      if (p.status === 'SUCCEEDED') await this.settlement.releaseAllocation(sql, p.itemId);
      await this.settlement.history(sql, p.orderId, `Refund${p.status}`, {
        dispositionId: p.dispositionId,
        itemId: p.itemId,
        sourceVersion: p.sourceVersion,
      });
      if (
        p.status === 'REVIEW_REQUIRED' &&
        !(
          await sql.query(
            "SELECT id FROM review_cases WHERE resource_id=$1 AND reason='REFUND_REQUIRES_REVIEW' AND status='OPEN'",
            [p.dispositionId],
          )
        ).length
      )
        await sql.query(
          "INSERT INTO review_cases(id,resource_id,reason,metadata) VALUES($1,$2,'REFUND_REQUIRES_REVIEW',$3::jsonb) RETURNING id",
          [p.log.id, p.dispositionId, JSON.stringify({ orderId: p.orderId })],
        );
    }
    const previous = (
      await sql.query<{ refund_source_version: number; amount: string }>(
        'SELECT refund_source_version,refunded_minor::text AS amount FROM order_financial_projections WHERE order_id=$1',
        [p.orderId],
      )
    )[0]!;
    if (p.financialVersion > previous.refund_source_version) {
      if (BigInt(p.refundedMinor) < BigInt(previous.amount))
        throw new InvalidMessage('CONFIRMED_REFUND_REGRESSION');
      await sql.query(
        'UPDATE order_financial_projections SET refund_source_version=$2,refunded_minor=$3::numeric,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING order_id',
        [p.orderId, p.financialVersion, p.refundedMinor],
      );
    }
    await this.settlement.aggregate(sql, p.orderId);
  }
}
