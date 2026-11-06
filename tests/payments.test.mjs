import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentLookupDelay } from '../dist/apps/billing/src/payments.js';

test('financial lookup delay increases beyond three retries and remains bounded with positive jitter', () => {
  for (const count of [1, 2, 3, 4, 5, 6, 20, 1000]) {
    const delay = paymentLookupDelay(count);
    const expected = Math.min(60000, 2000 * 2 ** Math.min(count - 1, 5));
    assert.ok(delay >= expected && delay <= expected + 500);
  }
  assert.ok(paymentLookupDelay(5) > paymentLookupDelay(4));
});
