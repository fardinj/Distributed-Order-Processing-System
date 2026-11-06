import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BillingDatabase } from './database.js';
import {
  OutboxWorker,
  InvalidMessage,
  type Sql,
  type Envelope,
} from '../../../packages/runtime/src/outbox.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';

const money = z.string().regex(/^(0|[1-9][0-9]*)$/);
const line = z
  .object({
    id: z.uuid(),
    productId: z.uuid(),
    name: z.string().min(1).max(200),
    type: z.enum(['DIGITAL', 'SUBSCRIPTION', 'PHYSICAL']),
    quantity: z.int().min(1).max(100),
    unitPriceMinor: money,
    lineTotalMinor: money,
    subscriptionDays: z.int().positive().nullable(),
  })
  .strict();
const prepared = z
  .object({
    schemaVersion: z.literal(1),
    orderId: z.uuid(),
    customerId: z.string().min(1).max(128),
    revision: z.int().positive(),
    totalMinor: money,
    currency: z.literal('IRR'),
    items: z.array(line).max(50),
    correlationId: z.string().max(80),
  })
  .strict();
const catalogKinds = new Set([
  'ProductCreated',
  'ProductUpdated',
  'ProductDeactivated',
  'InventoryAdjusted',
  'InventoryReconciled',
]);
@Injectable()
export class BillingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly transport: OutboxWorker;
  constructor(db: BillingDatabase) {
    this.transport = new OutboxWorker(
      'billing',
      serviceConfig('billing').rabbit!.url,
      db.store,
      (sql, event) => this.handle(sql, event),
    );
  }
  onModuleInit() {
    this.transport.start();
  }
  onModuleDestroy() {
    return this.transport.stop();
  }
  private async handle(sql: Sql, event: Envelope) {
    if (catalogKinds.has(event.kind)) return;
    if (event.kind !== 'CheckoutPrepared') throw new InvalidMessage('UNSUPPORTED_COMMERCE_EVENT');
    const result = prepared.safeParse(event.payload);
    if (!result.success) throw new InvalidMessage('INVALID_PREPARATION');
    const p = result.data;
    if (
      event.aggregateId !== p.orderId ||
      event.generation !== p.revision ||
      p.items.some(
        (i) =>
          BigInt(i.unitPriceMinor) * BigInt(i.quantity) !== BigInt(i.lineTotalMinor) ||
          (i.type !== 'PHYSICAL' && i.quantity !== 1),
      ) ||
      new Set(p.items.map((i) => i.productId)).size !== p.items.length ||
      p.items.reduce((sum, i) => sum + BigInt(i.lineTotalMinor), 0n) !== BigInt(p.totalMinor)
    )
      throw new InvalidMessage('PREPARATION_SNAPSHOT_MISMATCH');
    const updated = await sql.query(
      `INSERT INTO prepared_checkouts(order_id,customer_id,revision,total_minor,currency,snapshot)
      VALUES($1,$2,$3,$4::numeric,'IRR',$5::jsonb) ON CONFLICT(order_id) DO UPDATE SET revision=EXCLUDED.revision,
      total_minor=EXCLUDED.total_minor,snapshot=EXCLUDED.snapshot,updated_at=clock_timestamp()
      WHERE prepared_checkouts.revision<EXCLUDED.revision AND prepared_checkouts.customer_id=EXCLUDED.customer_id RETURNING order_id`,
      [p.orderId, p.customerId, p.revision, p.totalMinor, JSON.stringify(p.items)],
    );
    if (!updated.length) {
      const existing = await sql.query(
        `SELECT 1 FROM prepared_checkouts WHERE order_id=$1 AND customer_id=$2 AND
        (revision>$3 OR (revision=$3 AND total_minor=$4::numeric AND snapshot=$5::jsonb))`,
        [p.orderId, p.customerId, p.revision, p.totalMinor, JSON.stringify(p.items)],
      );
      if (!existing.length) throw new InvalidMessage('CONFLICTING_PREPARATION_IDENTITY');
      return;
    }
    await sql.query(
      `INSERT INTO outbox(id,kind,aggregate_id,generation,payload)
      VALUES($1,'CheckoutPreparationAcknowledged',$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
      [
        randomUUID(),
        p.orderId,
        p.revision,
        JSON.stringify({
          schemaVersion: 1,
          orderId: p.orderId,
          revision: p.revision,
          sourceVersion: p.revision,
          status: 'PREPARED',
          correlationId: p.correlationId,
        }),
      ],
    );
  }
}
