const names = new Set(['gateway', 'commerce', 'billing', 'bank-simulator']);
const name = process.env.SERVICE_NAME;
if (!names.has(name)) throw new Error('Unknown SERVICE_NAME');
await import(`../dist/apps/${name}/src/main.js`);
