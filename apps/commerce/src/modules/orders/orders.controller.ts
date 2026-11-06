import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  CurrentUser,
  type Principal,
  Roles,
} from '../../../../../packages/runtime/src/security.js';
import { parse } from '../../../../../packages/runtime/src/validation.js';
import { CommerceDatabase } from '../../database.js';
import { idSchema } from '../catalog/contracts.js';

/** Owner-protected read foundation; full detail/create/retry APIs are the next milestone. */
@Controller('orders')
@Roles('customer', 'admin')
export class OrdersController {
  constructor(private readonly db: CommerceDatabase) {}
  @Get(':id') async get(@Param('id') rawId: string, @CurrentUser() user: Principal) {
    const id = parse(idSchema, rawId);
    const orders = await this.db.$queryRaw<
      {
        id: string;
        customerId: string;
        status: string;
        currency: string;
        totalMinor: string;
        checkoutRevision: number;
      }[]
    >`
      SELECT id,customer_id AS "customerId",status,currency,total_minor::text AS "totalMinor",checkout_revision AS "checkoutRevision"
      FROM orders WHERE id=${id}::uuid AND (customer_id=${user.id} OR ${user.roles.includes('admin')})`;
    if (!orders[0]) throw new NotFoundException('Order not found');
    const items = await this.db.$queryRaw<
      {
        id: string;
        name: string;
        type: string;
        quantity: number;
        unitPriceMinor: string;
        lineTotalMinor: string;
        status: string;
      }[]
    >`
      SELECT id,name,type,quantity,unit_price_minor::text AS "unitPriceMinor",line_total_minor::text AS "lineTotalMinor",status
      FROM order_items WHERE order_id=${id}::uuid ORDER BY id`;
    return { ...orders[0], items };
  }
}
