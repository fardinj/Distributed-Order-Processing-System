import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { token, api, db, close, product, deactivate, until, save, pass } from './client.mjs';
const products = [];
try {
  const [customer, other, admin] = await Promise.all([
    token('fixture-customer-a', 'fixture_customer_a'),
    token('fixture-customer-b', 'fixture_customer_b'),
    token('fixture-admin', 'fixture_admin'),
  ]);
  for (const type of ['DIGITAL', 'SUBSCRIPTION', 'PHYSICAL'])
    products.push(await product(admin, type));
  assert.equal(
    (
      await api(
        `/admin/inventory/${products[2].id}/adjustments`,
        admin,
        'POST',
        { expectedVersion: 1, delta: 2, reason: 'History and filter fixture stock' },
        randomUUID(),
      )
    ).status,
    201,
  );
  const start = new Date().toISOString();
  const created = await api(
    '/orders',
    customer,
    'POST',
    { items: products.map((p) => ({ productId: p.id, quantity: 1 })) },
    randomUUID(),
  );
  assert.equal(created.status, 201);
  const o = created.body;
  assert.equal(
    (await api(`/orders/${o.id}/payment`, customer, 'POST', { expectedRevision: 1 })).status,
    201,
  );
  await until(
    async () => (await api(`/orders/${o.id}`, customer)).body?.status === 'COMPLETED',
    'three typed effects with new history',
  );
  const c = await api(
    '/orders',
    customer,
    'POST',
    { items: [{ productId: products[0].id, quantity: 1 }] },
    randomUUID(),
  );
  assert.equal(c.status, 201);
  assert.equal(
    (
      await api(
        `/orders/${c.body.id}/cancel`,
        customer,
        'POST',
        {
          expectedVersion: c.body.workflowVersion,
          reason: 'Filtering needs a different final status',
        },
        randomUUID(),
      )
    ).status,
    201,
  );
  const end = new Date().toISOString(),
    filter = `status=COMPLETED&createdFrom=${encodeURIComponent(start)}&createdTo=${encodeURIComponent(end)}`;
  let cursor = null;
  const ids = [];
  do {
    const r = await api(`/orders?${filter}&limit=1${cursor ? `&cursor=${cursor}` : ''}`, customer);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.every((x) => x.status === 'COMPLETED'));
    ids.push(...r.body.items.map((x) => x.id));
    cursor = r.body.nextCursor;
  } while (cursor);
  assert.ok(ids.includes(o.id));
  assert.ok(!ids.includes(c.body.id));
  const adminList = await api(`/admin/orders?${filter}&query=${o.id}`, admin);
  assert.equal(adminList.status, 200);
  assert.deepEqual(
    adminList.body.items.map((x) => x.id),
    [o.id],
  );
  assert.equal(
    (await api(`/orders?${filter}`, other)).body.items.some((x) => x.id === o.id),
    false,
  );
  assert.equal((await api('/orders?status=INVALID', customer)).status, 400);
  assert.equal((await api(`/orders?createdFrom=${end}&createdTo=${start}`, customer)).status, 400);
  assert.equal(
    (await api(`/orders?createdTo=${encodeURIComponent(o.createdAt)}`, customer)).body.items.some(
      (x) => x.id === o.id,
    ),
    false,
  );
  assert.equal((await api(`/orders/${o.id}/events`, other)).status, 404);
  // Insert only identified audit fixtures to force paging beyond the bounded detail window.
  await db(
    'commerce',
    "INSERT INTO order_events(id,order_id,type,metadata) SELECT gen_random_uuid(),$1,'VerificationHistoryPage',jsonb_build_object('fixture',true,'n',n) FROM generate_series(1,111) n ORDER BY n",
    [o.id],
  );
  const expected = await db(
    'commerce',
    'SELECT id,type,metadata,sequence::text AS sequence FROM order_events WHERE order_id=$1 ORDER BY sequence',
    [o.id],
  );
  const entries = [];
  cursor = null;
  do {
    const r = await api(
      `/orders/${o.id}/events?limit=17${cursor ? `&cursor=${cursor}` : ''}`,
      customer,
    );
    assert.equal(r.status, 200);
    entries.push(...r.body.items);
    cursor = r.body.nextCursor;
  } while (cursor);
  assert.deepEqual(
    entries.map((x) => x.id),
    expected.map((x) => x.id),
  );
  assert.equal(new Set(entries.map((x) => x.id)).size, entries.length);
  const started = entries.filter((x) => x.type === 'ItemProcessingStarted');
  assert.equal(started.length, 3);
  assert.equal(entries.filter((x) => x.type === 'ShipmentCreated').length, 1);
  for (const item of o.items) {
    const events = entries.filter((x) => x.metadata.itemId === item.id);
    assert.ok(
      events.findIndex((x) => x.type === 'ItemProcessingStarted') <
        events.findIndex((x) => x.type === 'ItemFulfilled'),
    );
  }
  assert.equal(
    (await api(`/orders/${c.body.id}/events?cursor=${entries[0].id}`, customer)).status,
    400,
  );
  assert.equal((await api(`/orders/${o.id}/events?limit=101`, customer)).status, 400);
  assert.equal((await api(`/orders/${o.id}/events`, admin)).status, 200);
  async function metrics(origin, path, bearer) {
    return fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10000),
    });
  }
  const response = await metrics('http://gateway:3000', '/api/admin/metrics', admin);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /tops_admission_used\{service="commerce"\} \d+/);
  assert.match(body, /tops_outbox_oldest_due_seconds/);
  assert.ok(!body.includes(o.id));
  assert.equal((await metrics('http://gateway:3000', '/api/admin/metrics', customer)).status, 403);
  assert.equal((await metrics('http://gateway:3000', '/api/admin/metrics', '')).status, 401);
  const billing = await token('billing-service', 'billing_service');
  const privateMetrics = await metrics('http://billing:3000', '/internal/metrics', billing);
  assert.equal(privateMetrics.status, 200);
  assert.match(await privateMetrics.text(), /tops_refunds_unconfirmed/);
  assert.equal((await metrics('http://billing:3000', '/internal/metrics', customer)).status, 403);
  assert.equal((await metrics('http://gateway:3000', '/internal/metrics', billing)).status, 404);
  await save('submission-gaps', {
    checkedAt: new Date().toISOString(),
    orderId: o.id,
    historyEvents: entries.length,
    startedEvents: started.length,
    shipmentEvents: 1,
    filters: true,
    metrics: true,
    passed: true,
  });
  pass(
    'filtered owner/admin pagination, complete ordered history beyond 100, typed start/shipment events and authenticated owner metrics',
  );
} finally {
  for (const p of products) await deactivate(await token('fixture-admin', 'fixture_admin'), p);
  await close();
}
