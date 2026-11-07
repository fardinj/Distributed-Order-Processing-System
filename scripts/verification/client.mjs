import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from 'pg';
export const secret = async (name) =>
  (await readFile(`/run/secrets/${name}_password`, 'utf8')).trim();
export const pass = (message) => console.log(`PASS ${message}`);
export const clients = new Map();
export async function db(owner, sql, values = []) {
  if (!clients.has(owner)) {
    const client = new Client({
      host: 'postgres',
      database: owner,
      user: `${owner}_migrator`,
      password: await secret(`${owner}_migration`),
      connectionTimeoutMillis: 2000,
      statement_timeout: 5000,
    });
    await client.connect();
    clients.set(owner, client);
  }
  return (await clients.get(owner).query(sql, values)).rows;
}
export async function close() {
  await Promise.all([...clients.values()].map((c) => c.end()));
}
export async function token(clientId, nameOrSecret, raw = false) {
  const response = await fetch(
    'http://identity:8080/identity/realms/tops/protocol/openid-connect/token',
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: raw ? nameOrSecret : await secret(nameOrSecret),
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(response.status, 200, `token status for ${clientId}`);
  return (await response.json()).access_token;
}
export async function api(path, bearer, method = 'GET', body, key, origin = 'http://gateway:3000') {
  const started = performance.now();
  try {
    const response = await fetch(`${origin}${path.startsWith('/auth/') ? path : `/api${path}`}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    return {
      status: response.status,
      body: await response.json(),
      ms: performance.now() - started,
      retryAfter: response.headers.get('retry-after'),
      mode: response.headers.get('x-rate-limit-mode'),
    };
  } catch {
    return { status: 0, body: null, ms: performance.now() - started };
  }
}
export async function until(work, message, timeout = 90000) {
  const end = Date.now() + timeout;
  do {
    const value = await work();
    if (value) return value;
    await pause(250);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${message}`);
}
export async function product(admin, type = 'DIGITAL', price = '100') {
  const result = await api(
    '/admin/products',
    admin,
    'POST',
    {
      name: `Verification ${randomUUID()}`,
      type,
      priceMinor: price,
      ...(type === 'SUBSCRIPTION' ? { subscriptionDays: 30 } : {}),
      reason: 'Isolated verification fixture; preserve accepted history',
    },
    randomUUID(),
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
export async function deactivate(admin, p) {
  const current = await api(`/admin/products/${p.id}`, admin);
  if (current.status === 200 && current.body.active) {
    const result = await api(
      `/admin/products/${p.id}/deactivate`,
      admin,
      'POST',
      {
        expectedVersion: current.body.version,
        reason: 'Verification complete; keep immutable history',
      },
      randomUUID(),
    );
    assert.equal(result.status, 201);
  }
}
export const save = (name, value) =>
  writeFile(`/verification/${name}.json`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
export const load = async (name) =>
  JSON.parse(await readFile(`/verification/${name}.json`, 'utf8'));
