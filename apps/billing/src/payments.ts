import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BillingDatabase } from './database.js';
import { ServiceIdentity } from '../../../packages/runtime/src/service-identity.js';
import { InvalidMessage, type Sql, type Envelope } from '../../../packages/runtime/src/outbox.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';

const money = z.string().regex(/^(0|[1-9][0-9]*)$/);
const request = z
  .object({
    schemaVersion: z.literal(1),
    orderId: z.uuid(),
    customerId: z.string().min(1).max(128),
    revision: z.int().positive().max(2147483647),
    operationKey: z.string().max(150),
    amountMinor: money,
    currency: z.literal('IRR'),
    correlationId: z.string().min(1).max(80),
  })
  .strict();
const bankResult = z
  .object({
    operationKey: z.string(),
    amountMinor: money.nullable(),
    currency: z.literal('IRR'),
    status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
    reference: z.string().max(200).nullable(),
    deadlineAt: z.iso.datetime().nullable(),
    noCharge: z.boolean().optional(),
  })
  .strict();
type BankResult = z.infer<typeof bankResult>;
interface PaymentRow {
  id: string;
  order_id: string;
  operation_key: string;
  customer_id: string;
  amount: string;
  status: string;
  version: number;
  checkout_revision: number;
  correlation_id: string;
  lookup_count: number;
  bank_deadline_at: Date | null;
  bank_reference: string | null;
  lease_token: string | null;
  cancelling?: boolean;
}
const fields =
  'id,order_id,operation_key,customer_id,amount_minor::text AS amount,status,version,checkout_revision,correlation_id,lookup_count,bank_deadline_at,bank_reference,lease_token';
const terminal = (status: string) => status === 'SUCCEEDED' || status === 'FAILED';
export function paymentLookupDelay(count: number) {
  return (
    Math.min(60000, 2000 * 2 ** Math.min(Math.max(count - 1, 0), 5)) +
    Math.floor(Math.random() * 501)
  );
}
@Injectable()
export class Payments implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(
    private readonly db: BillingDatabase,
    private readonly identity: ServiceIdentity,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      this.active ??= this.run()
        .catch(() => logRecord('billing', 'warn', 'payment_recovery_deferred'))
        .finally(() => {
          this.active = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.active;
  }
  private async emit(sql: Sql, p: PaymentRow, reason: string) {
    await sql.query(
      `INSERT INTO outbox(id,kind,aggregate_id,generation,payload) VALUES($1,'PaymentStatusChanged',$2,$3,$4::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`,
      [
        randomUUID(),
        p.order_id,
        p.version,
        JSON.stringify({
          schemaVersion: 1,
          orderId: p.order_id,
          customerId: p.customer_id,
          operationKey: p.operation_key,
          revision: p.checkout_revision,
          amountMinor: p.amount,
          currency: 'IRR',
          sourceVersion: p.version,
          status: p.status,
          bankReference: p.bank_reference,
          bankDeadlineAt: p.bank_deadline_at?.toISOString() ?? null,
          reason,
          correlationId: p.correlation_id,
        }),
      ],
    );
  }
  async accept(sql: Sql, event: Envelope, cancel = false) {
    const parsed = request.safeParse(event.payload);
    if (!parsed.success) throw new InvalidMessage('INVALID_PAYMENT_COMMAND');
    const p = parsed.data;
    if (
      event.aggregateId !== p.orderId ||
      event.generation !== p.revision ||
      p.operationKey !== `payment:${p.orderId}`
    )
      throw new InvalidMessage('PAYMENT_COMMAND_IDENTITY_MISMATCH');
    const inserted = await sql.query(
      `INSERT INTO payments(id,order_id,operation_key,customer_id,amount_minor,currency,checkout_revision,correlation_id,next_reconcile_at)
    VALUES($1,$2,$3,$4,$5::numeric,'IRR',$6,$7,clock_timestamp()) ON CONFLICT DO NOTHING RETURNING id`,
      [
        randomUUID(),
        p.orderId,
        p.operationKey,
        p.customerId,
        p.amountMinor,
        p.revision,
        p.correlationId,
      ],
    );
    const row = (
      await sql.query<PaymentRow>(
        `SELECT ${fields} FROM payments WHERE operation_key=$1 FOR UPDATE`,
        [p.operationKey],
      )
    )[0];
    if (
      !row ||
      row.order_id !== p.orderId ||
      row.customer_id !== p.customerId ||
      row.checkout_revision !== p.revision ||
      row.amount !== p.amountMinor
    )
      throw new InvalidMessage('CONFLICTING_PAYMENT_IDENTITY');
    if (inserted.length) await this.emit(sql, row, 'ACCEPTED');
    if (cancel) {
      await sql.query(
        "INSERT INTO payment_cancellations(operation_key,status) VALUES($1,'REQUESTED') ON CONFLICT DO NOTHING RETURNING operation_key",
        [p.operationKey],
      );
      await sql.query(
        `UPDATE payments SET next_reconcile_at=clock_timestamp() WHERE operation_key=$1 AND EXISTS
      (SELECT 1 FROM payment_cancellations WHERE operation_key=$1 AND status='REQUESTED') RETURNING id`,
        [p.operationKey],
      );
    }
  }
  private async claim() {
    return this.db.store.transaction(async (sql) => {
      const row = (
        await sql.query<PaymentRow>(`SELECT ${fields} FROM payments WHERE next_reconcile_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_reconcile_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)
      )[0];
      if (!row) return;
      row.cancelling =
        (
          await sql.query(
            "SELECT 1 FROM payment_cancellations WHERE operation_key=$1 AND status='REQUESTED'",
            [row.operation_key],
          )
        ).length > 0;
      if (terminal(row.status) && !row.cancelling) {
        await sql.query('UPDATE payments SET next_reconcile_at=NULL WHERE id=$1 RETURNING id', [
          row.id,
        ]);
        return;
      }
      row.lease_token = randomUUID();
      row.lookup_count++;
      if (row.status === 'PENDING') {
        row.status = 'PROCESSING';
        row.version++;
        await sql.query(
          "UPDATE payments SET status='PROCESSING',version=$2 WHERE id=$1 RETURNING id",
          [row.id, row.version],
        );
        await this.emit(sql, row, 'BANK_CONTACT_PENDING');
      }
      await sql.query(
        `UPDATE payments SET lease_token=$2,lease_until=clock_timestamp()+interval '15 seconds',lookup_count=lookup_count+1 WHERE id=$1 RETURNING id`,
        [row.id, row.lease_token],
      );
      return row;
    });
  }
  private async bank(
    path: string,
    method: string,
    body?: unknown,
    correlationId = 'payment-recovery',
  ): Promise<BankResult | undefined> {
    const token = await this.identity.accessToken();
    const response = await fetch(`http://bank-simulator:3000/internal/charges${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-request-id': correlationId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    if (response.status === 404 && method === 'GET') return;
    if (!response.ok) throw new Error('Bank response unknown');
    return bankResult.parse(await response.json());
  }
  private validate(p: PaymentRow, result: BankResult, cancel: boolean) {
    if (
      result.operationKey !== p.operation_key ||
      (result.amountMinor !== p.amount &&
        !(cancel && result.noCharge && result.amountMinor === null)) ||
      (!result.deadlineAt && !(cancel && result.noCharge)) ||
      (cancel && result.noCharge && result.status !== 'FAILED') ||
      (result.status === 'SUCCEEDED' && !result.reference)
    )
      throw new Error('Bank identity/result mismatch');
  }
  private async contact(p: PaymentRow) {
    const call = (path: string, method: string, body?: unknown) =>
      this.bank(path, method, body, p.correlation_id);
    let result: BankResult | undefined;
    try {
      if (p.cancelling)
        result = await call(`/${encodeURIComponent(p.operation_key)}/cancel`, 'POST');
      else {
        result = await call(`/${encodeURIComponent(p.operation_key)}`, 'GET');
        if (!result)
          result = await call('/init', 'POST', {
            operationKey: p.operation_key,
            amountMinor: p.amount,
            currency: 'IRR',
          });
        if (result) {
          this.validate(p, result, false);
          if (result.status === 'PENDING') {
            await this.db.store.query(
              'UPDATE payments SET bank_deadline_at=$3 WHERE id=$1 AND lease_token=$2 RETURNING id',
              [p.id, p.lease_token, result.deadlineAt],
            );
            p.bank_deadline_at = new Date(result.deadlineAt!);
            result = await call(`/${encodeURIComponent(p.operation_key)}/execute`, 'POST');
          }
        }
      }
      if (!result) throw new Error('No authoritative bank result');
      this.validate(p, result, !!p.cancelling);
    } catch {
      result = undefined;
    }
    await this.finish(p, result);
  }
  private async finish(claim: PaymentRow, result: BankResult | undefined) {
    await this.db.store.transaction(async (sql) => {
      const p = (
        await sql.query<PaymentRow>(`SELECT ${fields} FROM payments WHERE id=$1 FOR UPDATE`, [
          claim.id,
        ])
      )[0]!;
      if (p.lease_token !== claim.lease_token) return;
      const was = p.status;
      const oldDeadline = p.bank_deadline_at?.toISOString() ?? null;
      if (result && terminal(was) && result.status !== was)
        throw new Error('Conflicting terminal bank result');
      if (result) {
        p.status = result.status === 'PENDING' ? 'UNKNOWN' : result.status;
        p.bank_deadline_at = result.deadlineAt ? new Date(result.deadlineAt) : p.bank_deadline_at;
        p.bank_reference = result.reference;
      } else if (!terminal(p.status)) p.status = 'UNKNOWN';
      let cancelResolved = false;
      if (claim.cancelling && result && terminal(result.status)) {
        cancelResolved = true;
        await sql.query(
          `UPDATE payment_cancellations SET status=$2,version=version+1 WHERE operation_key=$1 AND status='REQUESTED' RETURNING operation_key`,
          [p.operation_key, result.status === 'SUCCEEDED' ? 'REFUND_REQUIRED' : 'NO_CHARGE'],
        );
      }
      const stillCancelling =
        (
          await sql.query(
            "SELECT 1 FROM payment_cancellations WHERE operation_key=$1 AND status='REQUESTED'",
            [p.operation_key],
          )
        ).length > 0;
      const due = !terminal(p.status) || stillCancelling;
      const changed =
        p.status !== was ||
        oldDeadline !== (p.bank_deadline_at?.toISOString() ?? null) ||
        cancelResolved;
      if (changed) p.version++;
      const delay = paymentLookupDelay(p.lookup_count);
      await sql.query(
        `UPDATE payments SET status=$2,version=$3,bank_deadline_at=$4,bank_reference=$5,lease_token=NULL,lease_until=NULL,
      next_reconcile_at=CASE WHEN NOT $6 THEN NULL WHEN $7 THEN clock_timestamp() ELSE
        CASE WHEN $4::timestamptz>clock_timestamp() THEN least(clock_timestamp()+$8*interval '1 millisecond',$4::timestamptz)
        ELSE clock_timestamp()+$8*interval '1 millisecond' END END WHERE id=$1 RETURNING id`,
        [
          p.id,
          p.status,
          p.version,
          p.bank_deadline_at,
          p.bank_reference,
          due,
          stillCancelling && !claim.cancelling,
          delay,
        ],
      );
      await sql.query(
        `INSERT INTO payment_attempts(id,payment_id,kind,result,metadata) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,
        [
          randomUUID(),
          p.id,
          claim.cancelling ? 'CANCEL_OR_LOOKUP' : 'LOOKUP_OR_EXECUTE',
          result?.status ?? 'UNKNOWN',
          JSON.stringify({
            lookupCount: p.lookup_count,
            bankDeadlineAt: p.bank_deadline_at?.toISOString() ?? null,
            correlationId: p.correlation_id,
          }),
        ],
      );
      if (changed)
        await this.emit(
          sql,
          p,
          cancelResolved
            ? result?.status === 'SUCCEEDED'
              ? 'CANCEL_AFTER_CHARGE'
              : 'CANCELLED_NO_CHARGE'
            : terminal(p.status)
              ? 'BANK_FINAL'
              : 'BANK_OUTCOME_UNKNOWN',
        );
    });
  }
  private async run() {
    const claims: PaymentRow[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await this.claim();
      if (p) claims.push(p);
    }
    await Promise.all(claims.map((p) => this.contact(p)));
  }
}
