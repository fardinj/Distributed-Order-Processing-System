import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  type Principal,
  Roles,
} from '../../../../../packages/runtime/src/security.js';
import { parse, requestKey } from '../../../../../packages/runtime/src/validation.js';
import { CatalogService } from './catalog.service.js';
import { Auxiliary } from '../../../../../packages/runtime/src/auxiliary.js';
import { z } from 'zod';
import {
  adjustSchema,
  createProductSchema,
  deactivateSchema,
  idSchema,
  listSchema,
  reconcileSchema,
  updateProductSchema,
} from './contracts.js';

@Controller('products')
@Roles('customer', 'admin')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly auxiliary: Auxiliary,
  ) {}
  @Get() list(@Query() query: unknown) {
    const input = parse(listSchema, query);
    return this.auxiliary.cached(`list:${input.limit}:${input.cursor ?? ''}`, () =>
      this.catalog.list(input.limit, input.cursor),
    );
  }
  @Get(':id') get(@Param('id') id: string) {
    const productId = parse(idSchema, id);
    return this.auxiliary.cached(`item:${productId}`, () => this.catalog.get(productId));
  }
}

@Controller('admin')
@Roles('admin')
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get('products') list(@Query() query: unknown) {
    const input = parse(listSchema, query);
    return this.catalog.list(input.limit, input.cursor, true);
  }
  @Get('products/:id') get(@Param('id') id: string) {
    return this.catalog.get(parse(idSchema, id), true);
  }
  @Post('products') create(
    @CurrentUser() user: Principal,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.catalog.create(user.id, requestKey(key), parse(createProductSchema, body));
  }
  @Patch('products/:id') update(
    @CurrentUser() user: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.catalog.update(
      user.id,
      parse(idSchema, id),
      requestKey(key),
      parse(updateProductSchema, body),
    );
  }
  @Post('products/:id/deactivate') deactivate(
    @CurrentUser() user: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.catalog.deactivate(
      user.id,
      parse(idSchema, id),
      requestKey(key),
      parse(deactivateSchema, body),
    );
  }
  @Get('products/:id/audit') audit(@Param('id') id: string) {
    return this.catalog.audit(parse(idSchema, id));
  }
  @Post('inventory/:id/adjustments') adjust(
    @CurrentUser() user: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.catalog.stock(
      user.id,
      parse(idSchema, id),
      requestKey(key),
      parse(adjustSchema, body),
    );
  }
  @Post('inventory/:id/reconcile') reconcile(
    @CurrentUser() user: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.catalog.stock(
      user.id,
      parse(idSchema, id),
      requestKey(key),
      parse(reconcileSchema, body),
    );
  }
  @Get('inventory/:id/discrepancies') discrepancies(@Param('id') id: string) {
    return this.catalog.discrepancies(parse(idSchema, id));
  }
  @Get('manual-review') reviews(@Query() query: unknown) {
    const p = parse(
      z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.uuid().optional(),
        })
        .strict(),
      query,
    );
    return this.catalog.reviews(p.limit, p.cursor);
  }
}
