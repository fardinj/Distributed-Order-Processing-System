import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CommerceDatabase } from '../../database.js';
import type { Sql } from '../../../../../packages/runtime/src/outbox.js';
import { logRecord } from '../../../../../packages/runtime/src/logger.js';
import { Settlement, type WorkItem } from './settlement.js';
import { fulfillDigital } from './processors/digital.js';
import { fulfillSubscription } from './processors/subscription.js';
import { fulfillPhysical } from './processors/physical.js';
import { Auxiliary } from '../../../../../packages/runtime/src/auxiliary.js';
export const workFields =
  'i.id,i.order_id,i.product_id,i.type,i.quantity,i.subscription_days,i.line_total_minor::text AS amount,i.status,i.disposition,i.generation,i.attempt_count,o.customer_id,o.checkout_revision,o.payment_operation_key,o.cancellation_requested';
@Injectable()
export class Fulfillment implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(
    private readonly db: CommerceDatabase,
    private readonly settlement: Settlement,
    private readonly auxiliary: Auxiliary,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      this.active ??= this.auxiliary
        .overlap('commerce-fulfillment', () => this.tick())
        .catch(() => logRecord('commerce', 'warn', 'fulfillment_deferred'))
        .finally(() => {
          this.active = undefined;
        });
    }, 500);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.active;
  }
  async locks(sql: Sql, item: WorkItem) {
    await sql.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [item.product_id]);
    await sql.query('SELECT product_id FROM inventory WHERE product_id=$1 FOR UPDATE', [
      item.product_id,
    ]);
  }
  private async process(id: string, orderId: string) {
    await this.db.store.transaction(async (sql) => {
      if (
        !(await sql.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE SKIP LOCKED', [orderId]))
          .length
      )
        return;
      await sql.query('SELECT id FROM admission_budget WHERE id=1 FOR UPDATE');
      const item = (
        await sql.query<WorkItem>(
          `SELECT ${workFields} FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=$1 FOR UPDATE OF i`,
          [id],
        )
      )[0]!;
      const recovery = (
        await sql.query<{ cycle_start_attempt: number; costly: boolean }>(
          "SELECT cycle_start_attempt,(attempt_count-cycle_start_attempt>=12 AND recovery_started_at<clock_timestamp()-interval '30 minutes') AS costly FROM order_items WHERE id=$1",
          [id],
        )
      )[0]!;
      const job = (
        await sql.query<{ status: string; generation: number }>(
          `SELECT status,generation FROM fulfillment_jobs WHERE item_id=$1 AND available_at<=clock_timestamp() AND status IN ('READY','DEFERRED') FOR UPDATE`,
          [id],
        )
      )[0];
      if (!job) return;
      if (process.memoryUsage().rss > 512 * 1024 * 1024) {
        await sql.query(
          "UPDATE fulfillment_jobs SET available_at=clock_timestamp()+interval '60 seconds' WHERE item_id=$1 RETURNING item_id",
          [id],
        );
        return;
      }
      if (
        item.status === 'SUCCEEDED' ||
        item.disposition !== 'FULFILL' ||
        job.generation !== item.generation
      ) {
        await sql.query(
          'UPDATE fulfillment_jobs SET status=$2 WHERE item_id=$1 RETURNING item_id',
          [id, item.status === 'SUCCEEDED' ? 'DONE' : 'CANCELLED'],
        );
        return;
      }
      if (
        !(
          await sql.query(
            "SELECT 1 FROM order_financial_projections WHERE order_id=$1 AND status='SUCCEEDED' AND revision=$2",
            [orderId, item.checkout_revision],
          )
        ).length
      ) {
        await sql.query(
          "UPDATE fulfillment_jobs SET available_at=clock_timestamp()+interval '5 seconds' WHERE item_id=$1 RETURNING item_id",
          [id],
        );
        return;
      }
      await this.locks(sql, item);
      if (item.cancellation_requested) {
        await this.settlement.refund(sql, item, 'Accepted cancellation before fulfillment');
        await this.settlement.aggregate(sql, orderId);
        return;
      }
      const rule = (
        await sql.query<{ outcome: string; fail_until_attempt: number; due: boolean }>(
          'SELECT outcome,fail_until_attempt,not_before<=clock_timestamp() AS due FROM fulfillment_simulation_rules WHERE item_id=$1',
          [id],
        )
      )[0];
      if (rule && !rule.due) {
        await sql.query(
          'UPDATE fulfillment_jobs SET available_at=(SELECT not_before FROM fulfillment_simulation_rules WHERE item_id=$1) WHERE item_id=$1 RETURNING item_id',
          [id],
        );
        return;
      }
      if (
        item.type === 'PHYSICAL' &&
        ((
          await sql.query('SELECT 1 FROM inventory WHERE product_id=$1 AND requires_review', [
            item.product_id,
          ])
        ).length ||
          !(
            await sql.query(
              "SELECT 1 FROM reservations WHERE item_id=$1 AND status='ALLOCATED' AND quantity=$2",
              [id, item.quantity],
            )
          ).length)
      ) {
        await sql.query("UPDATE order_items SET status='MANUAL_REVIEW' WHERE id=$1 RETURNING id", [
          id,
        ]);
        await sql.query(
          "UPDATE fulfillment_jobs SET status='DEFERRED',available_at=clock_timestamp()+interval '60 seconds' WHERE item_id=$1 RETURNING item_id",
          [id],
        );
        if (
          !(
            await sql.query(
              "SELECT id FROM review_cases WHERE resource_id=$1 AND reason='STOCK_REQUIRES_DISPOSITION' AND status='OPEN'",
              [id],
            )
          ).length
        )
          await sql.query(
            "INSERT INTO review_cases(id,resource_id,reason,metadata) VALUES($1,$2,'STOCK_REQUIRES_DISPOSITION',$3::jsonb) RETURNING id",
            [randomUUID(), id, JSON.stringify({ orderId, productId: item.product_id })],
          );
        await this.settlement.aggregate(sql, orderId);
        return;
      }
      if (recovery.costly && item.status === 'RETRY_WAIT') {
        await sql.query(
          "UPDATE order_items SET status='MANUAL_REVIEW',next_attempt_at=NULL,retry_version=retry_version+1 WHERE id=$1 RETURNING id",
          [id],
        );
        await sql.query(
          "UPDATE fulfillment_jobs SET status='CANCELLED' WHERE item_id=$1 RETURNING item_id",
          [id],
        );
        await sql.query(
          "INSERT INTO review_cases(id,resource_id,reason,metadata) VALUES($1,$2,'RECOVERY_COST',$3::jsonb) RETURNING id",
          [
            randomUUID(),
            id,
            JSON.stringify({
              orderId,
              attempts: item.attempt_count,
              policy: 'At least 12 failed attempts over at least 30 minutes without item progress',
            }),
          ],
        );
        await this.settlement.history(sql, orderId, 'RecoveryReviewRequired', {
          itemId: id,
          reason: 'RECOVERY_COST',
        });
        await this.settlement.aggregate(sql, orderId);
        return;
      }
      item.attempt_count++;
      await sql.query(
        'UPDATE orders SET fulfillment_started_at=coalesce(fulfillment_started_at,clock_timestamp()) WHERE id=$1 RETURNING id',
        [orderId],
      );
      await sql.query(
        "UPDATE order_items SET status='PROCESSING',attempt_count=attempt_count+1,retry_version=retry_version+1,recovery_started_at=coalesce(recovery_started_at,clock_timestamp()),infrastructure_failures=0 WHERE id=$1 RETURNING id",
        [id],
      );
      await sql.query('SAVEPOINT local_effect');
      let outcome = 'SUCCEEDED';
      let reason = 'FULFILLED';
      try {
        if (item.type === 'DIGITAL') await fulfillDigital(sql, item);
        else if (item.type === 'SUBSCRIPTION') await fulfillSubscription(sql, item);
        else await fulfillPhysical(sql, item);
        if (rule && item.attempt_count <= rule.fail_until_attempt && rule.outcome !== 'SUCCESS')
          throw new Error(rule.outcome);
        await sql.query(
          "UPDATE order_items SET status='SUCCEEDED',next_attempt_at=NULL WHERE id=$1 RETURNING id",
          [id],
        );
        await sql.query(
          "UPDATE fulfillment_jobs SET status='DONE' WHERE item_id=$1 RETURNING item_id",
          [id],
        );
        await sql.query(
          "INSERT INTO outbox(id,kind,aggregate_id,generation,payload) VALUES($1,'ItemFulfilled',$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id",
          [
            randomUUID(),
            id,
            item.generation,
            JSON.stringify({
              schemaVersion: 1,
              orderId,
              itemId: id,
              type: item.type,
              correlationId: orderId,
            }),
          ],
        );
      } catch (error) {
        await sql.query('ROLLBACK TO SAVEPOINT local_effect');
        if (!(error instanceof Error) || !['TRANSIENT', 'PERMANENT'].includes(error.message))
          throw error;
        reason = error.message;
        if (reason === 'PERMANENT') {
          outcome = 'FAILED';
          await this.settlement.refund(sql, item, 'Permanent fulfillment failure');
        } else {
          outcome = 'RETRY_WAIT';
          const cycleAttempt = item.attempt_count - recovery.cycle_start_attempt;
          const base =
            cycleAttempt <= 3
              ? 10000 * 2 ** (cycleAttempt - 1)
              : Math.min(300000, 60000 * 2 ** Math.min(Math.floor((cycleAttempt - 4) / 4), 3));
          const delay = base + Math.floor(Math.random() * base * 0.2);
          await sql.query(
            "UPDATE order_items SET status='RETRY_WAIT',next_attempt_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1 RETURNING id",
            [id, delay],
          );
          await sql.query(
            "UPDATE fulfillment_jobs SET status='DEFERRED',available_at=clock_timestamp()+$2*interval '1 millisecond' WHERE item_id=$1 RETURNING item_id",
            [id, delay],
          );
        }
      }
      await sql.query(
        'INSERT INTO fulfillment_attempts(id,item_id,attempt,result,reason) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [randomUUID(), id, item.attempt_count, outcome, reason],
      );
      await this.settlement.history(
        sql,
        orderId,
        outcome === 'SUCCEEDED'
          ? 'ItemFulfilled'
          : outcome === 'FAILED'
            ? 'ItemFailed'
            : 'ItemRetryScheduled',
        { itemId: id, attempt: item.attempt_count, reason },
      );
      await this.settlement.aggregate(sql, orderId);
    });
  }
  private async cancellations() {
    const orders = await this.db.store.query<{
      id: string;
    }>(`SELECT o.id FROM orders o JOIN order_financial_projections f ON f.order_id=o.id WHERE o.cancellation_requested AND f.status='SUCCEEDED'
    AND EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status<>'SUCCEEDED' AND i.disposition='FULFILL') ORDER BY o.id LIMIT 4`);
    for (const order of orders)
      await this.db.store.transaction(async (sql) => {
        if (
          !(await sql.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE SKIP LOCKED', [order.id]))
            .length
        )
          return;
        await sql.query('SELECT id FROM admission_budget WHERE id=1 FOR UPDATE');
        const items = await sql.query<WorkItem>(
          `SELECT ${workFields} FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.id=$1 AND i.status<>'SUCCEEDED' AND i.disposition='FULFILL' ORDER BY i.id FOR UPDATE OF i`,
          [order.id],
        );
        for (const item of items) {
          await this.locks(sql, item);
          await this.settlement.refund(sql, item, 'Accepted cancellation before fulfillment');
        }
        await this.settlement.aggregate(sql, order.id);
      });
  }
  private async tick() {
    await this.cancellations();
    const rows = await this.db.store.query<{
      item_id: string;
      order_id: string;
    }>(`SELECT j.item_id,i.order_id FROM fulfillment_jobs j JOIN order_items i ON i.id=j.item_id
    WHERE j.status IN ('READY','DEFERRED') AND j.available_at<=clock_timestamp() ORDER BY j.available_at,j.item_id LIMIT 4`);
    for (const row of rows)
      try {
        await this.process(row.item_id, row.order_id);
      } catch {
        // Infrastructure failure rolls back the complete attempt/effect. Defer without spending an attempt.
        await this.db.store.transaction(async (sql) => {
          if (
            !(
              await sql.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE SKIP LOCKED', [
                row.order_id,
              ])
            ).length
          )
            return;
          await sql.query(
            "UPDATE fulfillment_jobs SET available_at=clock_timestamp()+least(300,10*power(2,least((SELECT infrastructure_failures FROM order_items WHERE id=$1),5)))*interval '1 second' WHERE item_id=$1 AND status IN ('READY','DEFERRED') RETURNING item_id",
            [row.item_id],
          );
          await sql.query(
            'UPDATE order_items SET infrastructure_failures=least(infrastructure_failures+1,1000) WHERE id=$1 RETURNING id',
            [row.item_id],
          );
        });
        logRecord('commerce', 'warn', 'fulfillment_infrastructure_deferred', {
          itemId: row.item_id,
        });
      }
  }
}
