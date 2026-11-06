import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';

@Injectable()
export class CommerceDatabase extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const database = serviceConfig('commerce').database!;
    if (database.max < 2)
      throw new Error('Commerce DB_POOL_MAX needs at least two slots including health');
    super({
      adapter: new PrismaPg({
        ...database,
        max: Math.max(1, database.max - 1),
        connectionTimeoutMillis: 1500,
        idleTimeoutMillis: 10000,
        application_name: 'commerce-domain',
      }),
    });
  }
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
