import { readFileSync } from 'node:fs';

export type ServiceName = 'gateway' | 'commerce' | 'billing' | 'bank-simulator';
export interface ServiceConfig {
  name: ServiceName;
  port: number;
  database?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    max: number;
  };
  rabbit?: { url: string };
  redis?: { url: string; password: string };
  upstreams: Record<string, string>;
}

export function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  if (!file) throw new Error(`${name}_FILE must point to a mounted secret`);
  const value = readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`${name}_FILE is empty`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

export function serviceConfig(name: ServiceName): ServiceConfig {
  const config: ServiceConfig = { name, port: positiveInteger('PORT', 3000), upstreams: {} };
  if (name !== 'gateway') {
    config.database = {
      host: process.env.DB_HOST ?? 'postgres',
      port: positiveInteger('DB_PORT', 5432),
      database: process.env.DB_NAME ?? name.replace('-', '_'),
      user: process.env.DB_USER ?? `${name.replace('-', '_')}_runtime`,
      password: secret('DB_PASSWORD'),
      max: positiveInteger('DB_POOL_MAX', 2),
    };
  }
  if (name === 'commerce' || name === 'billing') {
    const user = process.env.RABBITMQ_USER;
    if (!user) throw new Error('RABBITMQ_USER is required');
    config.rabbit = {
      url: `amqp://${encodeURIComponent(user)}:${encodeURIComponent(secret('RABBITMQ_PASSWORD'))}@rabbitmq:5672/tops?heartbeat=10`,
    };
  }
  if (name === 'commerce' || name === 'gateway') {
    config.redis = { url: 'redis://redis:6379', password: secret('REDIS_PASSWORD') };
  }
  if (name === 'gateway') {
    config.upstreams = {
      commerce: 'http://commerce:3000/health/ready',
      billing: 'http://billing:3000/health/ready',
      bank: 'http://bank-simulator:3000/health/ready',
      identity: 'http://identity:9000/health/ready',
    };
  }
  return config;
}
