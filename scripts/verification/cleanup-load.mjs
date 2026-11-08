import assert from 'node:assert/strict';
import { secret, token, api, db, close, load, deactivate, pass } from './client.mjs';
const state = await load('load-results');
assert.match(state.run, /^[a-f0-9]{8}$/);
assert.ok(state.orderIds?.length > 0);
const login = await fetch(
  'http://identity:8080/identity/realms/master/protocol/openid-connect/token',
  {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'tops_bootstrap_admin',
      password: await secret('identity_admin'),
    }),
  },
);
assert.equal(login.status, 200);
const root = (await login.json()).access_token;
try {
  assert.equal(
    (
      await db(
        'commerce',
        "SELECT count(*)::int AS remaining FROM orders WHERE id=ANY($1::uuid[]) AND status<>'COMPLETED'",
        [state.orderIds],
      )
    )[0].remaining,
    0,
    'Only completed load fixtures can be deactivated',
  );
  const p = (
    await db('commerce', 'SELECT product_id AS id FROM order_items WHERE order_id=$1', [
      state.orderIds[0],
    ])
  )[0];
  await deactivate(await token('fixture-admin', 'fixture_admin'), p);
  for (let n = 0; n < 8; n++) {
    const id = `fixture-load-${state.run}-${n}`,
      query = await fetch(
        `http://identity:8080/identity/admin/realms/tops/clients?clientId=${id}`,
        { headers: { authorization: `Bearer ${root}` } },
      );
    assert.equal(query.status, 200);
    const clients = await query.json();
    assert.equal(clients.length, 1);
    const response = await fetch(
      `http://identity:8080/identity/admin/realms/tops/clients/${clients[0].id}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${root}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: id, enabled: false }),
      },
    );
    assert.equal(response.status, 204);
  }
  pass(
    'identified completed load fixtures deactivated; accepted orders and financial evidence preserved',
  );
} finally {
  await close();
}
