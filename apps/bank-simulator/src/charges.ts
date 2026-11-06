import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  NotFoundException,
  ConflictException,
  Param,
  Post,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BankDatabase } from './database.js';
import { CurrentUser, Roles, type Principal } from '../../../packages/runtime/src/security.js';
import { parse } from '../../../packages/runtime/src/validation.js';
import type { Sql } from '../../../packages/runtime/src/outbox.js';
import { logRecord } from '../../../packages/runtime/src/logger.js';

const keySchema = z
  .string()
  .regex(/^payment:[0-9a-f-]{36}$/)
  .max(150);
const initSchema = z
  .object({
    operationKey: keySchema,
    amountMinor: z.string().regex(/^(0|[1-9][0-9]*)$/),
    currency: z.literal('IRR'),
  })
  .strict();
interface Operation {
  operation_key: string;
  amount: string;
  status: string;
  reference: string | null;
  deadline_at: Date;
  simulation_outcome: string;
}
const columns =
  'operation_key,amount_minor::text AS amount,status,reference,deadline_at,simulation_outcome';
const view = (r: Operation) => ({
  operationKey: r.operation_key,
  amountMinor: r.amount,
  currency: 'IRR',
  status: r.status,
  reference: r.reference,
  deadlineAt: r.deadline_at.toISOString(),
});
@Injectable()
export class BankCharges implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(private readonly db: BankDatabase) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      this.active ??= this.expire()
        .catch(() => {
          logRecord('bank-simulator', 'warn', 'bank_deadline_deferred');
        })
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
  private async fence(sql: Sql, key: string) {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS locked', [key]);
  }
  private async row(sql: Sql, key: string) {
    const rows = await sql.query<Operation>(
      `SELECT ${columns} FROM bank_operations WHERE operation_key=$1 FOR UPDATE`,
      [key],
    );
    if (!rows[0]) throw new NotFoundException('Bank operation not initialized');
    return rows[0];
  }
  private async settleDeadline(sql: Sql, r: Operation) {
    const failed = await sql.query(
      `UPDATE bank_operations SET status='FAILED' WHERE operation_key=$1 AND status='PENDING'
      AND deadline_at<=clock_timestamp() RETURNING operation_key`,
      [r.operation_key],
    );
    if (failed.length) r.status = 'FAILED';
  }
  async initialize(input: z.infer<typeof initSchema>) {
    return this.db.store.transaction(async (sql) => {
      await this.fence(sql, input.operationKey);
      await sql.query(
        `WITH started AS (SELECT clock_timestamp() AS at)
        INSERT INTO bank_operations(operation_key,amount_minor,currency,status,initiated_at,deadline_at,simulation_outcome)
        SELECT $1::varchar(150),$2::numeric,'IRR',CASE WHEN EXISTS(SELECT 1 FROM bank_charge_cancellations WHERE operation_key=$1::varchar(150)) THEN 'FAILED' ELSE 'PENDING' END,
        at,at+interval '15 minutes',coalesce((SELECT r.outcome FROM bank_simulation_assignments a JOIN simulation_rules r ON r.reference=a.reference WHERE a.operation_key=$1::varchar(150)),'SUCCEED')
        FROM started ON CONFLICT DO NOTHING RETURNING operation_key`,
        [input.operationKey, input.amountMinor],
      );
      const r = await this.row(sql, input.operationKey);
      if (r.amount !== input.amountMinor)
        throw new ConflictException('Bank operation identity/amount differs');
      await this.settleDeadline(sql, r);
      return view(r);
    });
  }
  async lookup(key: string) {
    return this.db.store.transaction(async (sql) => {
      const r = await this.row(sql, key);
      await this.settleDeadline(sql, r);
      return view(r);
    });
  }
  async execute(key: string) {
    return this.db.store.transaction(async (sql) => {
      await this.fence(sql, key);
      const r = await this.row(sql, key);
      await this.settleDeadline(sql, r);
      if (r.status !== 'PENDING') return { operation: view(r), ambiguous: false };
      if (
        (await sql.query('SELECT 1 FROM bank_charge_cancellations WHERE operation_key=$1', [key]))
          .length
      ) {
        await sql.query(
          "UPDATE bank_operations SET status='FAILED' WHERE operation_key=$1 RETURNING operation_key",
          [key],
        );
        r.status = 'FAILED';
        return { operation: view(r), ambiguous: false };
      }
      const mode = r.simulation_outcome;
      if (mode === 'SUCCEED' || mode === 'TIMEOUT_AFTER') {
        r.status = 'SUCCEEDED';
        r.reference = `bank-${randomUUID()}`;
        await sql.query(
          "UPDATE bank_operations SET status='SUCCEEDED',reference=$2 WHERE operation_key=$1 RETURNING operation_key",
          [key, r.reference],
        );
      } else if (mode === 'FAIL') {
        r.status = 'FAILED';
        await sql.query(
          "UPDATE bank_operations SET status='FAILED' WHERE operation_key=$1 RETURNING operation_key",
          [key],
        );
      }
      return {
        operation: view(r),
        ambiguous: mode === 'TIMEOUT_BEFORE' || mode === 'TIMEOUT_AFTER',
      };
    });
  }
  async cancel(key: string) {
    return this.db.store.transaction(async (sql) => {
      await this.fence(sql, key);
      await sql.query(
        'INSERT INTO bank_charge_cancellations(operation_key) VALUES($1) ON CONFLICT DO NOTHING RETURNING operation_key',
        [key],
      );
      await sql.query(
        "UPDATE bank_operations SET status='FAILED' WHERE operation_key=$1 AND status='PENDING' RETURNING operation_key",
        [key],
      );
      const row = (
        await sql.query<Operation>(
          `SELECT ${columns} FROM bank_operations WHERE operation_key=$1`,
          [key],
        )
      )[0];
      return row
        ? { ...view(row), noCharge: row.status === 'FAILED' }
        : {
            operationKey: key,
            status: 'FAILED',
            noCharge: true,
            amountMinor: null,
            currency: 'IRR',
            reference: null,
            deadlineAt: null,
          };
    });
  }
  async expire() {
    await this.db.store.query(`UPDATE bank_operations SET status='FAILED' WHERE operation_key IN
      (SELECT operation_key FROM bank_operations WHERE status='PENDING' AND deadline_at<=clock_timestamp()
      ORDER BY deadline_at,operation_key FOR UPDATE SKIP LOCKED LIMIT 32) RETURNING operation_key`);
  }
}
@Controller('internal/charges')
@Roles('service')
export class BankChargesController {
  constructor(private readonly charges: BankCharges) {}
  private billing(user: Principal) {
    if (user.clientId !== 'billing-service')
      throw new ForbiddenException('Billing identity required');
  }
  @Post('init') initialize(@CurrentUser() user: Principal, @Body() body: unknown) {
    this.billing(user);
    return this.charges.initialize(parse(initSchema, body));
  }
  @Get(':key') lookup(@CurrentUser() user: Principal, @Param('key') key: string) {
    this.billing(user);
    return this.charges.lookup(parse(keySchema, key));
  }
  @Post(':key/execute') async execute(@CurrentUser() user: Principal, @Param('key') key: string) {
    this.billing(user);
    const r = await this.charges.execute(parse(keySchema, key));
    // Commit the outcome first. A simulated lost response never rolls back a successful charge.
    if (r.ambiguous) throw new HttpException({ message: 'Simulated ambiguous bank response' }, 504);
    return r.operation;
  }
  @Post(':key/cancel') cancel(@CurrentUser() user: Principal, @Param('key') key: string) {
    this.billing(user);
    return this.charges.cancel(parse(keySchema, key));
  }
}
