import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderListSchema,
  eventPageSchema,
} from '../dist/apps/commerce/src/modules/orders/contracts.js';
import { MetricCache, prometheus } from '../dist/packages/runtime/src/metrics.js';
test('order filters reject invalid time ranges, unknown states and unbounded history pages', () => {
  assert.equal(
    orderListSchema.safeParse({
      status: 'COMPLETED',
      createdFrom: '2026-11-01T00:00:00Z',
      createdTo: '2026-12-01T00:00:00Z',
    }).success,
    true,
  );
  for (const query of [
    { status: 'PAID' },
    { createdFrom: 'yesterday' },
    { createdFrom: '2026-12-01T00:00:00Z', createdTo: '2026-11-01T00:00:00Z' },
    { customerId: 'forged' },
  ])
    assert.equal(orderListSchema.safeParse(query).success, false);
  assert.equal(eventPageSchema.safeParse({ limit: 101 }).success, false);
});
test('metrics coalesce concurrent readers, cache success and recover after collector failure', async () => {
  let calls = 0,
    release;
  const cache = new MetricCache(() => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const a = cache.read(),
    b = cache.read();
  assert.equal(calls, 1);
  release({ tops_test: 2 });
  assert.deepEqual(await a, await b);
  await cache.read();
  assert.equal(calls, 1);
  let failing = true;
  const retry = new MetricCache(async () => {
    if (failing) throw new Error('private SQL failure');
    return { tops_test: 3 };
  });
  await assert.rejects(retry.read(), /Metrics temporarily unavailable/);
  failing = false;
  assert.equal((await retry.read()).tops_test, 3);
  assert.match(prometheus('commerce', { tops_test: 2 }), /tops_test\{service="commerce"\} 2/);
  assert.throws(() => prometheus('commerce', { tops_test: NaN }));
});
