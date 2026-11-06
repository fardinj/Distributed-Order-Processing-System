import { readFile, writeFile } from 'node:fs/promises';

const base = 'http://identity:8080/identity';
const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:8080';
const fixtures = process.argv.includes('--fixtures');
const secret = async (name) => (await readFile(`/run/secrets/${name}_password`, 'utf8')).trim();
const login = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: 'tops_bootstrap_admin',
    password: await secret('identity_admin'),
  }),
  signal: AbortSignal.timeout(10000),
});
if (!login.ok) throw new Error(`Identity bootstrap authentication failed: HTTP ${login.status}`);
const { access_token: token } = await login.json();
async function api(path, method = 'GET', body, allowed = []) {
  const response = await fetch(`${base}/admin/realms/tops${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok && !allowed.includes(response.status))
    throw new Error(
      `Identity provisioning ${method} ${path.split('?')[0]}: HTTP ${response.status}`,
    );
  return response.status === 204 || response.status === 201 || allowed.includes(response.status)
    ? null
    : response.json();
}
for (const name of ['customer', 'admin', 'service']) await api('/roles', 'POST', { name }, [409]);
const role = async (name) => api(`/roles/${name}`);
const audience = {
  name: 'tops-api-audience',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  consentRequired: false,
  config: {
    'included.client.audience': 'tops-api',
    'id.token.claim': 'false',
    'access.token.claim': 'true',
    'introspection.token.claim': 'true',
  },
};
async function client(clientId, extra) {
  const body = {
    clientId,
    protocol: 'openid-connect',
    enabled: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    fullScopeAllowed: true,
    defaultClientScopes: ['roles'],
    protocolMappers: [audience],
    ...extra,
  };
  let list = await api(`/clients?clientId=${encodeURIComponent(clientId)}`);
  if (list.length) await api(`/clients/${list[0].id}`, 'PUT', { ...body, id: list[0].id });
  else await api('/clients', 'POST', body);
  list = await api(`/clients?clientId=${encodeURIComponent(clientId)}`);
  // Update mappers explicitly too; older existing clients must receive the audience.
  const mappers = await api(`/clients/${list[0].id}/protocol-mappers/models`);
  const existing = mappers.find((mapper) => mapper.name === audience.name);
  if (existing)
    await api(`/clients/${list[0].id}/protocol-mappers/models/${existing.id}`, 'PUT', {
      ...audience,
      id: existing.id,
    });
  else await api(`/clients/${list[0].id}/protocol-mappers/models`, 'POST', audience);
  return list[0].id;
}
await client('tops-api', { bearerOnly: true, publicClient: false });
await client('tops-web', {
  publicClient: true,
  standardFlowEnabled: true,
  redirectUris: [`${publicUrl}/auth/callback`],
  webOrigins: [publicUrl],
  attributes: { 'pkce.code.challenge.method': 'S256' },
});
const report = {
  realm: 'tops',
  issuer: `${publicUrl}/identity/realms/tops`,
  clients: {},
  users: {},
};
async function serviceClient(clientId, secretName, roleName) {
  const id = await client(clientId, {
    publicClient: false,
    serviceAccountsEnabled: true,
    secret: await secret(secretName),
  });
  const account = await api(`/clients/${id}/service-account-user`);
  await api(`/users/${account.id}/role-mappings/realm`, 'POST', [await role(roleName)]);
  report.clients[clientId] = {
    id,
    subject: account.id,
    role: roleName,
    secretFile: `${secretName}_password`,
  };
}
await serviceClient('commerce-service', 'commerce_service', 'service');
await serviceClient('billing-service', 'billing_service', 'service');
if (fixtures) {
  for (const [suffix, roleName] of [
    ['customer-a', 'customer'],
    ['customer-b', 'customer'],
    ['admin', 'admin'],
  ]) {
    const username = `demo-${suffix}`;
    let users = await api(`/users?username=${username}&exact=true`);
    if (!users.length) {
      await api('/users', 'POST', {
        username,
        enabled: true,
        email: `${username}@example.test`,
        emailVerified: true,
        firstName: 'Demo',
        lastName: suffix,
        credentials: [
          {
            type: 'password',
            temporary: false,
            value: await secret(`user_${suffix.replaceAll('-', '_')}`),
          },
        ],
      });
      users = await api(`/users?username=${username}&exact=true`);
    }
    await api(`/users/${users[0].id}/role-mappings/realm`, 'POST', [await role(roleName)]);
    if (roleName === 'admin') {
      const credentials = await api(`/users/${users[0].id}/credentials`);
      if (!credentials.some((credential) => credential.type === 'otp')) {
        const user = await api(`/users/${users[0].id}`);
        await api(`/users/${users[0].id}`, 'PUT', {
          ...user,
          requiredActions: [...new Set([...(user.requiredActions ?? []), 'CONFIGURE_TOTP'])],
        });
      }
    }
    report.users[username] = { id: users[0].id, role: roleName };
    await serviceClient(`fixture-${suffix}`, `fixture_${suffix.replaceAll('-', '_')}`, roleName);
  }
}
await writeFile('/state/identity.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(
  `Identity provisioned: API audience, PKCE web client, two service identities${fixtures ? ', explicit development fixtures' : ''}. No passwords/tokens printed.`,
);
