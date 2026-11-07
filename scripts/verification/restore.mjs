import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { fingerprint, systemId } from './snapshot.mjs';
import { db, close, save, pass } from './client.mjs';
const phase = process.argv[3],
  run = process.env.BACKUP_RUN;
assert.match(run ?? '', /^[a-zA-Z0-9_-]+$/);
const source = JSON.parse(await readFile(`/verification/backups/${run}/manifest.json`, 'utf8'));
try {
  const actualSystemId = await systemId();
  assert.notEqual(actualSystemId, source.systemId, 'Never restore/replay into the source cluster');
  if (phase === 'guard') {
    const initial = await fingerprint();
    for (const owner of Object.keys(initial))
      assert.equal(
        Object.keys(initial[owner]).length,
        0,
        'Restore requires fresh empty owner databases',
      );
    await writeFile(`/verification/backups/${run}/restore-target-id`, actualSystemId + '\n', {
      mode: 0o600,
    });
    pass('new empty PostgreSQL target is distinct from the original source');
  } else if (phase === 'compare') {
    assert.deepEqual(
      await fingerprint(),
      source.tables,
      'Restored tables must have identical row count/content before services start',
    );
    await save('restore-comparison', {
      sourceSystemId: source.systemId,
      targetSystemId: actualSystemId,
      matched: true,
      owners: Object.fromEntries(
        Object.entries(source.tables).map(([name, tables]) => [
          name,
          {
            tables: Object.keys(tables).length,
            rows: Object.values(tables).reduce((sum, t) => sum + t.rows, 0),
          },
        ]),
      ),
    });
    pass('all four owner databases match quiescent snapshot SHA-256 fingerprints exactly');
  } else if (phase === 'replay-gaps') {
    const replayed = {};
    for (const owner of ['commerce', 'billing']) {
      const other = owner === 'commerce' ? 'billing' : 'commerce';
      let cursor = null,
        total = 0;
      for (;;) {
        const rows = await db(
          owner,
          'SELECT id FROM outbox WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 500',
          [cursor],
        );
        if (!rows.length) break;
        const inbox = await db(
          other,
          'SELECT message_id FROM inbox_messages WHERE consumer=$1 AND message_id=ANY($2::uuid[])',
          [`${other}-events`, rows.map((r) => r.id)],
        );
        const received = new Set(inbox.map((r) => r.message_id)),
          missing = rows.filter((r) => !received.has(r.id)).map((r) => r.id);
        if (missing.length) {
          await db(
            owner,
            'UPDATE outbox SET published_at=NULL,claim_token=NULL,lease_until=NULL,available_at=clock_timestamp() WHERE id=ANY($1::uuid[]) RETURNING id',
            [missing],
          );
          total += missing.length;
        }
        cursor = rows.at(-1).id;
      }
      replayed[owner] = total;
    }
    await save('restore-replay', { targetSystemId: actualSystemId, replayed });
    pass(`fresh broker reconstruction preserves event IDs/receipts: ${JSON.stringify(replayed)}`);
  } else throw new Error('Explicit restore phase required');
} finally {
  await close();
}
