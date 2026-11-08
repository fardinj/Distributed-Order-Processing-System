import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { bootstrap, RuntimeModule } from '../../../packages/runtime/src/bootstrap.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';
import { CommerceDatabase } from './database.js';
import { CatalogService } from './modules/catalog/catalog.service.js';
import { AdminCatalogController, CatalogController } from './modules/catalog/catalog.controller.js';
import { OrdersController } from './modules/orders/orders.controller.js';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseErrors } from './database-errors.js';
import { CheckoutService } from './modules/orders/checkout.service.js';
import { CommerceWorker } from './worker.js';
import { PaymentResults } from './modules/orders/payment-results.js';
import { Settlement } from './modules/fulfillment/settlement.js';
import { Fulfillment } from './modules/fulfillment/fulfillment.service.js';
import { RefundResults } from './modules/fulfillment/refund-results.js';
import { AdminShortage, FulfillmentReads } from './modules/fulfillment/fulfillment.controller.js';
import { OrderActions, ReviewActions } from './modules/orders/actions.controller.js';
import { AdminOrders } from './modules/orders/admin-orders.controller.js';
import { CommerceMetrics } from './metrics.controller.js';

const config = serviceConfig('commerce');
@Module({
  imports: [RuntimeModule.forRoot(config)],
  providers: [
    CommerceDatabase,
    CatalogService,
    CheckoutService,
    CommerceWorker,
    PaymentResults,
    Settlement,
    Fulfillment,
    RefundResults,
    { provide: APP_FILTER, useClass: DatabaseErrors },
  ],
  controllers: [
    CatalogController,
    AdminCatalogController,
    OrdersController,
    AdminShortage,
    FulfillmentReads,
    OrderActions,
    ReviewActions,
    AdminOrders,
    CommerceMetrics,
  ],
})
class CommerceModule {}

bootstrap(CommerceModule, config).catch(() => {
  logRecord(config.name, 'fatal', 'startup_failed');
  process.exitCode = 1;
});
