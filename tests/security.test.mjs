import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TokenVerifier } from '../dist/packages/runtime/src/security.js';

test('real signed JWT verification enforces issuer, audience, expiry, token type and subject', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = { ...(await exportJWK(publicKey)), kid: 'unit-key', alg: 'RS256', use: 'sig' };
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [key] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const before = { issuer: process.env.OIDC_ISSUER, jwks: process.env.OIDC_JWKS_URL };
  process.env.OIDC_ISSUER = 'https://identity.example.test/realms/tops';
  process.env.OIDC_JWKS_URL = `http://127.0.0.1:${server.address().port}/keys`;
  try {
    const verifier = new TokenVerifier();
    const token = async (changes = {}) =>
      new SignJWT({
        sub: 'customer-a',
        azp: 'tops-web',
        typ: 'Bearer',
        realm_access: { roles: ['customer'] },
        iss: process.env.OIDC_ISSUER,
        aud: 'tops-api',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
        ...changes,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'unit-key' })
        .sign(privateKey);
    const principal = await verifier.authenticate(`Bearer ${await token()}`);
    assert.equal(principal.id, 'customer-a');
    assert.deepEqual(principal.roles, ['customer']);
    for (const change of [
      { iss: 'https://attacker.test' },
      { aud: 'other-api' },
      { exp: 1 },
      { typ: 'ID' },
      { sub: '' },
    ]) {
      await assert.rejects(
        verifier.authenticate(`Bearer ${await token(change)}`),
        (error) => error.getStatus() === 401,
      );
    }
    await assert.rejects(
      verifier.authenticate('Bearer forged.value.token'),
      (error) => error.getStatus() === 401,
    );
    await assert.rejects(verifier.authenticate(undefined), (error) => error.getStatus() === 401);
  } finally {
    if (before.issuer === undefined) delete process.env.OIDC_ISSUER;
    else process.env.OIDC_ISSUER = before.issuer;
    if (before.jwks === undefined) delete process.env.OIDC_JWKS_URL;
    else process.env.OIDC_JWKS_URL = before.jwks;
    await new Promise((resolve) => server.close(resolve));
  }
});
