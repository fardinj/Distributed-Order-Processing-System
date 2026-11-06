import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { connect, type ChannelModel } from 'amqplib';
import { createClient } from 'redis';
import type { ServiceConfig } from './config.js';
import { logRecord } from './logger.js';

export const CONFIG = Symbol('service-config');
export interface DependencyState {
  status: 'up' | 'down';
  required: boolean;
}
export type DependencyReport = Record<string, DependencyState>;

export function readiness(report: DependencyReport) {
  const states = Object.values(report);
  return {
    ready: states.every((entry) => !entry.required || entry.status === 'up'),
    degraded: states.some((entry) => !entry.required && entry.status === 'down'),
  };
}

@Injectable()
export class Dependencies implements OnModuleDestroy {
  private readonly pool?: Pool;
  private readonly redis?: ReturnType<typeof createClient>;
  private rabbit?: ChannelModel;
  private rabbitConnecting?: Promise<void>;
  private redisConnecting?: Promise<unknown>;
  private shuttingDown = false;

  constructor(@Inject(CONFIG) private readonly config: ServiceConfig) {
    if (config.database) {
      this.pool = new Pool({
        ...config.database,
        connectionTimeoutMillis: 1500,
        idleTimeoutMillis: 10000,
        query_timeout: 1500,
        application_name: config.name,
      });
      this.pool.on('error', () => logRecord(config.name, 'warn', 'idle_database_connection_error'));
    }
    if (config.redis) {
      this.redis = createClient({
        ...config.redis,
        socket: { connectTimeout: 1000, reconnectStrategy: false },
        disableOfflineQueue: true,
      });
      this.redis.on('error', () => logRecord(config.name, 'warn', 'redis_unavailable'));
    }
  }

  private async rabbitCheck(): Promise<void> {
    if (this.rabbit) return;
    if (!this.rabbitConnecting) {
      this.rabbitConnecting = (async () => {
        const connection = await connect(this.config.rabbit!.url, { timeout: 1500 });
        connection.on('error', () =>
          logRecord(this.config.name, 'warn', 'rabbit_connection_error'),
        );
        connection.on('close', () => {
          if (this.rabbit === connection) this.rabbit = undefined;
        });
        if (this.shuttingDown) {
          await connection.close();
          return;
        }
        this.rabbit = connection;
      })().finally(() => {
        this.rabbitConnecting = undefined;
      });
    }
    await this.rabbitConnecting;
  }

  private async redisCheck(): Promise<void> {
    const client = this.redis!;
    if (!client.isOpen) {
      this.redisConnecting ??= client.connect().finally(() => {
        this.redisConnecting = undefined;
      });
      await this.redisConnecting;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.ping(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // Cancel a stalled command too, not only the HTTP health request.
            if (client.isOpen) client.destroy();
            reject(new Error('Redis probe timed out'));
          }, 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async report(): Promise<DependencyReport> {
    const report: DependencyReport = {};
    const probe = async (name: string, required: boolean, check: () => Promise<unknown>) => {
      try {
        await check();
        report[name] = { status: 'up', required };
      } catch {
        report[name] = { status: 'down', required };
      }
    };
    await Promise.all([
      ...(this.pool ? [probe('postgres', true, () => this.pool!.query('SELECT 1'))] : []),
      ...(this.config.rabbit ? [probe('rabbitmq', true, () => this.rabbitCheck())] : []),
      ...(this.redis ? [probe('redis', false, () => this.redisCheck())] : []),
      ...Object.entries(this.config.upstreams).map(([name, url]) =>
        probe(name, true, async () => {
          const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
          await response.arrayBuffer();
          if (!response.ok) throw new Error('Upstream not ready');
        }),
      ),
    ]);
    return report;
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    await this.rabbitConnecting?.catch(() => undefined);
    await this.redisConnecting?.catch(() => undefined);
    await Promise.allSettled([
      this.pool?.end(),
      this.rabbit?.close(),
      this.redis?.isOpen ? this.redis.close() : Promise.resolve(),
    ]);
  }
}
