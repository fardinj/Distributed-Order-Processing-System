import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

// Operator repair: the durable slot ledger is authoritative. Never free unsettled slots based on an alert/status guess.
const client = new Client({
  host: 'postgres',
  database: 'commerce',
  user: 'commerce_runtime',
  password: (await readFile('/run/secrets/commerce_db_password', 'utf8')).trim(),
  connectionTimeoutMillis: 1500,
  statement_timeout: 3000,
});
await client.connect();
try {
  await client.query('BEGIN');
  const budget = (
    await client.query('SELECT used,capacity FROM admission_budget WHERE id=1 FOR UPDATE')
  ).rows[0];
  const actual = Number(
    (await client.query('SELECT count(*) AS count FROM admission_slots WHERE released_at IS NULL'))
      .rows[0].count,
  );
  if (actual > budget.capacity)
    throw new Error(
      'Live slots exceed capacity; increase budget deliberately, never discard accepted work',
    );
  await client.query('UPDATE admission_budget SET used=$1 WHERE id=1', [actual]);
  await client.query('COMMIT');
  console.log(
    JSON.stringify({ previousUsed: budget.used, used: actual, capacity: budget.capacity }),
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
