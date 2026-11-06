import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  type Principal,
  Roles,
} from '../../../../../packages/runtime/src/security.js';
import { parse, requestKey } from '../../../../../packages/runtime/src/validation.js';
import { idSchema } from '../catalog/contracts.js';
import { createOrderSchema, revisionSchema, orderListSchema } from './contracts.js';
import { CheckoutService } from './checkout.service.js';

@Controller('orders')
@Roles('customer', 'admin')
export class OrdersController {
  constructor(private readonly checkout: CheckoutService) {}
  @Post() create(
    @CurrentUser() user: Principal,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') correlationId: string,
    @Body() body: unknown,
  ) {
    const input = parse(createOrderSchema, body);
    return this.checkout.create(user.id, requestKey(key), input.items, correlationId);
  }
  @Get() list(@CurrentUser() user: Principal, @Query() query: unknown) {
    const input = parse(orderListSchema, query);
    return this.checkout.list(user.id, input.limit, input.cursor);
  }
  @Get(':id') get(@Param('id') id: string, @CurrentUser() user: Principal) {
    return this.checkout.get(parse(idSchema, id), user.id, user.roles.includes('admin'));
  }
  @Post(':id/checkout/refresh') refresh(
    @Param('id') id: string,
    @CurrentUser() user: Principal,
    @Body() body: unknown,
    @Headers('x-request-id') correlationId: string,
  ) {
    return this.checkout.refresh(
      parse(idSchema, id),
      user.id,
      parse(revisionSchema, body).expectedRevision,
      correlationId,
    );
  }
  @Post(':id/payment') pay(
    @Param('id') id: string,
    @CurrentUser() user: Principal,
    @Body() body: unknown,
    @Headers('x-request-id') correlationId: string,
  ) {
    return this.checkout.enterPayment(
      parse(idSchema, id),
      user.id,
      parse(revisionSchema, body).expectedRevision,
      correlationId,
    );
  }
  @Post(':id/checkout/confirm') confirm(
    @Param('id') id: string,
    @CurrentUser() user: Principal,
    @Body() body: unknown,
  ) {
    return this.checkout.confirm(
      parse(idSchema, id),
      user.id,
      parse(revisionSchema, body).expectedRevision,
    );
  }
}
