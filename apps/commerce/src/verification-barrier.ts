import { readFile, writeFile, rename } from 'node:fs/promises';
// Opt-in only for disposable verification replicas. No request can select a fault.
export async function verificationBarrier(itemId: string, phase: 'after_effect' | 'after_commit') {
  if (process.env.TOPS_VERIFICATION_BARRIERS !== '1' || !process.env.VERIFICATION_CONTROL_FILE)
    return;
  const content = await readFile(process.env.VERIFICATION_CONTROL_FILE, 'utf8');
  if (content.length > 4096) throw new Error('Invalid private verification control');
  const target = JSON.parse(content);
  if (target.itemId !== itemId || target.phase !== phase) return;
  await writeFile(
    '/verification/barrier-reached.pending',
    JSON.stringify({ itemId, phase, pid: process.pid }),
    { mode: 0o600 },
  );
  await rename('/verification/barrier-reached.pending', '/verification/barrier-reached.json');
  await new Promise<void>(() => {});
}
