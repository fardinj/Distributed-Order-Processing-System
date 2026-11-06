import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { bootstrap, RuntimeModule } from '../../../packages/runtime/src/bootstrap.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';
import { BankDatabase } from './database.js';
import { BankCharges, BankChargesController } from './charges.js';

const config = serviceConfig('bank-simulator');
@Module({
  imports: [RuntimeModule.forRoot(config)],
  providers: [BankDatabase, BankCharges],
  controllers: [BankChargesController],
})
class BankSimulatorModule {}

bootstrap(BankSimulatorModule, config).catch(() => {
  logRecord(config.name, 'fatal', 'startup_failed');
  process.exitCode = 1;
});
