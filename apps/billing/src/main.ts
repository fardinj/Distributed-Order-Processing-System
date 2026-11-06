import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { bootstrap, RuntimeModule } from '../../../packages/runtime/src/bootstrap.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';

const config = serviceConfig('billing');
@Module({ imports: [RuntimeModule.forRoot(config)] })
class BillingModule {}

bootstrap(BillingModule, config).catch(() => {
  logRecord(config.name, 'fatal', 'startup_failed');
  process.exitCode = 1;
});
