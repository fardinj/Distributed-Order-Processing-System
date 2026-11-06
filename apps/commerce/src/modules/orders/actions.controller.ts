import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Headers,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CommerceDatabase } from '../../database.js';
import {
  CurrentUser,
  Roles,
  type Principal,
} from '../../../../../packages/runtime/src/security.js';
import { parse, requestKey, fingerprint } from '../../../../../packages/runtime/src/validation.js';
import type { Sql } from '../../../../../packages/runtime/src/outbox.js';
import { idSchema } from '../catalog/contracts.js';
import { Settlement } from '../fulfillment/settlement.js';

const reason = z.string().trim().min(5).max(1000);
const cancellation = z.object({ expectedVersion: z.int().nonnegative(), reason }).strict();
const retry = z
  .object({
    expectedGeneration: z.int().nonnegative(),
    expectedRetryVersion: z.int().nonnegative(),
    reason,
  })
  .strict();
const page = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  })
  .strict();

async function once<T>(
  sql: Sql,
  actor: string,
  operation: string,
  key: string,
  input: unknown,
  work: () => Promise<T>,
): Promise<T> {
  const hash = fingerprint(input);
  const inserted = await sql.query(
    'INSERT INTO idempotency_records(id,actor_id,operation,key,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
    [randomUUID(), actor, operation, key, hash],
  );
  if (!inserted.length) {
    const old = (
      await sql.query<{ fingerprint: string; response: T }>(
        'SELECT fingerprint,response FROM idempotency_records WHERE actor_id=$1 AND operation=$2 AND key=$3',
        [actor, operation, key],
      )
    )[0]!;
    if (old.fingerprint !== hash) throw new ConflictException('Idempotency key payload differs');
    return old.response;
  }
  const result = await work();
  await sql.query(
    'UPDATE idempotency_records SET response=$4::jsonb WHERE actor_id=$1 AND operation=$2 AND key=$3 RETURNING id',
    [actor, operation, key, JSON.stringify(result)],
  );
  return result;
}
async function audit(
  sql: Sql,
  actor: string,
  id: string,
  action: string,
  reason: string,
  before: unknown,
  after: unknown,
) {
  await sql.query(
    'INSERT INTO audit_logs(id,actor_id,resource_id,action,reason,before,after) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id',
    [randomUUID(), actor, id, action, reason, JSON.stringify(before), JSON.stringify(after)],
  );
}

@Controller('orders')
@Roles('customer', 'admin')
export class OrderActions {
  constructor(
    private readonly db: CommerceDatabase,
    private readonly settlement: Settlement,
  ) {}
  @Post(':id/cancel') async cancel(
    @Param('id') rawId: string,
    @CurrentUser() user: Principal,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() body: unknown,
  ) {
    const id = parse(idSchema, rawId),
      key = requestKey(rawKey),
      input = parse(cancellation, body);
    return this.db.store.transaction(async (sql) => {
      const order = (
        await sql.query<{
          status: string;
          workflow_version: number;
          fulfillment_started_at: Date | null;
          cancellation_requested: boolean;
          payment_operation_key: string | null;
          checkout_revision: number;
        }>(
          'SELECT status,workflow_version,fulfillment_started_at,cancellation_requested,payment_operation_key,checkout_revision FROM orders WHERE id=$1 AND customer_id=$2 FOR UPDATE',
          [id, user.id],
        )
      )[0];
      if (!order) throw new NotFoundException('Order not found');
      return once(sql, user.id, `cancel:${id}`, key, input, async () => {
        if (order.fulfillment_started_at || order.workflow_version !== input.expectedVersion)
          throw new ConflictException('Cancellation cutoff or version conflict');
        if (order.cancellation_requested)
          return { orderId: id, status: order.status, cancellationRequested: true };
        await sql.query('SELECT id FROM admission_budget WHERE id=1 FOR UPDATE');
        let status = 'CANCELLATION_PENDING';
        if (!order.payment_operation_key) {
          const items = await sql.query<{ product_id: string }>(
            'SELECT product_id FROM order_items WHERE order_id=$1 ORDER BY id FOR UPDATE',
            [id],
          );
          const products = [...new Set(items.map((i) => i.product_id))].sort();
          await sql.query(
            'SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
            [products],
          );
          await sql.query(
            'SELECT product_id FROM inventory WHERE product_id=ANY($1::uuid[]) ORDER BY product_id FOR UPDATE',
            [products],
          );
          const holds = await sql.query<{ id: string; product_id: string; quantity: number }>(
            "SELECT r.id,r.product_id,r.quantity FROM reservations r JOIN order_items i ON i.id=r.item_id WHERE i.order_id=$1 AND r.status='ACTIVE' ORDER BY r.id FOR UPDATE OF r",
            [id],
          );
          for (const hold of holds) {
            await sql.query("UPDATE reservations SET status='RELEASED' WHERE id=$1 RETURNING id", [
              hold.id,
            ]);
            await sql.query(
              'UPDATE inventory SET available=CASE WHEN requires_review THEN available ELSE available+$2 END,version=version+1 WHERE product_id=$1 RETURNING product_id',
              [hold.product_id, hold.quantity],
            );
          }
          await sql.query(
            "UPDATE order_items SET status='CANCELLED',disposition='CANCEL' WHERE order_id=$1 RETURNING id",
            [id],
          );
          if (
            (
              await sql.query(
                'UPDATE admission_slots SET released_at=clock_timestamp() WHERE order_id=$1 AND released_at IS NULL RETURNING order_id',
                [id],
              )
            ).length
          )
            await sql.query('UPDATE admission_budget SET used=used-1 WHERE id=1 RETURNING id');
          status = 'CANCELLED';
        } else {
          const finance = (
            await sql.query<{ status: string }>(
              'SELECT status FROM order_financial_projections WHERE order_id=$1',
              [id],
            )
          )[0];
          if (finance?.status === 'FAILED') status = 'CANCELLED';
          // Reuse the immutable original command: Banking must fence any delayed charge before stock is released.
          await sql.query(
            "INSERT INTO outbox(id,kind,aggregate_id,generation,payload) SELECT $1,'PaymentCancellationRequested',aggregate_id,generation,payload FROM outbox WHERE aggregate_id=$2 AND kind='PaymentRequested' RETURNING id",
            [randomUUID(), id],
          );
          await sql.query(
            "UPDATE fulfillment_jobs SET status='CANCELLED' WHERE item_id IN(SELECT id FROM order_items WHERE order_id=$1) AND status IN('READY','DEFERRED') RETURNING item_id",
            [id],
          );
        }
        await sql.query(
          'UPDATE orders SET cancellation_requested=true,status=$2,workflow_version=workflow_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING id',
          [id, status],
        );
        const result = { orderId: id, status, cancellationRequested: true };
        await this.settlement.history(sql, id, 'CancellationRequested', {
          actor: user.id,
          reason: input.reason,
        });
        await audit(sql, user.id, id, 'CancelOrder', input.reason, order, result);
        return result;
      });
    });
  }
  @Post(':id/items/:itemId/retry') async retry(
    @Param('id') rawId: string,
    @Param('itemId') rawItem: string,
    @CurrentUser() user: Principal,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() body: unknown,
  ) {
    const id = parse(idSchema, rawId),
      itemId = parse(idSchema, rawItem),
      key = requestKey(rawKey),
      input = parse(retry, body);
    return this.db.store.transaction(async (sql) => {
      if (
        !(
          await sql.query(
            'SELECT id FROM orders WHERE id=$1 AND (customer_id=$2 OR $3) AND NOT cancellation_requested FOR UPDATE',
            [id, user.id, user.roles.includes('admin')],
          )
        ).length
      )
        throw new NotFoundException('Eligible order not found');
      return once(sql, user.id, `retry:${itemId}`, key, { orderId: id, ...input }, async () => {
        await sql.query('SELECT id FROM admission_budget WHERE id=1 FOR UPDATE');
        const item = (
          await sql.query<{
            status: string;
            generation: number;
            retry_version: number;
            due: boolean;
          }>(
            'SELECT status,generation,retry_version,next_attempt_at<=clock_timestamp() AS due FROM order_items WHERE id=$1 AND order_id=$2 FOR UPDATE',
            [itemId, id],
          )
        )[0];
        if (!item) throw new NotFoundException('Item not found');
        const review =
          user.roles.includes('admin') &&
          item.status === 'MANUAL_REVIEW' &&
          (
            await sql.query(
              "SELECT id FROM review_cases WHERE resource_id=$1 AND reason='RECOVERY_COST' AND status='OPEN'",
              [itemId],
            )
          ).length > 0;
        if (
          item.generation !== input.expectedGeneration ||
          item.retry_version !== input.expectedRetryVersion ||
          !(review || (item.status === 'RETRY_WAIT' && item.due))
        )
          throw new ConflictException('Item is not eligible for a new cycle');
        if (
          !(
            await sql.query(
              "SELECT 1 FROM order_items i JOIN order_financial_projections f ON f.order_id=i.order_id JOIN orders o ON o.id=i.order_id WHERE i.id=$1 AND i.disposition='FULFILL' AND f.status='SUCCEEDED' AND f.revision=o.checkout_revision AND NOT EXISTS(SELECT 1 FROM item_refund_dispositions d WHERE d.item_id=i.id)",
              [itemId],
            )
          ).length
        )
          throw new ConflictException('Paid unresolved fulfillment required');
        await sql.query(
          "UPDATE order_items SET status='RETRY_WAIT',retry_version=retry_version+1,cycle_start_attempt=attempt_count,recovery_started_at=NULL,next_attempt_at=clock_timestamp(),infrastructure_failures=0 WHERE id=$1 RETURNING id",
          [itemId],
        );
        await sql.query(
          "UPDATE fulfillment_jobs SET status='READY',available_at=clock_timestamp() WHERE item_id=$1 RETURNING item_id",
          [itemId],
        );
        await sql.query(
          "UPDATE review_cases SET status='RESOLVED' WHERE resource_id=$1 AND reason='RECOVERY_COST' AND status='OPEN' RETURNING id",
          [itemId],
        );
        const result = {
          orderId: id,
          itemId,
          retryVersion: item.retry_version + 1,
          status: 'RETRY_WAIT',
        };
        await audit(sql, user.id, itemId, 'ManualRetryCycle', input.reason, item, result);
        await this.settlement.history(sql, id, 'ManualRetryCycle', {
          ...result,
          actor: user.id,
          reason: input.reason,
        });
        await this.settlement.aggregate(sql, id);
        return result;
      });
    });
  }
  @Get(':id/items/:itemId/attempts') async attempts(
    @Param('id') rawId: string,
    @Param('itemId') rawItem: string,
    @CurrentUser() user: Principal,
    @Query() rawPage: unknown,
  ) {
    const id = parse(idSchema, rawId),
      itemId = parse(idSchema, rawItem),
      p = parse(page, rawPage);
    if (
      !(
        await this.db.store.query(
          'SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.id=$1 AND i.id=$2 AND (o.customer_id=$3 OR $4)',
          [id, itemId, user.id, user.roles.includes('admin')],
        )
      ).length
    )
      throw new NotFoundException('Item not found');
    if (
      p.cursor &&
      !(
        await this.db.store.query(
          'SELECT id FROM fulfillment_attempts WHERE id=$1 AND item_id=$2',
          [p.cursor, itemId],
        )
      ).length
    )
      throw new NotFoundException('Attempt cursor not found');
    const rows = await this.db.store.query(
      'SELECT id,attempt,result,reason,created_at AS "createdAt" FROM fulfillment_attempts WHERE item_id=$1 AND ($2::uuid IS NULL OR attempt>(SELECT attempt FROM fulfillment_attempts WHERE id=$2 AND item_id=$1)) ORDER BY attempt LIMIT $3',
      [itemId, p.cursor ?? null, p.limit + 1],
    );
    return {
      items: rows.slice(0, p.limit),
      nextCursor: rows.length > p.limit ? rows[p.limit - 1]!.id : null,
    };
  }
}

@Controller('admin/manual-review')
@Roles('admin')
export class ReviewActions {
  constructor(private readonly db: CommerceDatabase) {}
  @Get(':id') async inspect(@Param('id') rawId: string) {
    const id = parse(idSchema, rawId);
    const record = (await this.db.store.query('SELECT * FROM review_cases WHERE id=$1', [id]))[0];
    if (!record) throw new NotFoundException('Review not found');
    const item =
      (
        await this.db.store.query(
          'SELECT id,order_id AS "orderId",status,disposition,generation,retry_version AS "retryVersion",attempt_count AS "attemptCount",next_attempt_at AS "nextAttemptAt" FROM order_items WHERE id=$1',
          [record.resource_id],
        )
      )[0] ?? null;
    const refund =
      (
        await this.db.store.query(
          'SELECT id,order_id AS "orderId",item_id AS "itemId",status,source_version AS "sourceVersion",amount_minor::text AS "amountMinor",operation_key AS "operationKey" FROM item_refund_dispositions WHERE id=$1',
          [record.resource_id],
        )
      )[0] ?? null;
    return {
      ...record,
      item,
      refund,
      actions:
        record.reason === 'RECOVERY_COST'
          ? ['RETRY_CYCLE']
          : record.reason === 'STOCK_REQUIRES_DISPOSITION'
            ? ['SHORTAGE_DISPOSITION']
            : ['INSPECT_ONLY'],
    };
  }
}
