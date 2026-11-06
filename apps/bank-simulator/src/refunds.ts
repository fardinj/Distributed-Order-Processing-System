import {
  Injectable,
  Controller,
  Post,
  Get,
  Param,
  Body,
  ForbiddenException,
  ConflictException,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BankDatabase } from './database.js';
import { CurrentUser, Roles, type Principal } from '../../../packages/runtime/src/security.js';
import { parse } from '../../../packages/runtime/src/validation.js';
const key = z.string().regex(/^refund:[0-9a-f-]{36}$/);
const input = z
  .object({
    operationKey: key,
    chargeKey: z.string().regex(/^payment:[0-9a-f-]{36}$/),
    amountMinor: z.string().regex(/^[1-9][0-9]*$/),
    currency: z.literal('IRR'),
  })
  .strict();
interface Row {
  operation_key: string;
  charge_key: string;
  amount: string;
  status: string;
  reference: string | null;
  simulation_outcome: string;
  attempt_count: number;
  fault_count: number;
}
const fields =
  'operation_key,charge_key,amount_minor::text AS amount,status,reference,simulation_outcome,attempt_count,fault_count';
const view = (r: Row) => ({
  operationKey: r.operation_key,
  chargeKey: r.charge_key,
  amountMinor: r.amount,
  currency: 'IRR',
  status: r.status,
  reference: r.reference,
});
@Injectable()
export class BankRefunds {
  constructor(private readonly db: BankDatabase) {}
  async lookup(operationKey: string) {
    const r = (
      await this.db.store.query<Row>(`SELECT ${fields} FROM bank_refunds WHERE operation_key=$1`, [
        operationKey,
      ])
    )[0];
    if (!r) throw new NotFoundException('Refund not initialized');
    return view(r);
  }
  async execute(p: z.infer<typeof input>) {
    return this.db.store.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS locked', [
        p.operationKey,
      ]);
      const charge = (
        await sql.query<{ status: string; amount: string }>(
          'SELECT status,amount_minor::text AS amount FROM bank_operations WHERE operation_key=$1 FOR UPDATE',
          [p.chargeKey],
        )
      )[0];
      if (charge?.status !== 'SUCCEEDED')
        throw new ConflictException('Refund requires a captured charge');
      const reserved = (
        await sql.query<{ amount: string }>(
          "SELECT coalesce(sum(amount_minor),0)::text AS amount FROM bank_refunds WHERE charge_key=$1 AND operation_key<>$2 AND status<>'FAILED'",
          [p.chargeKey, p.operationKey],
        )
      )[0]!.amount;
      if (BigInt(reserved) + BigInt(p.amountMinor) > BigInt(charge.amount))
        throw new ConflictException('Refund exceeds captured amount');
      await sql.query(
        `INSERT INTO bank_refunds(operation_key,charge_key,amount_minor,simulation_outcome,fault_count)
    SELECT $1::varchar(150),$2,$3::numeric,coalesce((SELECT outcome FROM bank_refund_simulation_assignments WHERE operation_key=$1::varchar(150)),'SUCCEED'),
      coalesce((SELECT fault_count FROM bank_refund_simulation_assignments WHERE operation_key=$1::varchar(150)),1)
    ON CONFLICT DO NOTHING RETURNING operation_key`,
        [p.operationKey, p.chargeKey, p.amountMinor],
      );
      const r = (
        await sql.query<Row>(
          `SELECT ${fields} FROM bank_refunds WHERE operation_key=$1 FOR UPDATE`,
          [p.operationKey],
        )
      )[0]!;
      if (r.charge_key !== p.chargeKey || r.amount !== p.amountMinor)
        throw new ConflictException('Refund identity/amount differs');
      if (r.status !== 'PENDING') return { operation: view(r), ambiguous: false };
      r.attempt_count++;
      const before = r.simulation_outcome === 'TIMEOUT_BEFORE' && r.attempt_count <= r.fault_count;
      if (!before) {
        r.status = r.simulation_outcome === 'FAIL' ? 'FAILED' : 'SUCCEEDED';
        r.reference = r.status === 'SUCCEEDED' ? `bank-refund-${randomUUID()}` : null;
      }
      await sql.query(
        'UPDATE bank_refunds SET status=$2,reference=$3,attempt_count=attempt_count+1 WHERE operation_key=$1 RETURNING operation_key',
        [r.operation_key, r.status, r.reference],
      );
      return { operation: view(r), ambiguous: before || r.simulation_outcome === 'TIMEOUT_AFTER' };
    });
  }
}
@Controller('internal/refunds')
@Roles('service')
export class BankRefundsController {
  constructor(private readonly refunds: BankRefunds) {}
  private billing(user: Principal) {
    if (user.clientId !== 'billing-service')
      throw new ForbiddenException('Billing identity required');
  }
  @Get(':key') lookup(@CurrentUser() user: Principal, @Param('key') value: string) {
    this.billing(user);
    return this.refunds.lookup(parse(key, value));
  }
  @Post() async execute(@CurrentUser() user: Principal, @Body() body: unknown) {
    this.billing(user);
    const r = await this.refunds.execute(parse(input, body));
    if (r.ambiguous)
      throw new HttpException({ message: 'Simulated ambiguous refund response' }, 504);
    return r.operation;
  }
}
