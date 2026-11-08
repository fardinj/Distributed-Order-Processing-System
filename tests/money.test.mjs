import test from 'node:test';
import assert from 'node:assert/strict';
import { irr, multiplyIrr, sumIrr } from '../dist/packages/runtime/src/money.js';
import { fingerprint } from '../dist/packages/runtime/src/validation.js';

test('whole IRR stays exact beyond safe Number and SQL BIGINT sizes', () => {
  const huge = '123456789012345678901234567890123456789012345678901234567890';
  assert.equal(irr(huge), huge);
  assert.equal(sumIrr([huge, '1']), (BigInt(huge) + 1n).toString());
  assert.equal(multiplyIrr(huge, 100), (BigInt(huge) * 100n).toString());
  assert.equal(irr('9'.repeat(1000)).length, 1000);
});
test('money rejects floats, exponent input, signs, leading zeros and nonfinite values', () => {
  for (const value of [
    1,
    1.1,
    -1,
    NaN,
    Infinity,
    '1.5',
    '-1',
    '01',
    '1e10',
    'NaN',
    'Infinity',
    '',
    null,
  ])
    assert.throws(() => irr(value));
  assert.throws(() => multiplyIrr('1', 1.5));
});
test('request fingerprints ignore object key order but preserve arrays and changed values', () => {
  assert.equal(fingerprint({ a: 1, b: { y: 2, x: 3 } }), fingerprint({ b: { x: 3, y: 2 }, a: 1 }));
  assert.notEqual(fingerprint({ quantity: 1 }), fingerprint({ quantity: 2 }));
});
