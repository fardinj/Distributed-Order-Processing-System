const mode = process.argv[2];
if (
  !['load', 'outages', 'snapshot', 'restore', 'audit', 'cleanup-load', 'proxy-reuse'].includes(mode)
)
  throw new Error('Expected an explicit verification mode');
await import(`./${mode}.mjs`);
