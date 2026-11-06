import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { bootstrap, RuntimeModule } from '../../../packages/runtime/src/bootstrap.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';
import { BillingDatabase } from './database.js';
import { BillingWorker } from './worker.js';
import { Payments } from './payments.js';

const config = serviceConfig('billing');
@Module({
  imports: [RuntimeModule.forRoot(config)],
  providers: [BillingDatabase, BillingWorker, Payments],
})
class BillingModule {}

bootstrap(BillingModule, config).catch(() => {
  logRecord(config.name, 'fatal', 'startup_failed');
  process.exitCode = 1;
});
