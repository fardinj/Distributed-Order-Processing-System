import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readiness } from '../dist/packages/runtime/src/dependencies.js';
import { correlationId } from '../dist/packages/runtime/src/bootstrap.js';
import { identityPathAllowed } from '../dist/apps/gateway/src/identity-policy.js';

test('Redis outage is degraded, not a hard readiness failure', () => {
  assert.deepEqual(
    readiness({
      postgres: { status: 'up', required: true },
      redis: { status: 'down', required: false },
    }),
    { ready: true, degraded: true },
  );
});
test('a required database/broker outage cannot report ready', () => {
  assert.equal(readiness({ rabbitmq: { status: 'down', required: true } }).ready, false);
});
test('correlation IDs reject control characters and unbounded client values', () => {
  assert.equal(correlationId('customer-request-1'), 'customer-request-1');
  assert.match(correlationId('x\r\nspoofed: value'), /^[a-f0-9-]{36}$/);
  assert.match(correlationId('x'.repeat(1000)), /^[a-f0-9-]{36}$/);
});
test('only the application realm and assets are proxyable', () => {
  assert.equal(identityPathAllowed('/identity/realms/tops/.well-known/openid-configuration'), true);
  assert.equal(identityPathAllowed('/identity/resources/app/theme.css'), true);
  for (const path of [
    '/identity/admin/',
    '/identity/realms/master/',
    '/identity/health/ready',
    '/identity/realms/tops/../master/',
    '/identity/realms/tops/%2e%2e/master/',
    '/identity/resources/%252e%252e/admin/',
    '/identity/resources/..\\admin/',
    '/identity/resources/%broken',
  ])
    assert.equal(identityPathAllowed(path), false, path);
});
