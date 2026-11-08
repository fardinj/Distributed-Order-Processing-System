import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import type { Sql, SqlStore } from '../../../packages/runtime/src/outbox.js';

@Injectable()
export class CommerceDatabase extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly store: SqlStore = {
    query: <T>(sql: string, values: unknown[] = []) => this.$queryRawUnsafe<T[]>(sql, ...values),
    transaction: <T>(work: (sql: Sql) => Promise<T>) =>
      this.$transaction(
        (tx) =>
          work({
            query: <R>(sql: string, values: unknown[] = []) =>
              tx.$queryRawUnsafe<R[]>(sql, ...values),
          }),
        { maxWait: 3000, timeout: 5000 },
      ),
  };
  constructor() {
    const database = serviceConfig('commerce').database!;
    if (database.max < 2)
      throw new Error('Commerce DB_POOL_MAX needs at least two slots including health');
    super({
      adapter: new PrismaPg({
        ...database,
        max: Math.max(1, database.max - 1),
        connectionTimeoutMillis: 1500,
        statement_timeout: 3000,
        lock_timeout: 1000,
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
