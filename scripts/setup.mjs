import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const local = resolve(root, '.local');
await mkdir(resolve(local, 'secrets'), { recursive: true, mode: 0o700 });
await mkdir(resolve(local, 'rabbitmq'), { recursive: true, mode: 0o700 });
await mkdir(resolve(local, 'identity'), { recursive: true, mode: 0o700 });

const names = [
  'postgres_admin',
  'commerce_db',
  'commerce_migration',
  'billing_db',
  'billing_migration',
  'bank_db',
  'bank_migration',
  'identity_db',
  'identity_admin',
  'rabbitmq_admin',
  'commerce_rabbitmq',
  'billing_rabbitmq',
  'redis',
  'commerce_service',
  'billing_service',
  'fixture_customer_a',
  'fixture_customer_b',
  'fixture_admin',
  'user_customer_a',
  'user_customer_b',
  'user_admin',
];
for (const name of names) {
  try {
    await writeFile(
      resolve(local, 'secrets', `${name}_password`),
      `${randomBytes(32).toString('hex')}\n`,
      {
        flag: 'wx',
        mode: 0o444,
      },
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function passwordHash(name) {
  const password = (await readFile(resolve(local, 'secrets', `${name}_password`), 'utf8')).trim();
  const salt = randomBytes(4);
  return Buffer.concat([
    salt,
    createHash('sha256').update(salt).update(password).digest(),
  ]).toString('base64');
}

const definitions = {
  users: await Promise.all(
    [
      ['tops_admin', 'rabbitmq_admin', ['administrator']],
      ['commerce', 'commerce_rabbitmq', []],
      ['billing', 'billing_rabbitmq', []],
    ].map(async ([name, secret, tags]) => ({
      name,
      tags,
      password_hash: await passwordHash(secret),
      hashing_algorithm: 'rabbit_password_hashing_sha256',
    })),
  ),
  vhosts: [{ name: 'tops' }],
  permissions: [
    { user: 'tops_admin', vhost: 'tops', configure: '.*', write: '.*', read: '.*' },
    {
      user: 'commerce',
      vhost: 'tops',
      configure: '^commerce\\.(events|q\\..*)$',
      write: '^commerce\\.(events|q\\..*)$',
      read: '^(commerce\\.q\\..*|billing\\.events)$',
    },
    {
      user: 'billing',
      vhost: 'tops',
      configure: '^billing\\.(events|q\\..*)$',
      write: '^billing\\.(events|q\\..*)$',
      read: '^(billing\\.q\\..*|commerce\\.events)$',
    },
  ],
  exchanges: ['commerce.events', 'billing.events'].map((name) => ({
    name,
    vhost: 'tops',
    type: 'topic',
    durable: true,
    auto_delete: false,
    internal: false,
    arguments: {},
  })),
};
const definitionFile = resolve(local, 'rabbitmq', 'definitions.json');
try {
  await access(definitionFile);
} catch {
  await writeFile(definitionFile, JSON.stringify(definitions, null, 2) + '\n', { mode: 0o444 });
}
try {
  await access(resolve(root, '.env'));
} catch {
  await writeFile(resolve(root, '.env'), await readFile(resolve(root, '.env.example')), {
    flag: 'wx',
  });
}
console.log(
  'Local configuration ready. Existing secrets/configuration were preserved; no credentials printed.',
);
