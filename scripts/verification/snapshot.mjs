import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { secret, save, close } from './client.mjs';
export async function systemId() {
  const admin = new Client({
    host: 'postgres',
    database: 'postgres',
    user: 'postgres',
    password: await secret('postgres_admin'),
  });
  await admin.connect();
  try {
    return (await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()'))
      .rows[0].id;
  } finally {
    await admin.end();
  }
}
export async function fingerprint() {
  const result = {};
  for (const owner of ['commerce', 'billing', 'bank', 'identity']) {
    const client = new Client({
      host: 'postgres',
      database: owner,
      user: owner === 'identity' ? 'identity_owner' : `${owner}_migrator`,
      password: await secret(owner === 'identity' ? 'identity_db' : `${owner}_migration`),
    });
    await client.connect();
    try {
      const tables = (
        await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows;
      result[owner] = {};
      for (const { tablename } of tables) {
        const quoted = '"' + tablename.replaceAll('"', '""') + '"',
          hash = createHash('sha256');
        let count = 0;
        await client.query('BEGIN READ ONLY');
        await client.query(
          `DECLARE verification_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS value FROM public.${quoted} t ORDER BY row_to_json(t)::text COLLATE "C"`,
        );
        for (;;) {
          const { rows } = await client.query('FETCH FORWARD 100 FROM verification_rows');
          if (!rows.length) break;
          for (const row of rows) {
            hash.update(`${Buffer.byteLength(row.value)}:`).update(row.value);
            count++;
          }
        }
        await client.query('COMMIT');
        result[owner][tablename] = { rows: count, sha256: hash.digest('hex') };
      }
    } finally {
      await client.end();
    }
  }
  return result;
}
if (process.argv[2] === 'snapshot') {
  try {
    await save('backup-manifest', {
      createdAt: new Date().toISOString(),
      systemId: await systemId(),
      tables: await fingerprint(),
    });
    console.log(
      'PASS quiescent owner-table counts and SHA-256 fingerprints recorded without dumping values to logs',
    );
  } finally {
    await close();
  }
}
