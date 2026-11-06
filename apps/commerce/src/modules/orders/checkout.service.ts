import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { CommerceDatabase } from '../../database.js';
import type { Sql } from '../../../../../packages/runtime/src/outbox.js';
import { fingerprint } from '../../../../../packages/runtime/src/validation.js';
import { canonicalLines, type Line } from './contracts.js';

interface Order {
  id: string;
  customer_id: string;
  status: string;
  checkout_revision: number;
  checkout_expires_at: Date | null;
  preparation_version: number;
}
interface Product {
  id: string;
  name: string;
  type: string;
  price: string;
  subscription_days: number | null;
  active: boolean;
}
interface Item {
  id: string;
  product_id: string;
  name: string;
  type: string;
  quantity: number;
  price: string;
  subscription_days: number | null;
}
const editable = ['CHECKOUT_RESERVED', 'CHECKOUT_EXPIRED', 'BASKET_CHANGED'];
@Injectable()
export class CheckoutService {
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private activeCreates = 0;
  private pressureUntil = 0;
  private readonly pressureTimer = setInterval(() => {
    if (Number(this.lag.mean) / 1e6 > 200) this.pressureUntil = Date.now() + 3000;
    this.lag.reset();
  }, 1000).unref();
  private readonly inFlight = new Map<string, { digest: string; promise: Promise<string> }>();
  constructor(private readonly db: CommerceDatabase) {
    this.lag.enable();
  }
  onModuleDestroy() {
    clearInterval(this.pressureTimer);
    this.lag.disable();
  }

  async detail(sql: Sql, id: string, customer: string, admin = false) {
    const orders = await sql.query(
      `SELECT id,customer_id AS "customerId",status,currency,total_minor::text AS "totalMinor",
      checkout_revision AS "checkoutRevision",checkout_expires_at AS "expiresAt",preparation_version AS "preparationVersion",
      preparation_version<checkout_revision AS "preparationPending",created_at AS "createdAt"
      FROM orders WHERE id=$1::uuid AND (customer_id=$2 OR $3)`,
      [id, customer, admin],
    );
    if (!orders[0]) throw new NotFoundException('Order not found');
    const items = await sql.query(
      `SELECT id,product_id AS "productId",name,type,quantity,unit_price_minor::text AS "unitPriceMinor",
      line_total_minor::text AS "lineTotalMinor",subscription_days AS "subscriptionDays",status,disposition
      FROM order_items WHERE order_id=$1::uuid ORDER BY id`,
      [id],
    );
    const revisions = await sql.query(
      `SELECT version,snapshot,confirmed,total_minor::text AS "totalMinor" FROM checkout_revisions
      WHERE order_id=$1::uuid ORDER BY version DESC LIMIT 1`,
      [id],
    );
    const holds = await sql.query(
      `SELECT r.id,r.item_id AS "itemId",r.generation,r.quantity,r.status,r.expires_at AS "expiresAt"
      FROM reservations r JOIN order_items i ON i.id=r.item_id WHERE i.order_id=$1::uuid AND r.status IN ('ACTIVE','PAYMENT_PENDING','ALLOCATED','DISPUTED') ORDER BY r.id`,
      [id],
    );
    const finance = await sql.query(
      `SELECT revision,source_version AS "sourceVersion",status,pending,refunded_minor::text AS "refundedMinor",
      pending_refund_minor::text AS "pendingRefundMinor",updated_at AS "updatedAt" FROM order_financial_projections WHERE order_id=$1::uuid`,
      [id],
    );
    const events = await sql.query(
      `SELECT id,type,metadata,created_at AS "createdAt" FROM order_events WHERE order_id=$1::uuid
      ORDER BY created_at DESC,id DESC LIMIT 100`,
      [id],
    );
    return {
      ...orders[0],
      items,
      reservations: holds,
      checkout: revisions[0] ?? null,
      financial: finance[0] ?? {
        sourceVersion: 0,
        status: 'NOT_REQUESTED',
        pending: false,
        refundedMinor: '0',
        pendingRefundMinor: '0',
      },
      events,
    };
  }
  get(id: string, customer: string, admin = false) {
    // One SQL snapshot for a coherent order/revision/financial response.
    return this.db.store.transaction(async (sql) => {
      await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return this.detail(sql, id, customer, admin);
    });
  }
  async list(customer: string, limit: number, cursor?: string) {
    return this.db.store.transaction(async (sql) => {
      await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      let after: { created_at: Date; id: string } | undefined;
      if (cursor) {
        after = (
          await sql.query<{ created_at: Date; id: string }>(
            'SELECT id,created_at FROM orders WHERE id=$1 AND customer_id=$2',
            [cursor, customer],
          )
        )[0];
        if (!after) throw new BadRequestException('Invalid cursor');
      }
      const rows = await sql.query(
        `SELECT id,status,currency,total_minor::text AS "totalMinor",checkout_revision AS "checkoutRevision",
        checkout_expires_at AS "expiresAt",preparation_version AS "preparationVersion",created_at AS "createdAt"
        FROM orders WHERE customer_id=$1 AND ($2::uuid IS NULL OR (created_at,id)>
          (SELECT created_at,id FROM orders WHERE id=$2::uuid AND customer_id=$1))
        ORDER BY created_at,id LIMIT $3`,
        [customer, after?.id ?? null, limit + 1],
      );
      return {
        items: rows.slice(0, limit),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    });
  }
  private pressure() {
    return (
      this.activeCreates >= 8 ||
      process.memoryUsage().rss > 512 * 1024 * 1024 ||
      Date.now() < this.pressureUntil
    );
  }
  private async acquire(sql: Sql, id: string) {
    const budget = await sql.query(
      `UPDATE admission_budget SET used=used+1 WHERE id=1 AND accepting_new AND used<capacity
        AND (SELECT count(*) FROM (SELECT 1 FROM outbox WHERE published_at IS NULL LIMIT 10000) backlog)<10000
        AND (SELECT count(*) FROM (SELECT 1 FROM inbox_messages WHERE status='PENDING' LIMIT 10000) backlog)<10000
        RETURNING id`,
    );
    if (!budget.length)
      throw new ServiceUnavailableException(
        'New checkout capacity exhausted; retry later with the same key',
      );
    await sql.query(
      `INSERT INTO admission_slots(order_id) VALUES($1) ON CONFLICT(order_id) DO UPDATE SET released_at=NULL RETURNING order_id`,
      [id],
    );
  }
  private async releaseSlot(sql: Sql, id: string) {
    const released = await sql.query(
      `UPDATE admission_slots SET released_at=clock_timestamp() WHERE order_id=$1 AND released_at IS NULL RETURNING order_id`,
      [id],
    );
    if (released.length)
      await sql.query('UPDATE admission_budget SET used=used-1 WHERE id=1 RETURNING id');
  }
  private async products(sql: Sql, ids: string[]) {
    const rows = await sql.query<Product>(
      `SELECT id,name,type,price_minor::text AS price,subscription_days,active FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    await sql.query(
      'SELECT product_id FROM inventory WHERE product_id=ANY($1::uuid[]) ORDER BY product_id FOR UPDATE',
      [ids],
    );
    return new Map(rows.map((p) => [p.id, p]));
  }
  private async reserve(sql: Sql, item: Item, generation: number, expires: Date) {
    if (item.type !== 'PHYSICAL') return;
    const updated = await sql.query(
      `UPDATE inventory SET available=available-$2,version=version+1,updated_at=clock_timestamp()
      WHERE product_id=$1::uuid AND NOT requires_review AND available>=$2 RETURNING product_id`,
      [item.product_id, item.quantity],
    );
    if (!updated.length)
      throw new ConflictException({ message: 'Insufficient stock', productId: item.product_id });
    await sql.query(
      `INSERT INTO reservations(id,item_id,product_id,generation,quantity,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [randomUUID(), item.id, item.product_id, generation, item.quantity, expires],
    );
  }
  private async event(sql: Sql, id: string, type: string, metadata: unknown) {
    await sql.query(
      'INSERT INTO order_events(id,order_id,type,metadata) VALUES($1,$2,$3,$4::jsonb) RETURNING id',
      [randomUUID(), id, type, JSON.stringify(metadata)],
    );
  }
  private async snapshot(
    sql: Sql,
    id: string,
    version: number,
    items: Item[],
    changes: unknown[],
    confirmed: boolean,
    correlationId: string,
  ) {
    const lines = items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      name: i.name,
      type: i.type,
      quantity: i.quantity,
      unitPriceMinor: i.price,
      lineTotalMinor: (BigInt(i.price) * BigInt(i.quantity)).toString(),
      subscriptionDays: i.subscription_days,
    }));
    const total = lines.reduce((sum, line) => sum + BigInt(line.lineTotalMinor), 0n).toString();
    await sql.query(
      `INSERT INTO checkout_revisions(order_id,version,snapshot,total_minor,confirmed) VALUES($1,$2,$3::jsonb,$4::numeric,$5) RETURNING order_id`,
      [id, version, JSON.stringify({ items: lines, changes }), total, confirmed],
    );
    await sql.query('UPDATE orders SET total_minor=$2::numeric WHERE id=$1 RETURNING id', [
      id,
      total,
    ]);
    const order = (
      await sql.query<{ customer_id: string }>('SELECT customer_id FROM orders WHERE id=$1', [id])
    )[0]!;
    await sql.query(
      `INSERT INTO outbox(id,kind,aggregate_id,generation,payload) VALUES($1,'CheckoutPrepared',$2,$3,$4::jsonb) RETURNING id`,
      [
        randomUUID(),
        id,
        version,
        JSON.stringify({
          schemaVersion: 1,
          orderId: id,
          customerId: order.customer_id,
          revision: version,
          totalMinor: total,
          currency: 'IRR',
          items: lines,
          correlationId,
        }),
      ],
    );
    await sql.query(
      `INSERT INTO order_financial_projections(order_id,revision) VALUES($1,$2) ON CONFLICT(order_id)
      DO UPDATE SET revision=EXCLUDED.revision,updated_at=clock_timestamp() RETURNING order_id`,
      [id, version],
    );
    await this.event(sql, id, version === 1 ? 'CheckoutReserved' : 'CheckoutRevised', {
      version,
      changes,
      correlationId,
    });
  }
  async create(customer: string, key: string, input: Line[], correlationId: string) {
    const lines = canonicalLines(input);
    const digest = fingerprint({ items: lines });
    // Cheap replay path precedes admission/pressure. Transactional unique claim is still the arbiter.
    const existing = await this.db.store.query<{
      fingerprint: string;
      response: { orderId: string };
    }>(
      "SELECT fingerprint,response FROM idempotency_records WHERE actor_id=$1 AND operation='order:create' AND key=$2",
      [customer, key],
    );
    if (existing[0]) {
      if (existing[0].fingerprint !== digest)
        throw new ConflictException('Idempotency key payload differs');
      return this.get(existing[0].response.orderId, customer);
    }
    const identity = JSON.stringify([customer, key]);
    const pending = this.inFlight.get(identity);
    if (pending) {
      if (pending.digest !== digest) throw new ConflictException('Idempotency key payload differs');
      return this.get(await pending.promise, customer);
    }
    if (this.pressure())
      throw new ServiceUnavailableException(
        'New checkout temporarily throttled; retry with the same key',
      );
    this.activeCreates++;
    const creation = this.db.store.transaction(async (sql) => {
      const id = randomUUID();
      const claimed = await sql.query(
        `INSERT INTO idempotency_records(id,actor_id,operation,key,fingerprint,response)
          VALUES($1,$2,'order:create',$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [randomUUID(), customer, key, digest, JSON.stringify({ orderId: id })],
      );
      if (!claimed.length) {
        const row = (
          await sql.query<{ fingerprint: string; response: { orderId: string } }>(
            "SELECT fingerprint,response FROM idempotency_records WHERE actor_id=$1 AND operation='order:create' AND key=$2",
            [customer, key],
          )
        )[0]!;
        if (row.fingerprint !== digest)
          throw new ConflictException('Idempotency key payload differs');
        return row.response.orderId;
      }
      await sql.query(
        `INSERT INTO orders(id,customer_id,total_minor,checkout_expires_at) VALUES($1,$2,0,clock_timestamp()+interval '5 minutes') RETURNING id`,
        [id, customer],
      );
      await this.acquire(sql, id);
      const products = await this.products(
        sql,
        lines.map((line) => line.productId),
      );
      const expires = (
        await sql.query<{ expires: Date }>(
          'SELECT checkout_expires_at AS expires FROM orders WHERE id=$1',
          [id],
        )
      )[0]!.expires;
      const items: Item[] = [];
      for (const line of lines) {
        const product = products.get(line.productId);
        if (!product?.active)
          throw new BadRequestException({
            message: 'Product unavailable',
            productId: line.productId,
          });
        if (product.type !== 'PHYSICAL' && line.quantity !== 1)
          throw new BadRequestException(
            'Digital/subscription products must be unique with quantity 1',
          );
        const item: Item = {
          id: randomUUID(),
          product_id: product.id,
          name: product.name,
          type: product.type,
          quantity: line.quantity,
          price: product.price,
          subscription_days: product.subscription_days,
        };
        await sql.query(
          `INSERT INTO order_items(id,order_id,product_id,name,type,quantity,unit_price_minor,line_total_minor,subscription_days)
            VALUES($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9) RETURNING id`,
          [
            item.id,
            id,
            item.product_id,
            item.name,
            item.type,
            item.quantity,
            item.price,
            (BigInt(item.price) * BigInt(item.quantity)).toString(),
            item.subscription_days,
          ],
        );
        await this.reserve(sql, item, 1, expires);
        items.push(item);
      }
      await this.snapshot(sql, id, 1, items, [], true, correlationId);
      return id;
    });
    this.inFlight.set(identity, { digest, promise: creation });
    try {
      return await this.get(await creation, customer);
    } finally {
      this.activeCreates--;
      this.inFlight.delete(identity);
    }
  }
  private async lock(sql: Sql, id: string, customer?: string, skip = false) {
    const rows = await sql.query<Order>(
      `SELECT id,customer_id,status,checkout_revision,checkout_expires_at,preparation_version FROM orders
      WHERE id=$1::uuid AND ($2::text IS NULL OR customer_id=$2) FOR UPDATE ${skip ? 'SKIP LOCKED' : ''}`,
      [id, customer ?? null],
    );
    if (!rows[0] && !skip) throw new NotFoundException('Order not found');
    return rows[0];
  }
  private async expireLocked(sql: Sql, order: Order) {
    if (!editable.includes(order.status) || order.status === 'CHECKOUT_EXPIRED') return false;
    const due = await sql.query(
      `SELECT 1 FROM orders WHERE id=$1 AND checkout_expires_at<=clock_timestamp()`,
      [order.id],
    );
    if (!due.length) return false;
    // Admission is a shared lock: take it before stock, just as create/reacquisition do.
    // Taking it only while releasing the slot would invert create's budget -> stock order.
    await sql.query('SELECT id FROM admission_budget WHERE id=1 FOR UPDATE');
    const items = await sql.query<{ product_id: string }>(
      'SELECT product_id FROM order_items WHERE order_id=$1 ORDER BY id FOR UPDATE',
      [order.id],
    );
    await this.products(
      sql,
      items.map((i) => i.product_id),
    );
    const holds = await sql.query<{ id: string; product_id: string; quantity: number }>(
      `SELECT r.id,r.product_id,r.quantity FROM reservations r JOIN order_items i ON i.id=r.item_id
      WHERE i.order_id=$1 AND r.status='ACTIVE' AND r.expires_at<=clock_timestamp() ORDER BY r.id FOR UPDATE OF r`,
      [order.id],
    );
    for (const hold of holds) {
      await sql.query(
        "UPDATE reservations SET status='EXPIRED' WHERE id=$1 AND status='ACTIVE' RETURNING id",
        [hold.id],
      );
      // An admin miscount must never turn nonexistent held units into sellable stock.
      await sql.query(
        `UPDATE inventory SET available=CASE WHEN requires_review THEN available ELSE available+$2 END,
        version=version+1,updated_at=clock_timestamp() WHERE product_id=$1 RETURNING product_id`,
        [hold.product_id, hold.quantity],
      );
    }
    await sql.query(
      "UPDATE orders SET status='CHECKOUT_EXPIRED',updated_at=clock_timestamp() WHERE id=$1 RETURNING id",
      [order.id],
    );
    await this.releaseSlot(sql, order.id);
    await this.event(sql, order.id, 'CheckoutExpired', { revision: order.checkout_revision });
    order.status = 'CHECKOUT_EXPIRED';
    return true;
  }
  async expireBatch() {
    const rows = await this.db.store.query<{
      id: string;
    }>(`SELECT id FROM orders WHERE status IN ('CHECKOUT_RESERVED','BASKET_CHANGED')
      AND checkout_expires_at<=clock_timestamp() ORDER BY checkout_expires_at,id LIMIT 8`);
    for (const row of rows)
      await this.db.store.transaction(async (sql) => {
        const order = await this.lock(sql, row.id, undefined, true);
        if (order) await this.expireLocked(sql, order);
      });
  }
  async refresh(id: string, customer: string, revision: number, correlationId: string) {
    await this.db.store.transaction(async (sql) => {
      const order = (await this.lock(sql, id, customer))!;
      if (order.checkout_revision !== revision)
        throw new ConflictException('Checkout revision changed; reload order');
      if (!editable.includes(order.status))
        throw new ConflictException('Checkout is no longer editable');
      await this.expireLocked(sql, order);
      if (order.status !== 'CHECKOUT_EXPIRED') return; // No timer renewal for an active hold.
      if (this.pressure())
        throw new ServiceUnavailableException('Checkout reacquisition temporarily throttled');
      await this.acquire(sql, id);
      const items = await sql.query<Item>(
        `SELECT id,product_id,name,type,quantity,unit_price_minor::text AS price,subscription_days
        FROM order_items WHERE order_id=$1 AND status<>'CANCELLED' ORDER BY id FOR UPDATE`,
        [id],
      );
      const products = await this.products(
        sql,
        items.map((i) => i.product_id),
      );
      const next = revision + 1;
      const expires = (
        await sql.query<{ expires: Date }>(
          "SELECT clock_timestamp()+interval '5 minutes' AS expires",
        )
      )[0]!.expires;
      const payable: Item[] = [];
      const changes: unknown[] = [];
      for (const item of items) {
        const product = products.get(item.product_id);
        let quantity = product?.active ? item.quantity : 0;
        if (quantity && item.type === 'PHYSICAL') {
          const stock = (
            await sql.query<{ available: bigint; requires_review: boolean }>(
              'SELECT available,requires_review FROM inventory WHERE product_id=$1',
              [item.product_id],
            )
          )[0]!;
          quantity = stock.requires_review
            ? 0
            : Number(
                BigInt(quantity) < BigInt(stock.available)
                  ? BigInt(quantity)
                  : BigInt(stock.available),
              );
        }
        if (
          quantity !== item.quantity ||
          (quantity &&
            product &&
            (item.price !== product.price ||
              item.name !== product.name ||
              item.subscription_days !== product.subscription_days))
        ) {
          changes.push({
            productId: item.product_id,
            previousQuantity: item.quantity,
            quantity,
            previousUnitPriceMinor: item.price,
            unitPriceMinor: product?.price ?? item.price,
            reason: !product?.active
              ? 'PRODUCT_UNAVAILABLE'
              : quantity !== item.quantity
                ? 'STOCK_CHANGED'
                : 'CATALOG_CHANGED',
          });
        }
        if (!quantity) {
          await sql.query(
            "UPDATE order_items SET status='CANCELLED',disposition='CANCEL' WHERE id=$1 RETURNING id",
            [item.id],
          );
          continue;
        }
        item.quantity = quantity;
        item.price = product!.price;
        item.name = product!.name;
        item.subscription_days = product!.subscription_days;
        await sql.query(
          `UPDATE order_items SET name=$2,quantity=$3,unit_price_minor=$4::numeric,line_total_minor=$5::numeric,subscription_days=$6 WHERE id=$1 RETURNING id`,
          [
            item.id,
            item.name,
            item.quantity,
            item.price,
            (BigInt(item.price) * BigInt(item.quantity)).toString(),
            item.subscription_days,
          ],
        );
        await this.reserve(sql, item, next, expires);
        payable.push(item);
      }
      await sql.query(
        `UPDATE orders SET checkout_revision=$2,status=$3,checkout_expires_at=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING id`,
        [
          id,
          next,
          changes.length || !payable.length ? 'BASKET_CHANGED' : 'CHECKOUT_RESERVED',
          expires,
        ],
      );
      await this.snapshot(
        sql,
        id,
        next,
        payable,
        changes,
        !changes.length && payable.length > 0,
        correlationId,
      );
      if (!payable.length) await this.releaseSlot(sql, id);
    });
    return this.get(id, customer);
  }
  async confirm(id: string, customer: string, revision: number) {
    await this.db.store.transaction(async (sql) => {
      const order = (await this.lock(sql, id, customer))!;
      if (order.checkout_revision !== revision)
        throw new ConflictException('Checkout revision changed; reload order');
      if (!editable.includes(order.status))
        throw new ConflictException('Checkout is no longer editable');
      await this.expireLocked(sql, order);
      if (order.status === 'CHECKOUT_EXPIRED') return;
      const lines = await sql.query(
        "SELECT id FROM order_items WHERE order_id=$1 AND status<>'CANCELLED'",
        [id],
      );
      if (!lines.length) throw new ConflictException('Basket is empty; start a new checkout');
      const confirmed = await sql.query(
        'UPDATE checkout_revisions SET confirmed=true WHERE order_id=$1 AND version=$2 AND NOT confirmed RETURNING order_id',
        [id, revision],
      );
      await sql.query(
        "UPDATE orders SET status='CHECKOUT_RESERVED',updated_at=clock_timestamp() WHERE id=$1 RETURNING id",
        [id],
      );
      if (confirmed.length) await this.event(sql, id, 'CheckoutConfirmed', { revision });
    });
    return this.get(id, customer);
  }
}
