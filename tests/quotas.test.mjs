import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalQuota } from '../dist/packages/runtime/src/auxiliary.js';
test('degraded quota retains active identities, bounds key floods and expires counters', () => {
  const quota = new LocalQuota();
  assert.equal(quota.take('caller', 2, 100), true);
  assert.equal(quota.take('caller', 2, 100), true);
  assert.equal(quota.take('caller', 2, 100), false);
  for (let i = 0; i < 4100; i++) quota.take(`flood:${i}`, 2, 100);
  assert.equal(quota.take('caller', 2, 100), false);
  assert.equal(quota.take('fresh-flood', 2, 100), false);
  assert.equal(quota.take('caller', 2, 60100), true);
});
