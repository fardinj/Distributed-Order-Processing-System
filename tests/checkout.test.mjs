import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalLines,
  createOrderSchema,
} from '../dist/apps/commerce/src/modules/orders/contracts.js';
import { envelopeSchema, retryDelay } from '../dist/packages/runtime/src/outbox.js';

test('checkout normalization merges physical-compatible quantities in stable product order and bounds aggregate work', () => {
  const first = '00000000-0000-4000-8000-000000000001',
    second = '00000000-0000-4000-8000-000000000002';
  assert.deepEqual(
    canonicalLines([
      { productId: second, quantity: 1 },
      { productId: first, quantity: 2 },
      { productId: second, quantity: 3 },
    ]),
    [
      { productId: first, quantity: 2 },
      { productId: second, quantity: 4 },
    ],
  );
  assert.throws(() =>
    canonicalLines([
      { productId: first, quantity: 60 },
      { productId: first, quantity: 60 },
    ]),
  );
  assert.equal(
    createOrderSchema.safeParse({ items: [{ productId: first, quantity: 1 }], priceMinor: '1' })
      .success,
    false,
  );
});
test('transport rejects unsupported envelope versions and uses bounded increasing retry delay with jitter', () => {
  assert.equal(envelopeSchema.safeParse({ schemaVersion: 2 }).success, false);
  for (const attempt of [0, 1, 2, 10, 1000]) {
    const delay = retryDelay(attempt);
    const base = Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));
    assert.ok(delay >= base && delay <= base + 500);
  }
});
