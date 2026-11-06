import { randomUUID } from 'node:crypto';
import {
  connect,
  type ChannelModel,
  type Channel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import { z } from 'zod';
import { logRecord } from './logger.js';

/** Infrastructure only: each owner supplies its own pool and domain handler. */
export interface Sql {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;
}
export interface SqlStore extends Sql {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
}
export const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    producer: z.enum(['commerce', 'billing']),
    kind: z.string().min(1).max(100),
    aggregateId: z.uuid(),
    generation: z.int().nonnegative(),
    correlationId: z.string().min(1).max(80),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export class InvalidMessage extends Error {}
export function retryDelay(attempts: number) {
  return Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)) + Math.floor(Math.random() * 501);
}

export class OutboxWorker {
  private connection?: ChannelModel;
  private publisher?: ConfirmChannel;
  private consumer?: Channel;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private deliveries = new Set<Promise<void>>();
  private stopped = false;
  private nextConnectionAt = 0;
  private connectionFailures = 0;
  constructor(
    private readonly owner: 'commerce' | 'billing',
    private readonly url: string,
    private readonly store: SqlStore,
    private readonly handle: (sql: Sql, envelope: Envelope) => Promise<void>,
  ) {}

  start() {
    this.timer = setInterval(() => {
      this.running ??= this.tick().finally(() => {
        this.running = undefined;
      });
    }, 500);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.consumer?.cancel(`${this.owner}-inbox`).catch(() => undefined);
    await this.running;
    await Promise.allSettled([...this.deliveries]);
    await this.connection?.close().catch(() => undefined);
  }
  private async disconnect() {
    const connection = this.connection;
    this.connection = undefined;
    this.publisher = undefined;
    this.consumer = undefined;
    await connection?.close().catch(() => undefined);
  }
  private async ensureConnection() {
    if (this.publisher && this.consumer) return;
    const connection = await connect(this.url, { timeout: 1500 });
    this.connection = connection;
    connection.on('error', () => logRecord(this.owner, 'warn', 'transport_connection_error'));
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.publisher = undefined;
        this.consumer = undefined;
      }
    });
    const publisher = await connection.createConfirmChannel();
    publisher.on('error', () => logRecord(this.owner, 'warn', 'publisher_channel_error'));
    publisher.on('close', () => {
      if (this.publisher === publisher) void this.disconnect();
    });
    const consumer = await connection.createChannel();
    consumer.on('error', () => logRecord(this.owner, 'warn', 'consumer_channel_error'));
    consumer.on('close', () => {
      if (this.consumer === consumer) void this.disconnect();
    });
    const other = this.owner === 'commerce' ? 'billing' : 'commerce';
    await publisher.assertExchange(`${this.owner}.events`, 'topic', { durable: true });
    const queue = `${this.owner}.q.events`;
    await consumer.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-max-length': 1000,
        'x-max-length-bytes': 16777216,
        'x-overflow': 'reject-publish',
      },
    });
    await consumer.bindQueue(queue, `${other}.events`, '#');
    await consumer.prefetch(2);
    this.publisher = publisher;
    this.consumer = consumer;
    await consumer.consume(
      queue,
      (message) => {
        if (!message) {
          if (this.consumer === consumer) void this.disconnect();
          return;
        }
        if (this.stopped) return;
        const pending = this.stage(consumer, message, other)
          .catch(async () => {
            // Do not immediately requeue when SQL is down: close the channel and reconnect on the bounded tick.
            if (this.consumer === consumer) {
              this.nextConnectionAt = Date.now() + retryDelay(this.connectionFailures++);
              await this.disconnect();
            }
          })
          .finally(() => this.deliveries.delete(pending));
        this.deliveries.add(pending);
      },
      { consumerTag: `${this.owner}-inbox` },
    );
  }
  private async stage(channel: Channel, message: ConsumeMessage, producer: string) {
    let parsed: Envelope | undefined;
    try {
      if (message.content.length > 262144) throw new InvalidMessage('oversized_envelope');
      parsed = envelopeSchema.parse(JSON.parse(message.content.toString('utf8')));
      if (
        parsed.producer !== producer ||
        parsed.kind !== message.fields.routingKey ||
        message.properties.messageId !== parsed.id
      )
        throw new InvalidMessage('invalid_producer_or_routing');
    } catch {
      await this.store.query(
        `INSERT INTO message_quarantine(id,consumer,reason,evidence) VALUES($1,$2,'INVALID_ENVELOPE',$3::jsonb) RETURNING id`,
        [
          randomUUID(),
          `${this.owner}-events`,
          JSON.stringify({
            messageId: message.properties.messageId ?? null,
            bytes: message.content.length,
          }),
        ],
      );
      channel.ack(message);
      return;
    }
    const envelope = parsed;
    await this.store.transaction(async (sql) => {
      // Bound durable pending staging too. Full inbox -> no ACK; the bounded broker queue
      // applies backpressure to mandatory publishers, whose accepted work remains in SQL.
      // This owner-local transaction lock serializes capacity checks across replicas.
      await sql.query('SELECT pg_advisory_xact_lock(7482001)::text AS acquired');
      const full = await sql.query(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM inbox_messages WHERE consumer=$1 AND message_id=$2)
        AND (SELECT count(*) FROM (SELECT 1 FROM inbox_messages WHERE status='PENDING' LIMIT 10000) pending)>=10000`,
        [`${this.owner}-events`, envelope.id],
      );
      if (full.length) throw new Error('Durable inbox at capacity');
      const rows = await sql.query<{ envelope: unknown }>(
        `INSERT INTO inbox_messages(consumer,message_id,envelope)
        VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING envelope`,
        [`${this.owner}-events`, envelope.id, JSON.stringify(envelope)],
      );
      if (!rows.length) {
        const same = await sql.query(
          `SELECT 1 FROM inbox_messages WHERE consumer=$1 AND message_id=$2 AND envelope=$3::jsonb`,
          [`${this.owner}-events`, envelope.id, JSON.stringify(envelope)],
        );
        if (!same.length)
          await sql.query(
            `INSERT INTO message_quarantine(id,consumer,reason,evidence)
          VALUES($1,$2,'MESSAGE_ID_COLLISION',$3::jsonb) RETURNING id`,
            [randomUUID(), `${this.owner}-events`, JSON.stringify(envelope)],
          );
      }
    });
    channel.ack(message); // SQL owns recovery only after the durable inbox commit.
  }
  private async publishOne() {
    const token = randomUUID();
    const rows = await this.store.query<{
      id: string;
      kind: string;
      aggregate_id: string;
      generation: number;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      `UPDATE outbox SET claim_token=$1,lease_until=clock_timestamp()+interval '15 seconds',attempts=attempts+1
      WHERE id=(SELECT id FROM outbox WHERE published_at IS NULL AND available_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,kind,aggregate_id,generation,payload,attempts`,
      [token],
    );
    const row = rows[0];
    if (!row) return false;
    const publisher = this.publisher!;
    let returned = false;
    const onReturn = () => {
      returned = true;
    };
    publisher.on('return', onReturn);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const envelope: Envelope = {
        schemaVersion: 1,
        id: row.id,
        producer: this.owner,
        kind: row.kind,
        aggregateId: row.aggregate_id,
        generation: row.generation,
        correlationId:
          typeof row.payload.correlationId === 'string' ? row.payload.correlationId : row.id,
        payload: row.payload,
      };
      const content = Buffer.from(JSON.stringify(envelope));
      if (content.length > 262144) throw new Error('Envelope exceeds transport bound');
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          publisher.publish(
            `${this.owner}.events`,
            row.kind,
            content,
            {
              persistent: true,
              mandatory: true,
              contentType: 'application/json',
              messageId: row.id,
              correlationId: envelope.correlationId,
            },
            (error) => (error ? reject(error) : resolve()),
          );
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Publish timeout')), 3000);
        }),
      ]);
      if (returned) throw new Error('Unroutable event');
      await this.store.query(
        `UPDATE outbox SET published_at=clock_timestamp(),claim_token=NULL,lease_until=NULL
        WHERE id=$1 AND claim_token=$2 RETURNING id`,
        [row.id, token],
      );
    } catch {
      await this.store.query(
        `UPDATE outbox SET claim_token=NULL,lease_until=NULL,available_at=clock_timestamp()+$3*interval '1 millisecond'
        WHERE id=$1 AND claim_token=$2 RETURNING id`,
        [row.id, token, retryDelay(row.attempts)],
      );
      await this.disconnect();
      logRecord(this.owner, 'warn', 'outbox_publish_deferred', { messageId: row.id });
    } finally {
      clearTimeout(timeout);
      publisher.off('return', onReturn);
    }
    return true;
  }
  private async consumeOne() {
    await this.store.transaction(async (sql) => {
      const rows = await sql.query<{ message_id: string; envelope: Envelope; attempts: number }>(
        `SELECT message_id,envelope,attempts FROM inbox_messages
        WHERE consumer=$1 AND status='PENDING' AND available_at<=clock_timestamp() ORDER BY available_at,message_id
        FOR UPDATE SKIP LOCKED LIMIT 1`,
        [`${this.owner}-events`],
      );
      const row = rows[0];
      if (!row) return;
      // Savepoint rolls back partial domain effects before recording a durable retry/quarantine.
      await sql.query('SAVEPOINT domain_effect');
      try {
        const receipt = await sql.query(
          `INSERT INTO consumer_receipts(consumer,message_id) VALUES($1,$2)
          ON CONFLICT DO NOTHING RETURNING message_id`,
          [`${this.owner}-events`, row.message_id],
        );
        if (receipt.length) await this.handle(sql, row.envelope);
        await sql.query(
          `UPDATE inbox_messages SET status='DONE',last_error=NULL WHERE consumer=$1 AND message_id=$2 RETURNING message_id`,
          [`${this.owner}-events`, row.message_id],
        );
      } catch (error) {
        await sql.query('ROLLBACK TO SAVEPOINT domain_effect');
        const invalid = error instanceof InvalidMessage;
        await sql.query(
          `UPDATE inbox_messages SET attempts=attempts+1,status=$3,last_error=$4,
          available_at=clock_timestamp()+$5*interval '1 millisecond' WHERE consumer=$1 AND message_id=$2 RETURNING message_id`,
          [
            `${this.owner}-events`,
            row.message_id,
            invalid ? 'QUARANTINED' : 'PENDING',
            invalid ? error.message.slice(0, 80) : 'TRANSIENT_HANDLER_FAILURE',
            retryDelay(row.attempts),
          ],
        );
        logRecord(this.owner, 'warn', invalid ? 'inbox_quarantined' : 'inbox_deferred', {
          messageId: row.message_id,
        });
      }
    });
  }
  private async tick() {
    if (this.stopped) return;
    // Accepted inbox work progresses even during broker outages.
    try {
      for (let i = 0; i < 4 && !this.stopped; i++) await this.consumeOne();
    } catch {
      logRecord(this.owner, 'warn', 'inbox_database_unavailable');
    }
    try {
      if (Date.now() < this.nextConnectionAt) return;
      await this.ensureConnection();
      this.connectionFailures = 0;
      for (let i = 0; i < 4 && !this.stopped && this.publisher; i++)
        if (!(await this.publishOne())) break;
    } catch {
      this.nextConnectionAt = Date.now() + retryDelay(this.connectionFailures++);
      await this.disconnect();
    }
  }
}
