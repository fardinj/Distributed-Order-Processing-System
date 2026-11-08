import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyText, integer, count, ascii } from '../apps/gateway/web/format.js';
test('Persian money formatting preserves all digits of unconstrained IRR without Number conversion', () => {
  const exact = '9'.repeat(60000),
    displayed = moneyText(exact);
  assert.equal(displayed.replaceAll('٬', ''), '۹'.repeat(60000));
  assert.equal(integer('۱۲۳٬۴۵۶'), '123456');
  assert.equal(integer('١٢٣٤'), '1234');
  assert.equal(moneyText('0'), '۰');
});
test('Persian inputs reject fractional or unsafe counts while accepting arbitrarily large money', () => {
  for (const bad of ['۱.۵', '-۱', '1e20', '۰۰۱', 'Infinity']) assert.throws(() => integer(bad));
  assert.equal(integer('8'.repeat(1000)).length, 1000);
  assert.throws(() => count('۹۰۰۷۱۹۹۲۵۴۷۴۰۹۹۲'));
  assert.equal(count('−2'.replace('−', '-'), { min: -10 }), -2);
  assert.equal(ascii('۱٬۰۰۰'), '1000');
});
