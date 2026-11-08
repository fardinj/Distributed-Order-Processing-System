import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Dependencies } from './dependencies.js';

export class LocalQuota {
  private readonly counters = new Map<string, { count: number; until: number }>();
  take(key: string, limit: number, now = Date.now()) {
    // Never evict an active quota to admit a fresh attacker-controlled identity.
    for (const [id, entry] of this.counters) if (entry.until <= now) this.counters.delete(id);
    if (!this.counters.has(key) && this.counters.size >= 4096) key = '__overflow';
    const entry = this.counters.get(key) ?? {
      count: 0,
      until: (Math.floor(now / 60000) + 1) * 60000,
    };
    this.counters.set(key, entry);
    return ++entry.count <= limit;
  }
}

@Injectable()
export class Auxiliary {
  private readonly local = new LocalQuota();
  constructor(private readonly dependencies: Dependencies) {}
  async quota(identity: string, lane: string, limit: number) {
    const digest = createHash('sha256').update(`${lane}:${identity}`).digest('hex');
    const bucket = Math.floor(Date.now() / 60000);
    const count = await this.dependencies.optionalRedis((r) =>
      r.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],61000) end; return n",
        { keys: [`tops:quota:${digest}:${bucket}`], arguments: [] },
      ),
    );
    return {
      allowed: count === undefined ? this.local.take(digest, limit) : Number(count) <= limit,
      mode: count === undefined ? 'local-degraded' : 'shared',
      retryAfter: 60 - (Math.floor(Date.now() / 1000) % 60),
    };
  }
  async cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const cacheKey = `tops:catalog:v1:${key}`;
    const value = await this.dependencies.optionalRedis((r) => r.get(cacheKey));
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as T;
      } catch {
        /* cache corruption is a miss */
      }
    }
    const result = await read();
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) <= 262144)
      await this.dependencies.optionalRedis((r) => r.set(cacheKey, encoded, { PX: 2000 }));
    return result;
  }
  async overlap(name: string, work: () => Promise<void>) {
    const key = `tops:scheduler:${name}`;
    const token = randomUUID();
    const acquired = await this.dependencies.optionalRedis((r) =>
      r.set(key, token, { NX: true, PX: 15000 }),
    );
    if (acquired === null) return;
    try {
      await work();
    } finally {
      // An expired/evicted lock can overlap; PostgreSQL locks and generations still arbitrate effects.
      if (acquired === 'OK')
        await this.dependencies.optionalRedis((r) =>
          r.eval(
            "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",
            { keys: [key], arguments: [token] },
          ),
        );
    }
  }
}
