import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const [clientId, name, expected] of [
  ['fixture-admin', 'fixture_admin', 200],
  ['fixture-customer-a', 'fixture_customer_a', 403],
]) {
  const client_secret = (await readFile(`/run/secrets/${name}_password`, 'utf8')).trim();
  const result = await fetch(
    'http://identity:8080/identity/realms/tops/protocol/openid-connect/token',
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret,
      }),
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(result.status, 200);
  const { access_token } = await result.json();
  assert.equal(
    (
      await fetch('http://gateway:3000/api/admin/products', {
        headers: { authorization: `Bearer ${access_token}` },
      })
    ).status,
    expected,
  );
}
assert.equal((await fetch('http://gateway:3000/api/admin/products')).status, 401);
for (const service of ['gateway', 'commerce']) {
  const response = await fetch(`http://${service}:3000/health/ready`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.dependencies.redis.status, 'down');
}
console.log(
  'PASS Redis unavailable: authenticated admin API available; customer/anonymous access still denied; degradation visible.',
);
