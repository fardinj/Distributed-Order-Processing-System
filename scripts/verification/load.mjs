import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  secret,
  token,
  api,
  db,
  close,
  product,
  deactivate,
  save,
  until,
  pass,
} from './client.mjs';
const run = randomUUID().slice(0, 8),
  startedAt = new Date().toISOString();
const admin = await token('fixture-admin', 'fixture_admin');
const bootstrap = await fetch(
  'http://identity:8080/identity/realms/master/protocol/openid-connect/token',
  {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'tops_bootstrap_admin',
      password: await secret('identity_admin'),
    }),
  },
);
assert.equal(bootstrap.status, 200);
let root = (await bootstrap.json()).access_token;
async function identity(path, method = 'GET', body, renewed = false) {
  const response = await fetch(`http://identity:8080/identity/admin/realms/tops${path}`, {
    method,
    headers: { authorization: `Bearer ${root}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 && !renewed) {
    const renewedToken = await fetch(
      'http://identity:8080/identity/realms/master/protocol/openid-connect/token',
      {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'tops_bootstrap_admin',
          password: await secret('identity_admin'),
        }),
      },
    );
    assert.equal(renewedToken.status, 200);
    root = (await renewedToken.json()).access_token;
    return identity(path, method, body, true);
  }
  assert.ok(response.ok, `identity fixture ${method}: ${response.status}`);
  return response.status === 204 || response.status === 201 ? null : response.json();
}
const scopes = await identity('/client-scopes'),
  role = await identity('/roles/customer'),
  actors = [];
const fixture = await product(admin);
const requests = [],
  accepted = new Map(),
  work = new Set(),
  paymentQueue = [],
  samples = [],
  stages = [];
let paymentBusy = 0,
  sampling = true;
const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) =>
    sorted.length
      ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)])
      : null;
  return {
    n: sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted.length ? Math.round(sorted.at(-1)) : null,
  };
};
function schedule(id, actor) {
  if (accepted.has(id)) return;
  accepted.set(id, actor);
  paymentQueue.push({ id, actor });
}
async function payments() {
  while (paymentQueue.length && paymentBusy < 4) {
    const item = paymentQueue.shift();
    paymentBusy++;
    const task = (async () => {
      for (let n = 0; n < 30; n++) {
        const result = await api(`/orders/${item.id}/payment`, item.actor.token, 'POST', {
          expectedRevision: 1,
        });
        if (result.status === 201) return;
        assert.ok([0, 429, 502, 503].includes(result.status), `payment entry ${result.status}`);
        await pause(Math.max(1000, Number(result.retryAfter ?? 1) * 1000));
      }
      throw new Error('Payment entry retained but not recovered within bounded test wait');
    })().finally(() => {
      paymentBusy--;
      work.delete(task);
    });
    work.add(task);
    task.catch(() => {});
  }
}
const paymentTimer = setInterval(() => payments().catch(() => {}), 100).unref();
async function observe() {
  const [c, b, k] = await Promise.all([
    db(
      'commerce',
      `SELECT (SELECT used FROM admission_budget WHERE id=1) AS admitted,(SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS outbox,(SELECT count(*)::int FROM inbox_messages WHERE status='PENDING') AS inbox,(SELECT greatest(0,coalesce(extract(epoch from(clock_timestamp()-min(available_at))),0))::float8 FROM outbox WHERE published_at IS NULL) AS oldest_due_outbox_seconds,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections`,
    ),
    db(
      'billing',
      `SELECT (SELECT count(*)::int FROM payments WHERE status NOT IN('SUCCEEDED','FAILED')) AS unresolved,(SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS outbox,(SELECT count(*)::int FROM inbox_messages WHERE status='PENDING') AS inbox,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections`,
    ),
    db(
      'bank',
      `SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname=current_database()`,
    ),
  ]);
  samples.push({ at: new Date().toISOString(), commerce: c[0], billing: b[0], bank: k[0] });
}
await observe();
let samplerError;
const observer = (async () => {
  while (sampling) {
    await observe();
    await pause(2000);
  }
})().catch((error) => {
  samplerError = error;
  sampling = false;
});
try {
  for (let n = 0; n < 8; n++) {
    const clientId = `fixture-load-${run}-${n}`,
      password = randomBytes(32).toString('hex');
    await identity('/clients', 'POST', {
      clientId,
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      fullScopeAllowed: true,
      secret: password,
      protocolMappers: [
        {
          name: 'tops-api-audience',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-audience-mapper',
          config: { 'included.client.audience': 'tops-api', 'access.token.claim': 'true' },
        },
      ],
    });
    const client = (await identity(`/clients?clientId=${clientId}`))[0];
    for (const name of ['basic', 'roles'])
      await identity(
        `/clients/${client.id}/default-client-scopes/${scopes.find((s) => s.name === name).id}`,
        'PUT',
      );
    const account = await identity(`/clients/${client.id}/service-account-user`);
    await identity(`/users/${account.id}/role-mappings/realm`, 'POST', [role]);
    actors.push({
      id: account.id,
      clientUuid: client.id,
      clientId,
      password,
      token: await token(clientId, password, true),
    });
  }
  console.log(`Load fixture ${run}: eight real scoped OIDC principals; no credentials printed`);
  for (const [name, rps, seconds] of [
    ['baseline', 1, 20],
    ['ramp', 6, 30],
    ['pressure', 20, 30],
  ]) {
    const start = performance.now(),
      stageRequests = [],
      pending = new Set();
    let clientShed = 0;
    const count = rps * seconds;
    for (let index = 0; index < count; index++) {
      const due = start + (index * 1000) / rps;
      await pause(Math.max(0, due - performance.now()));
      if (pending.size >= 64) {
        clientShed++;
        continue;
      }
      const actor = actors[requests.length % actors.length],
        record = { key: randomUUID(), actor: actor.id, stage: name };
      requests.push(record);
      stageRequests.push(record);
      const task = (async () => {
        const result = await api(
          '/orders',
          actor.token,
          'POST',
          { items: [{ productId: fixture.id, quantity: 1 }] },
          record.key,
          requests.length % 2
            ? (process.env.LOAD_SECOND_ORIGIN ?? 'http://gateway:3000')
            : 'http://gateway:3000',
        );
        Object.assign(record, { status: result.status, ms: result.ms });
        if (result.status === 201) schedule(result.body.id, actor);
      })().finally(() => pending.delete(task));
      pending.add(task);
    }
    await Promise.all(pending);
    const duration = (performance.now() - start) / 1000,
      statuses = {};
    for (const record of stageRequests)
      statuses[record.status] = (statuses[record.status] ?? 0) + 1;
    const stage = {
      name,
      configuredRps: rps,
      seconds,
      offered: count,
      sent: stageRequests.length,
      clientShed,
      durationSeconds: duration,
      statuses,
      requestMs: quantiles(stageRequests.map((r) => r.ms)),
      acceptedResponseRps: (statuses[201] ?? 0) / duration,
      rejectedRps: stageRequests.filter((r) => [429, 503].includes(r.status)).length / duration,
    };
    stages.push(stage);
    console.log(JSON.stringify(stage));
  }
  // Reconcile response uncertainty against the actual atomic SQL acceptance ledger, never assume a timeout rejected work.
  const rows = await db(
    'commerce',
    "SELECT actor_id,key,response->>'orderId' AS id FROM idempotency_records WHERE operation='order:create' AND key=ANY($1::text[])",
    [requests.map((r) => r.key)],
  );
  for (const row of rows)
    schedule(
      row.id,
      actors.find((a) => a.id === row.actor_id),
    );
  const ids = [...accepted.keys()];
  assert.ok(ids.length > 0);
  console.log(
    `Reconciling ${ids.length} SQL-accepted orders; ${requests.length - ids.length} requests left no accepted order`,
  );
  let lastDrainLog = 0;
  await until(
    async () => {
      if (paymentQueue.length || paymentBusy) return false;
      const rows = await db(
        'commerce',
        "SELECT count(*)::int AS remaining FROM orders WHERE id=ANY($1::uuid[]) AND status<>'COMPLETED'",
        [ids],
      );
      if (Date.now() - lastDrainLog > 5000) {
        console.log(`Drain remaining: ${rows[0].remaining}`);
        lastDrainLog = Date.now();
      }
      return rows[0].remaining === 0;
    },
    'every accepted order completes',
    360000,
  );
  const commerce = (
    await db(
      'commerce',
      `SELECT count(DISTINCT o.id)::int AS orders,count(DISTINCT i.id)::int AS items,count(DISTINCT g.item_id)::int AS grants,count(DISTINCT a.item_id)::int AS executed_items,count(DISTINCT a.id)::int AS attempts,count(DISTINCT s.order_id) FILTER(WHERE s.released_at IS NULL)::int AS retained_slots FROM orders o JOIN order_items i ON i.order_id=o.id LEFT JOIN digital_grants g ON g.item_id=i.id LEFT JOIN fulfillment_attempts a ON a.item_id=i.id LEFT JOIN admission_slots s ON s.order_id=o.id WHERE o.id=ANY($1::uuid[])`,
      [ids],
    )
  )[0];
  const billing = (
    await db(
      'billing',
      "SELECT count(*)::int AS payments,count(*) FILTER(WHERE status='SUCCEEDED' AND amount_minor=100)::int AS correct FROM payments WHERE order_id=ANY($1::uuid[])",
      [ids],
    )
  )[0];
  const bank = (
    await db(
      'bank',
      "SELECT count(*)::int AS operations,count(*) FILTER(WHERE status='SUCCEEDED' AND amount_minor=100)::int AS correct FROM bank_operations WHERE operation_key=ANY($1::text[])",
      [ids.map((id) => `payment:${id}`)],
    )
  )[0];
  for (const value of [
    commerce.orders,
    commerce.items,
    commerce.grants,
    commerce.executed_items,
    commerce.attempts,
    billing.payments,
    billing.correct,
    bank.operations,
    bank.correct,
  ])
    assert.equal(value, ids.length);
  assert.equal(commerce.retained_slots, 0);
  const times = await db(
    'commerce',
    `SELECT extract(epoch from(min(e.created_at)-o.created_at))*1000 AS ms FROM orders o JOIN order_events e ON e.order_id=o.id AND e.type='OrderStatusChanged' AND e.metadata->>'status'='COMPLETED' WHERE o.id=ANY($1::uuid[]) GROUP BY o.id`,
    [ids],
  );
  const report = {
    run,
    startedAt,
    finishedAt: new Date().toISOString(),
    stages,
    accepted: ids.length,
    rejectedWithoutAcceptance: requests.length - ids.length,
    statusCounts: requests.reduce(
      (all, r) => ((all[r.status] = (all[r.status] ?? 0) + 1), all),
      {},
    ),
    completionMs: quantiles(times.map((t) => Number(t.ms))),
    samples,
    commerce,
    billing,
    bank,
    orderIds: ids,
  };
  await save('load-results', report);
  assert.equal(samplerError, undefined, 'Metric sampler must complete successfully');
  pass(
    'every SQL-accepted order drained with one exact charge, one grant/attempt, released slot and no discarded workflow',
  );
} finally {
  clearInterval(paymentTimer);
  sampling = false;
  await observer;
  await Promise.allSettled([...work]);
  await deactivate(await token('fixture-admin', 'fixture_admin'), fixture);
  for (const actor of actors)
    await identity(`/clients/${actor.clientUuid}`, 'PUT', {
      clientId: actor.clientId,
      enabled: false,
    });
  await close();
}
