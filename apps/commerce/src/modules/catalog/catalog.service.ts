import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { CommerceDatabase } from '../../database.js';
import { fingerprint, versionMatches } from '../../../../../packages/runtime/src/validation.js';
import type {
  CreateProduct,
  UpdateProduct,
  AdjustInventory,
  ReconcileInventory,
} from './contracts.js';

type Tx = Prisma.TransactionClient;
interface ProductRow {
  id: string;
  name: string;
  type: string;
  priceMinor: string;
  currency: string;
  subscriptionDays: number | null;
  digitalMetadata: Prisma.JsonValue;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  available: string | null;
  inventoryVersion: number | null;
  requiresReview: boolean | null;
}
const columns = Prisma.sql`p.id, p.name, p.type, p.price_minor::text AS "priceMinor", p.currency,
  p.subscription_days AS "subscriptionDays", p.digital_metadata AS "digitalMetadata", p.active, p.version,
  p.created_at AS "createdAt", p.updated_at AS "updatedAt", i.available::text AS available,
  i.version AS "inventoryVersion", i.requires_review AS "requiresReview"`;
function view(row: ProductRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    priceMinor: row.priceMinor,
    currency: row.currency,
    subscriptionDays: row.subscriptionDays,
    digitalMetadata: row.digitalMetadata,
    active: row.active,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stock:
      row.available === null
        ? null
        : {
            available: row.available,
            version: row.inventoryVersion,
            requiresReview: row.requiresReview,
          },
  };
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class CatalogService {
  constructor(private readonly db: CommerceDatabase) {}

  private async product(tx: Tx, id: string, includeInactive = false) {
    const rows = await tx.$queryRaw<ProductRow[]>(Prisma.sql`SELECT ${columns} FROM products p
      LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id=${id}::uuid
      ${includeInactive ? Prisma.empty : Prisma.sql`AND p.active=true`}`);
    if (!rows[0]) throw new NotFoundException('Product not found');
    return view(rows[0]);
  }
  get(id: string, admin = false) {
    return this.product(this.db, id, admin);
  }
  async list(limit: number, cursor?: string, admin = false) {
    let after = Prisma.empty;
    if (cursor) {
      let data: { time?: unknown; id?: unknown };
      try {
        data = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      } catch {
        throw new BadRequestException('Invalid cursor');
      }
      if (
        typeof data.time !== 'string' ||
        typeof data.id !== 'string' ||
        !/^\d{4}-\d\d-\d\dT/.test(data.time) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(data.id) ||
        Number.isNaN(Date.parse(data.time))
      )
        throw new BadRequestException('Invalid cursor');
      after = Prisma.sql`AND (p.created_at,p.id)>(${new Date(data.time)},${data.id}::uuid)`;
    }
    const rows = await this.db.$queryRaw<ProductRow[]>(Prisma.sql`SELECT ${columns} FROM products p
      LEFT JOIN inventory i ON i.product_id=p.id WHERE ${admin ? Prisma.sql`true` : Prisma.sql`p.active=true`}
      ${after} ORDER BY p.created_at,p.id LIMIT ${limit + 1}`);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(view),
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({ time: last.createdAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  }

  private async mutate(
    actor: string,
    operation: string,
    key: string,
    input: unknown,
    work: (tx: Tx) => Promise<unknown>,
  ) {
    return this.db.$transaction(
      async (tx) => {
        const digest = fingerprint(input);
        const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO idempotency_records
        (id,actor_id,operation,key,fingerprint) VALUES (${randomUUID()}::uuid,${actor},${operation},${key},${digest})
        ON CONFLICT (actor_id,operation,key) DO NOTHING RETURNING id`;
        if (!inserted.length) {
          const existing = await tx.idempotencyRecord.findUniqueOrThrow({
            where: { actorId_operation_key: { actorId: actor, operation, key } },
          });
          if (existing.fingerprint !== digest)
            throw new ConflictException('Idempotency key was used with a different request');
          return existing.response;
        }
        const result = await work(tx);
        await tx.idempotencyRecord.update({
          where: { id: inserted[0]!.id },
          data: { response: json(result) },
        });
        return result;
      },
      { maxWait: 1500, timeout: 5000 },
    );
  }
  private async evidence(
    tx: Tx,
    actor: string,
    id: string,
    action: string,
    reason: string,
    before: unknown,
    after: unknown,
    generation: number,
  ) {
    await tx.auditLog.create({
      data: {
        id: randomUUID(),
        actorId: actor,
        resourceId: id,
        action,
        reason,
        before: before === null ? Prisma.DbNull : json(before),
        after: json(after),
      },
    });
    await tx.outbox.create({
      data: {
        id: randomUUID(),
        kind: action,
        aggregateId: id,
        generation,
        payload: json({ schemaVersion: 1, resourceId: id, actorId: actor, reason, after }),
      },
    });
  }

  create(actor: string, key: string, input: CreateProduct) {
    return this.mutate(actor, 'product:create', key, input, async (tx) => {
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO products (id,name,type,price_minor,subscription_days,digital_metadata)
        VALUES (${id}::uuid,${input.name},${input.type},${input.priceMinor}::numeric,
        ${input.subscriptionDays ?? null},${input.digitalMetadata === undefined ? null : JSON.stringify(input.digitalMetadata)}::jsonb)`;
      if (input.type === 'PHYSICAL') await tx.inventory.create({ data: { productId: id } });
      const after = await this.product(tx, id, true);
      await this.evidence(tx, actor, id, 'ProductCreated', input.reason, null, after, 1);
      return after;
    });
  }

  update(actor: string, id: string, key: string, input: UpdateProduct) {
    return this.mutate(actor, `product:update:${id}`, key, input, async (tx) => {
      await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
      const before = await this.product(tx, id, true);
      versionMatches(before.version, input.expectedVersion);
      if (input.subscriptionDays !== undefined && before.type !== 'SUBSCRIPTION')
        throw new BadRequestException('Not a subscription');
      if (input.digitalMetadata !== undefined && before.type !== 'DIGITAL')
        throw new BadRequestException('Not a digital product');
      await tx.$executeRaw`UPDATE products SET name=${input.name ?? before.name},
        price_minor=${input.priceMinor ?? before.priceMinor}::numeric,
        subscription_days=${input.subscriptionDays ?? before.subscriptionDays},
        digital_metadata=${(input.digitalMetadata ?? before.digitalMetadata) === null ? null : JSON.stringify(input.digitalMetadata ?? before.digitalMetadata)}::jsonb,
        version=version+1, updated_at=now() WHERE id=${id}::uuid`;
      const after = await this.product(tx, id, true);
      await this.evidence(
        tx,
        actor,
        id,
        'ProductUpdated',
        input.reason,
        before,
        after,
        after.version,
      );
      return after;
    });
  }

  deactivate(
    actor: string,
    id: string,
    key: string,
    input: { expectedVersion: number; reason: string },
  ) {
    return this.mutate(actor, `product:deactivate:${id}`, key, input, async (tx) => {
      await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
      const before = await this.product(tx, id, true);
      versionMatches(before.version, input.expectedVersion);
      await tx.product.update({
        where: { id },
        data: { active: false, version: { increment: 1 }, updatedAt: new Date() },
      });
      const after = await this.product(tx, id, true);
      await this.evidence(
        tx,
        actor,
        id,
        'ProductDeactivated',
        input.reason,
        before,
        after,
        after.version,
      );
      return after;
    });
  }

  stock(actor: string, id: string, key: string, input: AdjustInventory | ReconcileInventory) {
    const kind = 'delta' in input ? 'ADJUST' : 'RECONCILE';
    return this.mutate(actor, `inventory:${kind}:${id}`, key, input, async (tx) => {
      await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
      const product = await this.product(tx, id, true);
      if (product.type !== 'PHYSICAL')
        throw new BadRequestException('Only physical products have stock');
      await tx.$queryRaw`SELECT product_id FROM inventory WHERE product_id=${id}::uuid FOR UPDATE`;
      const before = await tx.inventory.findUniqueOrThrow({ where: { productId: id } });
      versionMatches(before.version, input.expectedVersion);
      const holds = await tx.reservation.findMany({
        where: { productId: id, status: { in: ['ACTIVE', 'PAYMENT_PENDING', 'ALLOCATED'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const held = holds.reduce((n, row) => n + BigInt(row.quantity), 0n);
      let next = before.available;
      let counted: bigint | null = before.observedOnHand;
      let discrepancyId: string | null = null;
      if ('delta' in input) {
        if (before.requiresReview)
          throw new ConflictException('Resolve the recorded stock discrepancy before adjusting');
        next += BigInt(input.delta);
        counted = null;
      } else {
        counted = BigInt(input.countedOnHand);
        next = counted > held ? counted - held : 0n;
        if (counted < held) {
          discrepancyId = randomUUID();
          await tx.inventoryDiscrepancy.create({
            data: {
              id: discrepancyId,
              productId: id,
              countedOnHand: counted,
              heldQuantity: held,
              shortage: held - counted,
              affectedReservations: json(
                holds.map((hold) => ({
                  id: hold.id,
                  itemId: hold.itemId,
                  generation: hold.generation,
                  quantity: hold.quantity,
                  status: hold.status,
                })),
              ),
            },
          });
          await tx.reviewCase.create({
            data: {
              id: randomUUID(),
              resourceId: id,
              reason: 'STOCK_SHORTAGE',
              metadata: { discrepancyId },
            },
          });
        }
      }
      if (next < 0n)
        throw new ConflictException('Adjustment would make sellable inventory negative');
      if (before.requiresReview && next > 0n)
        throw new ConflictException(
          'An open discrepancy requires explicit resolution before relisting stock',
        );
      if (next > 9223372036854775807n)
        throw new ConflictException('Inventory storage range exceeded');
      const after = await tx.inventory.update({
        where: { productId: id },
        data: {
          available: next,
          observedOnHand: counted,
          requiresReview: before.requiresReview || discrepancyId !== null,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      const result = {
        productId: id,
        available: after.available.toString(),
        version: after.version,
        heldQuantity: held.toString(),
        requiresReview: after.requiresReview,
        discrepancyId,
      };
      await tx.inventoryAdjustment.create({
        data: {
          id: randomUUID(),
          productId: id,
          actorId: actor,
          kind,
          delta: next - before.available,
          beforeAvailable: before.available,
          afterAvailable: next,
          reason: input.reason,
        },
      });
      await this.evidence(
        tx,
        actor,
        id,
        `Inventory${kind === 'ADJUST' ? 'Adjusted' : 'Reconciled'}`,
        input.reason,
        { available: before.available.toString(), version: before.version },
        result,
        after.version,
      );
      return result;
    });
  }
  audit(id: string) {
    return this.db.auditLog.findMany({
      where: { resourceId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  async discrepancies(id: string) {
    return (
      await this.db.inventoryDiscrepancy.findMany({
        where: { productId: id },
        take: 100,
        orderBy: { createdAt: 'desc' },
      })
    ).map((row) => ({
      ...row,
      countedOnHand: row.countedOnHand.toString(),
      heldQuantity: row.heldQuantity.toString(),
      shortage: row.shortage.toString(),
    }));
  }
  async reviews(limit: number, cursor?: string) {
    if (
      cursor &&
      !(await this.db.store.query('SELECT id FROM review_cases WHERE id=$1', [cursor])).length
    )
      throw new NotFoundException('Review cursor not found');
    const rows = await this.db.store.query(
      `SELECT id,resource_id AS "resourceId",reason,status,metadata,created_at AS "createdAt" FROM review_cases WHERE status='OPEN' AND ($1::uuid IS NULL OR (created_at,id)>(SELECT created_at,id FROM review_cases WHERE id=$1)) ORDER BY created_at,id LIMIT $2`,
      [cursor ?? null, limit + 1],
    );
    return {
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
}
