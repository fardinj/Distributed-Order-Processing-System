import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';
import { CommerceDatabase } from './database.js';
import { CheckoutService } from './modules/orders/checkout.service.js';
import {
  OutboxWorker,
  InvalidMessage,
  type Sql,
  type Envelope,
} from '../../../packages/runtime/src/outbox.js';
import { serviceConfig } from '../../../packages/runtime/src/config.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';
import { PaymentResults } from './modules/orders/payment-results.js';
import { RefundResults } from './modules/fulfillment/refund-results.js';

const ack = z
  .object({
    schemaVersion: z.literal(1),
    orderId: z.uuid(),
    revision: z.int().positive(),
    sourceVersion: z.int().positive(),
    status: z.literal('PREPARED'),
    correlationId: z.string().max(80),
  })
  .strict();
@Injectable()
export class CommerceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly transport: OutboxWorker;
  private timer?: ReturnType<typeof setInterval>;
  private expiring?: Promise<void>;
  constructor(
    db: CommerceDatabase,
    private readonly checkout: CheckoutService,
    private readonly payments: PaymentResults,
    private readonly refunds: RefundResults,
  ) {
    this.transport = new OutboxWorker(
      'commerce',
      serviceConfig('commerce').rabbit!.url,
      db.store,
      (sql, event) => this.handle(sql, event),
    );
  }
  onModuleInit() {
    this.transport.start();
    this.timer = setInterval(() => {
      this.expiring ??= this.checkout
        .expireBatch()
        .catch(() => {
          logRecord('commerce', 'warn', 'checkout_expiry_deferred');
        })
        .finally(() => {
          this.expiring = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.expiring;
    await this.transport.stop();
  }
  private async handle(sql: Sql, event: Envelope) {
    if (event.kind === 'RefundStatusChanged') return this.refunds.apply(sql, event);
    if (event.kind === 'PaymentStatusChanged') return this.payments.apply(sql, event);
    if (event.kind !== 'CheckoutPreparationAcknowledged')
      throw new InvalidMessage('UNSUPPORTED_BILLING_EVENT');
    const parsed = ack.safeParse(event.payload);
    if (!parsed.success) throw new InvalidMessage('INVALID_PREPARATION_ACK');
    const value = parsed.data;
    if (
      event.aggregateId !== value.orderId ||
      event.generation !== value.revision ||
      value.sourceVersion !== value.revision
    )
      throw new InvalidMessage('ACK_IDENTITY_MISMATCH');
    const orders = await sql.query<{ checkout_revision: number }>(
      'SELECT checkout_revision FROM orders WHERE id=$1 FOR UPDATE',
      [value.orderId],
    );
    if (!orders[0] || value.revision > orders[0].checkout_revision)
      throw new InvalidMessage('UNKNOWN_CHECKOUT_REVISION');
    await sql.query(
      `UPDATE orders SET preparation_version=GREATEST(preparation_version,$2)
      WHERE id=$1 AND checkout_revision>=$2 RETURNING id`,
      [value.orderId, value.sourceVersion],
    );
  }
}
