import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BillingDatabase } from './database.js';
import { ServiceIdentity } from '../../../packages/runtime/src/service-identity.js';
import { InvalidMessage, type Sql, type Envelope } from '../../../packages/runtime/src/outbox.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';
import { ensurePaymentLines } from './payment-lines.js';
import { paymentLookupDelay } from './payments.js';
const money = z.string().regex(/^[1-9][0-9]*$/);
const command = z
  .object({
    schemaVersion: z.literal(1),
    dispositionId: z.uuid(),
    operationKey: z.string(),
    orderId: z.uuid(),
    itemId: z.uuid(),
    customerId: z.string().max(128),
    paymentOperationKey: z.string(),
    revision: z.int().positive().max(2147483647),
    amountMinor: money,
    currency: z.literal('IRR'),
    reason: z.string().min(1).max(1000),
    correlationId: z.string().max(80),
  })
  .strict();
const provider = z
  .object({
    operationKey: z.string(),
    chargeKey: z.string(),
    amountMinor: money,
    currency: z.literal('IRR'),
    status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
    reference: z.string().nullable(),
  })
  .strict();
interface Row {
  id: string;
  payment_id: string;
  disposition_id: string;
  operation_key: string;
  amount: string;
  status: string;
  reason: string;
  version: number;
  lookup_count: number;
  lease_token: string | null;
  bank_reference: string | null;
  correlation_id: string;
}
interface Payment {
  id: string;
  order_id: string;
  operation_key: string;
  customer_id: string;
  checkout_revision: number;
  amount: string;
  status: string;
}
const fields =
  'id,payment_id,disposition_id,operation_key,amount_minor::text AS amount,status,reason,version,lookup_count,lease_token,bank_reference,correlation_id';
@Injectable()
export class Refunds implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(
    private readonly db: BillingDatabase,
    private readonly identity: ServiceIdentity,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      this.active ??= this.tick()
        .catch(() => logRecord('billing', 'warn', 'refund_recovery_deferred'))
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
  private async emit(sql: Sql, r: Row, p: Payment, type: string) {
    const log = (
      await sql.query<{ id: string; created_at: Date }>(
        `INSERT INTO refund_logs(id,refund_id,type,metadata) VALUES($1,$2,$3,$4::jsonb) RETURNING id,created_at`,
        [
          randomUUID(),
          r.id,
          type,
          JSON.stringify({ lookupCount: r.lookup_count, sourceVersion: r.version }),
        ],
      )
    )[0]!;
    const version = (
      await sql.query<{ financial_version: number }>(
        'UPDATE payments SET financial_version=financial_version+1 WHERE id=$1 RETURNING financial_version',
        [p.id],
      )
    )[0]!.financial_version;
    const sums = (
      await sql.query<{ confirmed: string; pending: string }>(
        `SELECT coalesce(sum(amount_minor) FILTER(WHERE status='SUCCEEDED'),0)::text AS confirmed,
    coalesce(sum(amount_minor) FILTER(WHERE status<>'SUCCEEDED'),0)::text AS pending FROM refunds WHERE payment_id=$1`,
        [p.id],
      )
    )[0]!;
    const item = (
      await sql.query<{ item_id: string }>('SELECT item_id FROM refund_items WHERE refund_id=$1', [
        r.id,
      ])
    )[0]!;
    await sql.query(
      `INSERT INTO outbox(id,kind,aggregate_id,generation,payload) VALUES($1,'RefundStatusChanged',$2,$3,$4::jsonb) RETURNING id`,
      [
        randomUUID(),
        r.disposition_id,
        r.version,
        JSON.stringify({
          schemaVersion: 1,
          dispositionId: r.disposition_id,
          refundId: r.id,
          operationKey: r.operation_key,
          orderId: p.order_id,
          itemId: item.item_id,
          customerId: p.customer_id,
          paymentOperationKey: p.operation_key,
          revision: p.checkout_revision,
          amountMinor: r.amount,
          currency: 'IRR',
          sourceVersion: r.version,
          status: r.status,
          financialVersion: version,
          refundedMinor: sums.confirmed,
          pendingRefundMinor: sums.pending,
          bankReference: r.bank_reference,
          correlationId: r.correlation_id,
          log: {
            id: log.id,
            type,
            metadata: { lookupCount: r.lookup_count, sourceVersion: r.version },
            createdAt: log.created_at.toISOString(),
          },
        }),
      ],
    );
  }
  async accept(sql: Sql, event: Envelope) {
    const parsed = command.safeParse(event.payload);
    if (!parsed.success) throw new InvalidMessage('INVALID_REFUND_COMMAND');
    const c = parsed.data;
    if (
      event.aggregateId !== c.dispositionId ||
      event.generation !== 1 ||
      c.operationKey !== `refund:${c.dispositionId}` ||
      c.paymentOperationKey !== `payment:${c.orderId}`
    )
      throw new InvalidMessage('REFUND_COMMAND_IDENTITY_MISMATCH');
    const p = (
      await sql.query<Payment>(
        'SELECT id,order_id,operation_key,customer_id,checkout_revision,amount_minor::text AS amount,status FROM payments WHERE operation_key=$1 FOR UPDATE',
        [c.paymentOperationKey],
      )
    )[0];
    if (!p || p.status !== 'SUCCEEDED')
      throw new Error('Captured payment prerequisite unavailable');
    if (
      p.order_id !== c.orderId ||
      p.customer_id !== c.customerId ||
      p.checkout_revision !== c.revision
    )
      throw new InvalidMessage('REFUND_PAYMENT_IDENTITY_MISMATCH');
    await ensurePaymentLines(sql, p);
    const line = (
      await sql.query<{ amount: string }>(
        'SELECT amount_minor::text AS amount FROM payment_lines WHERE payment_id=$1 AND item_id=$2',
        [p.id, c.itemId],
      )
    )[0];
    if (!line) throw new Error('Paid line prerequisite unavailable');
    if (line.amount !== c.amountMinor)
      throw new InvalidMessage('REFUND_WHOLE_LINE_AMOUNT_MISMATCH');
    const old = (
      await sql.query<Row>(
        `SELECT ${fields} FROM refunds WHERE disposition_id=$1 OR operation_key=$2`,
        [c.dispositionId, c.operationKey],
      )
    )[0];
    if (old) {
      if (
        old.payment_id !== p.id ||
        old.amount !== c.amountMinor ||
        old.disposition_id !== c.dispositionId ||
        old.operation_key !== c.operationKey ||
        old.reason !== c.reason ||
        !(
          await sql.query('SELECT 1 FROM refund_items WHERE refund_id=$1 AND item_id=$2', [
            old.id,
            c.itemId,
          ])
        ).length
      )
        throw new InvalidMessage('REFUND_PAYLOAD_CONFLICT');
      return;
    }
    if ((await sql.query('SELECT 1 FROM refund_items WHERE item_id=$1', [c.itemId])).length)
      throw new InvalidMessage('ITEM_ALREADY_HAS_REFUND_OBLIGATION');
    const budget = (
      await sql.query<{ amount: string }>(
        'SELECT coalesce(sum(amount_minor),0)::text AS amount FROM refunds WHERE payment_id=$1',
        [p.id],
      )
    )[0]!.amount;
    if (BigInt(budget) + BigInt(c.amountMinor) > BigInt(p.amount))
      throw new InvalidMessage('REFUND_CAPTURE_BUDGET_EXCEEDED');
    const row = (
      await sql.query<Row>(
        `INSERT INTO refunds(id,payment_id,disposition_id,operation_key,amount_minor,reason,correlation_id,next_reconcile_at)
   VALUES($1,$2,$3,$4,$5::numeric,$6,$7,clock_timestamp()) RETURNING ${fields}`,
        [
          randomUUID(),
          p.id,
          c.dispositionId,
          c.operationKey,
          c.amountMinor,
          c.reason,
          c.correlationId,
        ],
      )
    )[0]!;
    await sql.query(
      'INSERT INTO refund_items(refund_id,item_id,amount_minor) VALUES($1,$2,$3::numeric) RETURNING item_id',
      [row.id, c.itemId, c.amountMinor],
    );
    await this.emit(sql, row, p, 'ACCEPTED');
  }
  private async claim() {
    return this.db.store.transaction(async (sql) => {
      const candidates = await sql.query<{ id: string; payment_id: string }>(
        `SELECT id,payment_id FROM refunds WHERE next_reconcile_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_reconcile_at,id LIMIT 8`,
      );
      for (const candidate of candidates) {
        const p = (
          await sql.query<Payment>(
            'SELECT id,order_id,operation_key,customer_id,checkout_revision,amount_minor::text AS amount,status FROM payments WHERE id=$1 FOR UPDATE SKIP LOCKED',
            [candidate.payment_id],
          )
        )[0];
        if (!p) continue;
        const r = (
          await sql.query<Row>(
            `SELECT ${fields} FROM refunds WHERE id=$1 AND next_reconcile_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) FOR UPDATE SKIP LOCKED`,
            [candidate.id],
          )
        )[0];
        if (!r) continue;
        if (['SUCCEEDED', 'REVIEW_REQUIRED', 'FAILED'].includes(r.status)) {
          await sql.query('UPDATE refunds SET next_reconcile_at=NULL WHERE id=$1 RETURNING id', [
            r.id,
          ]);
          continue;
        }
        r.lease_token = randomUUID();
        r.lookup_count++;
        if (r.status === 'PENDING') {
          r.status = 'PROCESSING';
          r.version++;
          await sql.query(
            "UPDATE refunds SET status='PROCESSING',version=$2 WHERE id=$1 RETURNING id",
            [r.id, r.version],
          );
          await this.emit(sql, r, p, 'BANK_CONTACT_PENDING');
        }
        await sql.query(
          "UPDATE refunds SET lease_token=$2,lease_until=clock_timestamp()+interval '15 seconds',lookup_count=lookup_count+1 WHERE id=$1 RETURNING id",
          [r.id, r.lease_token],
        );
        return { r, p };
      }
    });
  }
  private async call(path: string, method: string, body: unknown, correlation: string) {
    const token = await this.identity.accessToken();
    const response = await fetch(`http://bank-simulator:3000/internal/refunds${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-request-id': correlation,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    if (response.status === 404 && method === 'GET') return;
    if (!response.ok) throw new Error('Refund result unknown');
    return provider.parse(await response.json());
  }
  private async contact(claim: { r: Row; p: Payment }) {
    const { r, p } = claim;
    let result: z.infer<typeof provider> | undefined;
    try {
      result = await this.call(
        `/${encodeURIComponent(r.operation_key)}`,
        'GET',
        undefined,
        r.correlation_id,
      );
      if (!result || result.status === 'PENDING')
        result = await this.call(
          '',
          'POST',
          {
            operationKey: r.operation_key,
            chargeKey: p.operation_key,
            amountMinor: r.amount,
            currency: 'IRR',
          },
          r.correlation_id,
        );
      if (
        !result ||
        result.operationKey !== r.operation_key ||
        result.chargeKey !== p.operation_key ||
        result.amountMinor !== r.amount ||
        (result.status === 'SUCCEEDED' && !result.reference)
      )
        throw new Error('Refund provider identity mismatch');
    } catch {
      result = undefined;
    }
    await this.db.store.transaction(async (sql) => {
      const payment = (
        await sql.query<Payment>(
          'SELECT id,order_id,operation_key,customer_id,checkout_revision,amount_minor::text AS amount,status FROM payments WHERE id=$1 FOR UPDATE',
          [p.id],
        )
      )[0]!;
      const row = (
        await sql.query<Row>(`SELECT ${fields} FROM refunds WHERE id=$1 FOR UPDATE`, [r.id])
      )[0]!;
      if (row.lease_token !== r.lease_token) return;
      row.status =
        result?.status === 'SUCCEEDED'
          ? 'SUCCEEDED'
          : result?.status === 'FAILED'
            ? 'REVIEW_REQUIRED'
            : 'UNKNOWN';
      row.version++;
      row.bank_reference = result?.reference ?? row.bank_reference;
      const pending = row.status === 'UNKNOWN';
      await sql.query(
        `UPDATE refunds SET status=$2,version=$3,bank_reference=$4,lease_token=NULL,lease_until=NULL,
     next_reconcile_at=CASE WHEN $5 THEN clock_timestamp()+$6*interval '1 millisecond' ELSE NULL END WHERE id=$1 RETURNING id`,
        [
          row.id,
          row.status,
          row.version,
          row.bank_reference,
          pending,
          paymentLookupDelay(row.lookup_count),
        ],
      );
      await this.emit(
        sql,
        row,
        payment,
        row.status === 'SUCCEEDED'
          ? 'BANK_REFUND_CONFIRMED'
          : row.status === 'REVIEW_REQUIRED'
            ? 'BANK_REFUND_DECLINED'
            : 'BANK_REFUND_UNKNOWN',
      );
      if (row.status === 'SUCCEEDED')
        await sql.query(
          `UPDATE payment_cancellations SET status='RESOLVED',version=version+1
        WHERE operation_key=$1 AND status='REFUND_REQUIRED' AND (SELECT coalesce(sum(amount_minor),0) FROM refunds WHERE payment_id=$2 AND status='SUCCEEDED')=$3::numeric RETURNING operation_key`,
          [payment.operation_key, payment.id, payment.amount],
        );
    });
  }
  private async tick() {
    const claims: Awaited<ReturnType<Refunds['claim']>>[] = [];
    for (let i = 0; i < 2; i++) claims.push(await this.claim());
    await Promise.all(claims.filter((c) => c !== undefined).map((c) => this.contact(c)));
  }
}
