import { Controller, Get, Query, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { CommerceDatabase } from '../../database.js';
import { Roles } from '../../../../../packages/runtime/src/security.js';
import { parse } from '../../../../../packages/runtime/src/validation.js';
const page = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
    query: z.uuid().optional(),
  })
  .strict();
@Controller('admin/orders')
@Roles('admin')
export class AdminOrders {
  constructor(private readonly db: CommerceDatabase) {}
  @Get() async list(@Query() raw: unknown) {
    const p = parse(page, raw);
    if (
      p.cursor &&
      !(await this.db.store.query('SELECT id FROM orders WHERE id=$1', [p.cursor])).length
    )
      throw new NotFoundException('Order cursor not found');
    const rows = await this.db.store.query(
      `SELECT o.id,o.customer_id AS "customerId",o.status,o.currency,o.total_minor::text AS "totalMinor",o.created_at AS "createdAt"
      FROM orders o WHERE ($1::uuid IS NULL OR (o.created_at,o.id)>(SELECT created_at,id FROM orders WHERE id=$1))
      AND ($2::uuid IS NULL OR o.id=$2 OR o.customer_id=$2::text OR EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.id=$2)) ORDER BY o.created_at,o.id LIMIT $3`,
      [p.cursor ?? null, p.query ?? null, p.limit + 1],
    );
    return {
      items: rows.slice(0, p.limit),
      nextCursor: rows.length > p.limit ? rows[p.limit - 1]!.id : null,
    };
  }
}
