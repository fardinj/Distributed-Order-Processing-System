import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BillingDatabase } from './database.js';
import { Roles } from '../../../packages/runtime/src/security.js';
import { MetricCache, prometheus } from '../../../packages/runtime/src/metrics.js';
@Controller('internal/metrics')
@Roles('service')
export class BillingMetrics {
  private readonly cache = new MetricCache(async () => {
    const [r] = await this.db.store.query<Record<string, number>>(`SELECT
      (SELECT count(*) FROM outbox WHERE published_at IS NULL)::int AS tops_outbox_pending,
      (SELECT count(*) FROM inbox_messages WHERE status='PENDING')::int AS tops_inbox_pending,
      (SELECT count(*) FROM payments WHERE status IN ('PENDING','PROCESSING','UNKNOWN'))::int AS tops_payments_unresolved,
      (SELECT count(*) FROM payments WHERE status='UNKNOWN')::int AS tops_payment_unknown,
      coalesce((SELECT greatest(0,extract(epoch FROM clock_timestamp()-min(created_at)))::float8 FROM payments WHERE status IN ('PENDING','PROCESSING','UNKNOWN')),0) AS tops_payment_oldest_unresolved_seconds,
      (SELECT count(*) FROM refunds WHERE status<>'SUCCEEDED')::int AS tops_refunds_unconfirmed`);
    return r!;
  });
  constructor(private readonly db: BillingDatabase) {}
  @Get() async get(@Res() response: Response) {
    response.type('text/plain; version=0.0.4').setHeader('cache-control', 'no-store');
    response.send(prometheus('billing', await this.cache.read()));
  }
}
