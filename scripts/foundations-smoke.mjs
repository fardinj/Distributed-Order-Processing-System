import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

const gateway = 'http://gateway:3000';
const identity = 'http://identity:8080/identity';
const secret = async (name) => (await readFile(`/run/secrets/${name}_password`, 'utf8')).trim();
const pass = (name) => console.log(`PASS ${name}`);
async function token(clientId, name) {
  const response = await fetch(`${identity}/realms/tops/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: await secret(name),
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `token for ${clientId}`);
  return (await response.json()).access_token;
}
const [customerA, customerB, admin, service] = await Promise.all([
  token('fixture-customer-a', 'fixture_customer_a'),
  token('fixture-customer-b', 'fixture_customer_b'),
  token('fixture-admin', 'fixture_admin'),
  token('commerce-service', 'commerce_service'),
]);
async function api(path, bearer, method = 'GET', body, key) {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}
async function db(name, work, rollback = false) {
  const client = new Client({
    host: 'postgres',
    database: name,
    user: `${name}_migrator`,
    password: await secret(`${name}_migration`),
    connectionTimeoutMillis: 2000,
  });
  await client.connect();
  try {
    if (rollback) await client.query('BEGIN');
    return await work(client);
  } finally {
    if (rollback) await client.query('ROLLBACK');
    await client.end();
  }
}
async function rejectsSql(client, sql, values, code = '23514') {
  await client.query('SAVEPOINT expected_failure');
  await assert.rejects(client.query(sql, values), (error) => error.code === code);
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
}

assert.equal((await api('/api/products')).status, 401);
assert.equal((await api('/api/products', 'forged.value.token')).status, 401);
assert.equal((await api('/api/admin/products', customerA)).status, 403);
assert.equal((await api('/api/products', service)).status, 403);
const meA = await api('/auth/me', customerA);
const meB = await api('/auth/me', customerB);
assert.equal(meA.status, 200);
assert.notEqual(meA.body.id, meB.body.id);
const spoof = await fetch(`${gateway}/api/admin/products`, {
  headers: {
    authorization: `Bearer ${customerA}`,
    'x-user-role': 'admin',
    'x-user-id': meB.body.id,
  },
});
assert.equal(spoof.status, 403);
const direct = await fetch('http://commerce:3000/admin/products', {
  headers: { authorization: `Bearer ${customerA}` },
});
assert.equal(direct.status, 403);
const internal = await fetch('http://billing:3000/internal/identity', {
  headers: { authorization: `Bearer ${service}` },
});
assert.equal(internal.status, 200);
assert.equal((await internal.json()).clientId, 'commerce-service');
assert.equal((await api('/internal/identity', service)).status, 404);
assert.equal((await api('/api/internal/identity', service)).status, 404);
pass(
  'real OIDC audience/roles, customer separation, header spoof rejection and private service identity',
);

const configuration = await api('/auth/config');
assert.equal(configuration.body.pkce, 'S256');
const badPkce = new URL(`${identity}/realms/tops/protocol/openid-connect/auth`);
for (const [key, value] of Object.entries({
  client_id: 'tops-web',
  redirect_uri: `${process.env.PUBLIC_URL ?? 'http://localhost:8080'}/auth/callback`,
  response_type: 'code',
  scope: 'openid',
  state: 'smoke',
  nonce: 'smoke',
  code_challenge: 'a'.repeat(43),
  code_challenge_method: 'plain',
}))
  badPkce.searchParams.set(key, value);
const pkceResponse = await fetch(badPkce, { redirect: 'manual' });
if (pkceResponse.status === 302) {
  const failure = new URL(pkceResponse.headers.get('location'));
  assert.equal(failure.origin, process.env.PUBLIC_URL ?? 'http://localhost:8080');
  assert.equal(failure.pathname, '/auth/callback');
  assert.equal(failure.searchParams.get('error'), 'invalid_request');
  assert.match(failure.searchParams.get('error_description'), /code.challenge|PKCE|S256/i);
} else assert.equal(pkceResponse.status, 400);
pass('browser client requires S256 PKCE; no password-grant shortcut');

const huge = '123456789012345678901234567890123456789012345678901234567890';
const create = {
  name: 'آزمون مبلغ بزرگ',
  type: 'DIGITAL',
  priceMinor: huge,
  reason: 'Foundation integration check',
};
const creationKey = randomUUID();
const created = await api('/api/admin/products', admin, 'POST', create, creationKey);
assert.equal(created.status, 201, JSON.stringify(created.body));
assert.equal(created.body.priceMinor, huge);
const productId = created.body.id;
const replay = await api('/api/admin/products', admin, 'POST', create, creationKey);
assert.deepEqual(replay.body, created.body);
assert.equal(
  (await api('/api/admin/products', admin, 'POST', { ...create, priceMinor: '1' }, creationKey))
    .status,
  409,
);
assert.equal(
  (await api('/api/admin/products', admin, 'POST', { ...create, priceMinor: 123 }, randomUUID()))
    .status,
  400,
);
assert.equal(
  (await api('/api/admin/products', admin, 'POST', { ...create, priceMinor: '1e30' }, randomUUID()))
    .status,
  400,
);
assert.equal(
  (
    await api(
      '/api/admin/products',
      admin,
      'POST',
      { ...create, customerId: meB.body.id },
      randomUUID(),
    )
  ).status,
  400,
);
assert.equal((await api(`/api/products/${productId}`, customerA)).body.priceMinor, huge);
pass('exact large IRR through Prisma/SQL/API; idempotent admin mutation and strict validation');

const orderId = randomUUID();
const itemId = randomUUID();
await db('commerce', async (client) => {
  await client.query(
    'INSERT INTO orders(id,customer_id,status,total_minor) VALUES ($1,$2,$3,$4::numeric)',
    [orderId, meA.body.id, 'PROCESSING', huge],
  );
  await client.query(
    'INSERT INTO order_items(id,order_id,product_id,name,type,quantity,unit_price_minor,line_total_minor) VALUES ($1,$2,$3,$4,$5,1,$6::numeric,$6::numeric)',
    [itemId, orderId, productId, create.name, 'DIGITAL', huge],
  );
});
try {
  assert.equal((await api(`/api/orders/${orderId}`, customerA)).body.totalMinor, huge);
  assert.equal((await api(`/api/orders/${orderId}`, customerB)).status, 404);
  assert.equal((await api(`/api/orders/${orderId}`, admin)).status, 200);
  const changed = await api(
    `/api/admin/products/${productId}`,
    admin,
    'PATCH',
    { expectedVersion: 1, priceMinor: '9', name: 'نام جدید', reason: 'Catalog edit after payment' },
    randomUUID(),
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const paid = await api(`/api/orders/${orderId}`, customerA);
  assert.equal(paid.body.items[0].unitPriceMinor, huge);
  assert.equal(paid.body.items[0].name, create.name);
  await db(
    'commerce',
    async (client) => {
      await rejectsSql(client, 'UPDATE orders SET total_minor=1 WHERE id=$1', [orderId]);
      await rejectsSql(
        client,
        'UPDATE order_items SET unit_price_minor=1,line_total_minor=1 WHERE id=$1',
        [itemId],
      );
    },
    true,
  );
  pass('owner-guarded reads and immutable paid snapshots despite catalog edits');
} finally {
  await db('commerce', async (client) => {
    await client.query('DELETE FROM order_items WHERE id=$1', [itemId]);
    await client.query('DELETE FROM orders WHERE id=$1', [orderId]);
  });
}

const physical = await api(
  '/api/admin/products',
  admin,
  'POST',
  {
    name: 'موجودی آزمون',
    type: 'PHYSICAL',
    priceMinor: '5000',
    reason: 'Stock integration fixture',
  },
  randomUUID(),
);
assert.equal(physical.status, 201);
const stockId = physical.body.id;
const results = await Promise.all(
  [5, 7].map((delta) =>
    api(
      `/api/admin/inventory/${stockId}/adjustments`,
      admin,
      'POST',
      {
        expectedVersion: 1,
        delta,
        reason: 'Concurrent count-safe adjustment',
      },
      randomUUID(),
    ),
  ),
);
assert.deepEqual(results.map((entry) => entry.status).sort(), [201, 409]);
const successful = results.find((entry) => entry.status === 201).body;
assert.equal(successful.version, 2);
assert.equal(
  (
    await api(
      `/api/admin/inventory/${stockId}/adjustments`,
      admin,
      'POST',
      { expectedVersion: 2, delta: -100, reason: 'Cannot oversubtract stock' },
      randomUUID(),
    )
  ).status,
  409,
);
pass('concurrent version guards and no negative inventory');

const holdOrder = randomUUID();
const holdItem = randomUUID();
const holdId = randomUUID();
await db('commerce', async (client) => {
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO orders(id,customer_id,total_minor) VALUES ($1,$2,15000)', [
      holdOrder,
      meA.body.id,
    ]);
    await client.query(
      'INSERT INTO order_items(id,order_id,product_id,name,type,quantity,unit_price_minor,line_total_minor) VALUES ($1,$2,$3,$4,$5,3,5000,15000)',
      [holdItem, holdOrder, stockId, 'Held stock', 'PHYSICAL'],
    );
    await client.query('UPDATE inventory SET available=available-3 WHERE product_id=$1', [stockId]);
    await client.query(
      "INSERT INTO reservations(id,item_id,product_id,generation,quantity,expires_at) VALUES ($1,$2,$3,1,3,now()+interval '5 minutes')",
      [holdId, holdItem, stockId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
});
try {
  const correction = await api(
    `/api/admin/inventory/${stockId}/reconcile`,
    admin,
    'POST',
    { expectedVersion: 2, countedOnHand: 1, reason: 'Confirmed warehouse count discrepancy' },
    randomUUID(),
  );
  assert.equal(correction.status, 201, JSON.stringify(correction.body));
  assert.equal(correction.body.available, '0');
  assert.equal(correction.body.requiresReview, true);
  assert.ok(correction.body.discrepancyId);
  const discrepancy = await api(`/api/admin/inventory/${stockId}/discrepancies`, admin);
  assert.equal(discrepancy.body[0].shortage, '2');
  assert.equal(discrepancy.body[0].affectedReservations[0].id, holdId);
  const audit = await api(`/api/admin/products/${stockId}/audit`, admin);
  assert.ok(audit.body.some((entry) => entry.action === 'InventoryReconciled'));
  const reviews = await api('/api/admin/manual-review', admin);
  assert.ok(
    reviews.body.some((entry) => entry.metadata.discrepancyId === correction.body.discrepancyId),
  );
  await db('commerce', async (client) => {
    const row = await client.query('SELECT status FROM reservations WHERE id=$1', [holdId]);
    assert.equal(row.rows[0].status, 'ACTIVE');
  });
  pass('stock discrepancy quarantines new sales, preserves held customers, records audit/review');
} finally {
  await db('commerce', async (client) => {
    await client.query('DELETE FROM reservations WHERE id=$1', [holdId]);
    await client.query('DELETE FROM order_items WHERE id=$1', [holdItem]);
    await client.query('DELETE FROM orders WHERE id=$1', [holdOrder]);
  });
}

for (const name of ['commerce', 'billing', 'bank'])
  await db(name, async (client) => {
    const numeric = await client.query(
      `SELECT table_name,column_name,numeric_precision FROM information_schema.columns WHERE table_schema='public' AND data_type='numeric'`,
    );
    assert.ok(numeric.rows.length > 0);
    assert.ok(numeric.rows.every((row) => row.numeric_precision === null));
    const runtime = new Client({
      host: 'postgres',
      database: name,
      user: `${name}_runtime`,
      password: await secret(`${name}_db`),
    });
    await runtime.connect();
    try {
      await assert.rejects(
        runtime.query('SELECT * FROM _prisma_migrations'),
        (error) => error.code === '42501',
      );
      const retained = { commerce: 'orders', billing: 'payments', bank: 'bank_operations' }[name];
      await assert.rejects(
        runtime.query(`DELETE FROM ${retained} WHERE false`),
        (error) => error.code === '42501',
      );
    } finally {
      await runtime.end();
    }
  });
pass('unconstrained money columns and protected migration history in every owner DB');

await db(
  'commerce',
  async (client) => {
    await rejectsSql(client, 'INSERT INTO products(id,name,type,price_minor) VALUES ($1,$2,$3,1)', [
      randomUUID(),
      'Missing duration',
      'SUBSCRIPTION',
    ]);
    await rejectsSql(client, 'INSERT INTO inventory(product_id) VALUES ($1)', [productId]);
    const order = randomUUID();
    const item = randomUUID();
    await client.query('INSERT INTO orders(id,customer_id,total_minor) VALUES ($1,$2,9)', [
      order,
      meA.body.id,
    ]);
    await rejectsSql(
      client,
      'INSERT INTO order_items(id,order_id,product_id,name,type,quantity,unit_price_minor,line_total_minor) VALUES ($1,$2,$3,$4,$5,2,9,18)',
      [randomUUID(), order, productId, 'Invalid digital quantity', 'DIGITAL'],
    );
    await client.query(
      'INSERT INTO order_items(id,order_id,product_id,name,type,quantity,unit_price_minor,line_total_minor) VALUES ($1,$2,$3,$4,$5,1,9,9)',
      [item, order, productId, 'Valid digital', 'DIGITAL'],
    );
    await rejectsSql(
      client,
      "INSERT INTO reservations(id,item_id,product_id,generation,quantity,expires_at) VALUES ($1,$2,$3,1,1,now()+interval '5 minutes')",
      [randomUUID(), item, productId],
    );
  },
  true,
);
pass(
  'SQL rejects NULL subscription duration, nonphysical inventory/reservations and invalid quantity',
);

await db(
  'billing',
  async (client) => {
    const payment = randomUUID();
    await client.query(
      'INSERT INTO payments(id,order_id,operation_key,customer_id,amount_minor,status) VALUES ($1,$2,$3,$4,$5::numeric,$6)',
      [payment, randomUUID(), randomUUID(), meA.body.id, huge, 'SUCCEEDED'],
    );
    const part = (BigInt(huge) / 3n).toString();
    await client.query(
      'INSERT INTO refunds(id,payment_id,disposition_id,operation_key,amount_minor,reason) VALUES ($1,$2,$3,$4,$5::numeric,$6)',
      [randomUUID(), payment, randomUUID(), randomUUID(), part, 'Round-trip refund fixture'],
    );
    const row = await client.query(
      'SELECT amount_minor::text AS amount FROM refunds WHERE payment_id=$1',
      [payment],
    );
    assert.equal(row.rows[0].amount, part);
    await rejectsSql(
      client,
      'INSERT INTO refunds(id,payment_id,disposition_id,operation_key,amount_minor,reason) VALUES ($1,$2,$3,$4,$5::numeric,$6)',
      [randomUUID(), payment, randomUUID(), randomUUID(), huge, 'Over-refund must fail'],
    );
    for (const invalid of ['NaN', 'Infinity', '-1', '1.5'])
      await rejectsSql(
        client,
        'INSERT INTO payments(id,order_id,operation_key,customer_id,amount_minor) VALUES ($1,$2,$3,$4,$5::numeric)',
        [randomUUID(), randomUUID(), randomUUID(), meA.body.id, invalid],
      );
  },
  true,
);
await db(
  'bank',
  async (client) => {
    const operation = randomUUID();
    await client.query(
      "INSERT INTO bank_operations(operation_key,amount_minor,status,deadline_at) VALUES ($1,$2::numeric,$3,now()+interval '15 minutes')",
      [operation, huge, 'SUCCEEDED'],
    );
    assert.equal(
      (
        await client.query(
          'SELECT amount_minor::text AS amount FROM bank_operations WHERE operation_key=$1',
          [operation],
        )
      ).rows[0].amount,
      huge,
    );
    await rejectsSql(client, 'UPDATE bank_operations SET status=$1 WHERE operation_key=$2', [
      'FAILED',
      operation,
    ]);
    const refundKey = randomUUID();
    const amount = (BigInt(huge) / 3n).toString();
    await client.query(
      'INSERT INTO bank_refunds(operation_key,charge_key,amount_minor) VALUES ($1,$2,$3::numeric)',
      [refundKey, operation, amount],
    );
    assert.equal(
      (
        await client.query(
          'SELECT amount_minor::text AS amount FROM bank_refunds WHERE operation_key=$1',
          [refundKey],
        )
      ).rows[0].amount,
      amount,
    );
    await rejectsSql(client, 'UPDATE bank_refunds SET amount_minor=1 WHERE operation_key=$1', [
      refundKey,
    ]);
  },
  true,
);
pass('Billing/Bank exact money, refund budget/finite-integer checks and immutable bank result');

const concurrentPayment = randomUUID();
await db('billing', (client) =>
  client.query(
    'INSERT INTO payments(id,order_id,operation_key,customer_id,amount_minor,status) VALUES ($1,$2,$3,$4,100,$5)',
    [concurrentPayment, randomUUID(), randomUUID(), meA.body.id, 'SUCCEEDED'],
  ),
);
try {
  const attempts = await Promise.allSettled(
    [1, 2].map(() =>
      db('billing', (client) =>
        client.query(
          'INSERT INTO refunds(id,payment_id,disposition_id,operation_key,amount_minor,reason) VALUES ($1,$2,$3,$4,60,$5)',
          [
            randomUUID(),
            concurrentPayment,
            randomUUID(),
            randomUUID(),
            'Concurrent refund budget fixture',
          ],
        ),
      ),
    ),
  );
  assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((entry) => entry.status === 'rejected').reason.code, '23514');
  pass('concurrent refund requests serialize on captured budget');
} finally {
  await db('billing', async (client) => {
    await client.query('DELETE FROM refunds WHERE payment_id=$1', [concurrentPayment]);
    await client.query('DELETE FROM payments WHERE id=$1', [concurrentPayment]);
  });
}

// These two products are still active, so paging does not rely on unchanged seed data.
const first = await api('/api/products?limit=1', customerA);
assert.ok(first.body.nextCursor);
const second = await api(
  `/api/products?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
  customerA,
);
assert.equal(second.status, 200);
assert.notEqual(second.body.items[0].id, first.body.items[0].id);
await api(
  `/api/admin/products/${productId}/deactivate`,
  admin,
  'POST',
  { expectedVersion: 2, reason: 'Finished integration example' },
  randomUUID(),
);
assert.equal((await api(`/api/products/${productId}`, customerA)).status, 404);
assert.equal((await api(`/api/admin/products/${productId}`, admin)).status, 200);
assert.equal(
  (
    await api(
      `/api/admin/products/${stockId}/deactivate`,
      admin,
      'POST',
      {
        expectedVersion: 1,
        reason: 'Finished stock integration example',
      },
      randomUUID(),
    )
  ).status,
  201,
);
assert.equal((await api('/api/products?limit=101', customerA)).status, 400);
assert.equal((await api('/api/products?cursor=not-a-cursor', customerA)).status, 400);
pass('deactivation preserves admin evidence; pagination is bounded/validated');
console.log(
  'Step-2 foundation checks complete. No checkout/payment processing worker is claimed here.',
);
