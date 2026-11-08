import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CommerceDatabase } from './database.js';
import { Roles } from '../../../packages/runtime/src/security.js';
import { MetricCache, prometheus } from '../../../packages/runtime/src/metrics.js';
@Controller()
export class CommerceMetrics {
  private readonly cache = new MetricCache(async () => {
    const [r] = await this.db.store.query<Record<string, number>>(`SELECT
      (SELECT used FROM admission_budget WHERE id=1)::int AS tops_admission_used,
      (SELECT capacity FROM admission_budget WHERE id=1)::int AS tops_admission_capacity,
      (SELECT count(*) FROM outbox WHERE published_at IS NULL)::int AS tops_outbox_pending,
      coalesce((SELECT greatest(0,extract(epoch FROM clock_timestamp()-min(available_at)))::float8 FROM outbox WHERE published_at IS NULL AND available_at<=clock_timestamp()),0) AS tops_outbox_oldest_due_seconds,
      (SELECT count(*) FROM inbox_messages WHERE status='PENDING')::int AS tops_inbox_pending,
      (SELECT count(*) FROM fulfillment_jobs WHERE status IN ('READY','DEFERRED'))::int AS tops_fulfillment_pending,
      (SELECT count(*) FROM order_items WHERE status='RETRY_WAIT')::int AS tops_items_retry_wait,
      (SELECT count(*) FROM review_cases WHERE status='OPEN')::int AS tops_review_open,
      (SELECT count(*) FROM order_financial_projections WHERE status='UNKNOWN')::int AS tops_payment_unknown`);
    return r!;
  });
  constructor(private readonly db: CommerceDatabase) {}
  private async render(response: Response) {
    response.type('text/plain; version=0.0.4').setHeader('cache-control', 'no-store');
    response.send(prometheus('commerce', await this.cache.read()));
  }
  @Get('admin/metrics') @Roles('admin') admin(@Res() response: Response) {
    return this.render(response);
  }
  @Get('internal/metrics') @Roles('service') internal(@Res() response: Response) {
    return this.render(response);
  }
}
