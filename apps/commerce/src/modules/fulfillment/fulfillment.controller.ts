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
import { idSchema } from '../catalog/contracts.js';
import { Settlement, type WorkItem } from './settlement.js';
import { workFields } from './fulfillment.service.js';
const page = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  })
  .strict();
const shortage = z
  .object({ expectedGeneration: z.int().nonnegative(), reason: z.string().min(5).max(1000) })
  .strict();
@Controller('orders')
@Roles('customer', 'admin')
export class FulfillmentReads {
  constructor(private readonly db: CommerceDatabase) {}
  private async authorize(orderId: string, user: Principal) {
    if (
      !(
        await this.db.store.query('SELECT id FROM orders WHERE id=$1 AND (customer_id=$2 OR $3)', [
          orderId,
          user.id,
          user.roles.includes('admin'),
        ])
      ).length
    )
      throw new NotFoundException('Order not found');
  }
  @Get(':id/refunds') async refunds(
    @Param('id') id: string,
    @CurrentUser() user: Principal,
    @Query() query: unknown,
  ) {
    id = parse(idSchema, id);
    const p = parse(page, query);
    await this.authorize(id, user);
    if (
      p.cursor &&
      !(
        await this.db.store.query(
          'SELECT id FROM item_refund_dispositions WHERE id=$1 AND order_id=$2',
          [p.cursor, id],
        )
      ).length
    )
      throw new NotFoundException('Refund cursor not found');
    const rows = await this.db.store.query(
      `SELECT id,item_id AS "itemId",operation_key AS "operationKey",amount_minor::text AS "amountMinor",reason,status,source_version AS "sourceVersion",billing_refund_id AS "billingRefundId",bank_reference AS "bankReference" FROM item_refund_dispositions WHERE order_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,
      [id, p.cursor ?? null, p.limit + 1],
    );
    return {
      items: rows.slice(0, p.limit),
      nextCursor: rows.length > p.limit ? rows[p.limit - 1]!.id : null,
    };
  }
  @Get(':id/refunds/:dispositionId/logs') async logs(
    @Param('id') id: string,
    @Param('dispositionId') d: string,
    @CurrentUser() user: Principal,
    @Query() query: unknown,
  ) {
    id = parse(idSchema, id);
    d = parse(idSchema, d);
    const p = parse(page, query);
    await this.authorize(id, user);
    if (
      !(
        await this.db.store.query(
          'SELECT id FROM item_refund_dispositions WHERE id=$1 AND order_id=$2',
          [d, id],
        )
      ).length
    )
      throw new NotFoundException('Refund not found');
    if (
      p.cursor &&
      !(
        await this.db.store.query(
          'SELECT id FROM refund_projection_logs WHERE id=$1 AND disposition_id=$2',
          [p.cursor, d],
        )
      ).length
    )
      throw new NotFoundException('Log cursor not found');
    const rows = await this.db.store.query(
      `SELECT id,type,metadata,created_at AS "createdAt" FROM refund_projection_logs WHERE disposition_id=$1 AND ($2::uuid IS NULL OR (created_at,id)>(SELECT created_at,id FROM refund_projection_logs WHERE id=$2::uuid AND disposition_id=$1)) ORDER BY created_at,id LIMIT $3`,
      [d, p.cursor ?? null, p.limit + 1],
    );
    return {
      items: rows.slice(0, p.limit),
      nextCursor: rows.length > p.limit ? rows[p.limit - 1]!.id : null,
    };
  }
}
@Controller('admin/orders')
@Roles('admin')
export class AdminShortage {
  constructor(
    private readonly db: CommerceDatabase,
    private readonly settlement: Settlement,
  ) {}
  @Post(':id/items/:itemId/shortage') async resolve(
    @Param('id') orderId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() actor: Principal,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() body: unknown,
  ) {
    orderId = parse(idSchema, orderId);
    itemId = parse(idSchema, itemId);
    const key = requestKey(rawKey);
    const input = parse(shortage, body);
    const hash = fingerprint({ orderId, itemId, ...input });
    return this.db.store.transaction(async (sql) => {
      const operation = `shortage:${itemId}`;
      const claim = await sql.query(
        'INSERT INTO idempotency_records(id,actor_id,operation,key,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
        [randomUUID(), actor.id, operation, key, hash],
      );
      if (!claim.length) {
        const old = (
          await sql.query<{ fingerprint: string; response: unknown }>(
            'SELECT fingerprint,response FROM idempotency_records WHERE actor_id=$1 AND operation=$2 AND key=$3',
            [actor.id, operation, key],
          )
        )[0]!;
        if (old.fingerprint !== hash)
          throw new ConflictException('Idempotency key payload differs');
        return old.response;
      }
      if (!(await sql.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [orderId])).length)
        throw new NotFoundException('Order not found');
      await sql.query('SELECT id FROM admission_budget WHERE id=1 FOR UPDATE');
      const item = (
        await sql.query<WorkItem>(
          `SELECT ${workFields} FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=$1 AND o.id=$2 FOR UPDATE OF i`,
          [itemId, orderId],
        )
      )[0];
      if (!item) throw new NotFoundException('Item not found');
      if (
        item.type !== 'PHYSICAL' ||
        item.status === 'SUCCEEDED' ||
        item.disposition !== 'FULFILL' ||
        item.generation !== input.expectedGeneration
      )
        throw new ConflictException('Line cannot enter shortage refund resolution');
      if (
        !(
          await sql.query(
            "SELECT 1 FROM order_financial_projections WHERE order_id=$1 AND status='SUCCEEDED'",
            [orderId],
          )
        ).length
      )
        throw new ConflictException('Shortage refund requires captured payment');
      await sql.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [item.product_id]);
      await sql.query('SELECT product_id FROM inventory WHERE product_id=$1 FOR UPDATE', [
        item.product_id,
      ]);
      const hold = (
        await sql.query<{ id: string }>(
          `SELECT r.id FROM reservations r JOIN inventory v ON v.product_id=r.product_id WHERE r.item_id=$1 AND r.status='ALLOCATED' AND v.requires_review
     AND EXISTS(SELECT 1 FROM inventory_discrepancies d,jsonb_array_elements(d.affected_reservations) e WHERE d.product_id=r.product_id AND d.status='OPEN' AND e->>'id'=r.id::text) FOR UPDATE OF r`,
          [itemId],
        )
      )[0];
      if (!hold) throw new ConflictException('A recorded paid stock discrepancy is required');
      const dispositionId = await this.settlement.refund(sql, item, input.reason, {
        reservationId: hold.id,
        actor: actor.id,
      });
      await sql.query(
        "UPDATE review_cases SET status='RESOLVED' WHERE resource_id=$1 AND reason='STOCK_REQUIRES_DISPOSITION' AND status='OPEN' RETURNING id",
        [itemId],
      );
      const result = { orderId, itemId, dispositionId, status: 'REFUND_PENDING' };
      await sql.query(
        'INSERT INTO audit_logs(id,actor_id,resource_id,action,reason,before,after) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id',
        [
          randomUUID(),
          actor.id,
          itemId,
          'PaidStockShortageDisposition',
          input.reason,
          JSON.stringify({
            status: item.status,
            generation: item.generation,
            reservationId: hold.id,
          }),
          JSON.stringify(result),
        ],
      );
      await sql.query(
        'UPDATE idempotency_records SET response=$4::jsonb WHERE actor_id=$1 AND operation=$2 AND key=$3 RETURNING id',
        [actor.id, operation, key, JSON.stringify(result)],
      );
      await this.settlement.aggregate(sql, orderId);
      return result;
    });
  }
}
