import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

for (const [service, database] of [
  ['commerce', 'commerce'],
  ['billing', 'billing'],
  ['bank-simulator', 'bank'],
]) {
  const password = (await readFile(`/run/secrets/${database}_migration_password`, 'utf8')).trim();
  const url = `postgresql://${database}_migrator:${encodeURIComponent(password)}@postgres:5432/${database}?schema=public`;
  const result = spawnSync(
    '/workspace/node_modules/.bin/prisma',
    ['migrate', 'deploy', '--config', `apps/${service}/prisma.config.ts`],
    {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url },
    },
  );
  if (result.status !== 0) throw new Error(`Migration failed for ${service}`);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const expected = (await readdir(`apps/${service}/prisma/migrations`, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const check = await client.query(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    const completed = new Set(check.rows.map((row) => row.migration_name));
    if (!expected.length || expected.some((name) => !completed.has(name)))
      throw new Error(`Expected migrations are not all recorded for ${service}`);
  } finally {
    await client.end();
  }
}
console.log(
  'Owner-local migrations deployed; application containers never receive migrator credentials.',
);
