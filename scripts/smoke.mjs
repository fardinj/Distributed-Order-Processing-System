import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { connect } from 'amqplib';
import { createClient } from 'redis';

const secret = async (name) => (await readFile(`/run/secrets/${name}_password`, 'utf8')).trim();
const passed = (name) => console.log(`PASS ${name}`);
const expectRedisUnavailable = process.argv.includes('--redis-unavailable');

for (const name of ['gateway', 'commerce', 'billing', 'bank-simulator']) {
  const response = await fetch(`http://${name}:3000/health/ready`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${name} readiness`);
  const body = await response.json();
  assert.equal(body.service, name);
  if (expectRedisUnavailable && ['gateway', 'commerce'].includes(name)) {
    assert.equal(body.status, 'degraded');
    assert.equal(body.dependencies.redis.status, 'down');
  }
  passed(`${name} readiness`);
}

const gateway = await fetch('http://gateway:3000/', { headers: { 'x-request-id': 'smoke-check' } });
assert.equal(gateway.headers.get('x-request-id'), 'smoke-check');
passed('gateway correlation header');
const identityHealth = await fetch('http://identity:9000/health/ready', {
  signal: AbortSignal.timeout(5000),
});
assert.equal(identityHealth.status, 200);
assert.ok((await identityHealth.json()).checks.some((check) => /database/i.test(check.name)));
passed('Identity readiness includes its database connection check');
const oidc = await fetch(
  'http://gateway:3000/identity/realms/tops/.well-known/openid-configuration',
);
assert.equal(oidc.status, 200);
assert.equal(
  (await oidc.json()).issuer,
  `${process.env.PUBLIC_URL ?? 'http://localhost:8080'}/identity/realms/tops`,
);
for (const path of [
  '/identity/admin/',
  '/identity/realms/master/',
  '/identity/health/ready',
  '/orders',
]) {
  assert.equal((await fetch(`http://gateway:3000${path}`)).status, 404, path);
}
passed('OIDC discovery proxy; admin/master/internal and unfinished domain routes remain closed');

for (const database of ['commerce', 'billing', 'bank']) {
  const config = {
    host: 'postgres',
    database,
    user: `${database}_runtime`,
    password: await secret(`${database}_db`),
    connectionTimeoutMillis: 2000,
  };
  const client = new Client(config);
  await client.connect();
  try {
    const result = await client.query(
      'SELECT current_database() AS name, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    assert.equal(result.rows[0].name, database);
    assert.equal(result.rows[0].rolsuper, false);
    await assert.rejects(
      client.query(`CREATE TABLE smoke_${randomUUID().replaceAll('-', '')} (id int)`),
      (error) => error.code === '42501',
      `${database} runtime cannot perform migrations`,
    );
  } finally {
    await client.end();
  }
  const foreign = new Client({
    ...config,
    database: database === 'commerce' ? 'billing' : 'commerce',
  });
  try {
    await assert.rejects(foreign.connect(), (error) => error.code === '42501');
  } finally {
    await foreign.end().catch(() => undefined);
  }
  passed(`${database}: own DB access, no superuser, no DDL, no foreign DB access`);
}

const commerce = await connect(
  `amqp://commerce:${await secret('commerce_rabbitmq')}@rabbitmq:5672/tops`,
);
const billing = await connect(
  `amqp://billing:${await secret('billing_rabbitmq')}@rabbitmq:5672/tops`,
);
commerce.on('error', () => undefined);
billing.on('error', () => undefined);
try {
  const producer = await commerce.createConfirmChannel();
  const consumer = await billing.createChannel();
  const queue = `billing.q.smoke.${randomUUID()}`;
  const routingKey = `skeleton.smoke.${randomUUID()}`;
  await consumer.assertQueue(queue, { exclusive: true, durable: false });
  await consumer.bindQueue(queue, 'commerce.events', routingKey);
  producer.publish('commerce.events', routingKey, Buffer.from('transport-smoke'), {
    persistent: true,
  });
  await producer.waitForConfirms();
  const delivery = await consumer.get(queue);
  assert.ok(delivery, 'cross-service routed message received');
  assert.equal(delivery.content.toString(), 'transport-smoke');
  consumer.ack(delivery);
  const forbidden = await commerce.createChannel();
  forbidden.on('error', () => undefined);
  await assert.rejects(
    forbidden.assertExchange('billing.events', 'topic', { durable: true }),
    (error) => error.code === 403,
  );
  passed('RabbitMQ confirm + routed receive/ack; foreign exchange configuration denied');
} finally {
  await Promise.allSettled([commerce.close(), billing.close()]);
}

const redis = createClient({
  url: 'redis://redis:6379',
  password: await secret('redis'),
  socket: { connectTimeout: 2000, reconnectStrategy: false },
});
redis.on('error', () => undefined);
try {
  if (expectRedisUnavailable) {
    await assert.rejects(redis.connect());
    passed('Redis outage: gateway/commerce remain ready with explicit degraded state');
  } else {
    await redis.connect();
    assert.equal(await redis.ping(), 'PONG');
    passed('authenticated Redis');
  }
} finally {
  if (redis.isOpen) await redis.close();
}

console.log(
  'Skeleton smoke checks complete. This does not test business outbox/payment workflows.',
);
