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

const config = serviceConfig('commerce');
@Module({
  imports: [RuntimeModule.forRoot(config)],
  providers: [
    CommerceDatabase,
    CatalogService,
    CheckoutService,
    CommerceWorker,
    { provide: APP_FILTER, useClass: DatabaseErrors },
  ],
  controllers: [CatalogController, AdminCatalogController, OrdersController],
})
class CommerceModule {}

bootstrap(CommerceModule, config).catch(() => {
  logRecord(config.name, 'fatal', 'startup_failed');
  process.exitCode = 1;
});
