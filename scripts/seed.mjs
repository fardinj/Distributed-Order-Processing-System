import { Client } from 'pg';
import { readFile } from 'node:fs/promises';

const products = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'دسترسی دیجیتال',
    type: 'DIGITAL',
    price: '1500000',
    duration: null,
    metadata: { product: 'demo-course' },
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    name: 'اشتراک سی روزه',
    type: 'SUBSCRIPTION',
    price: '2500000',
    duration: 30,
    metadata: null,
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    name: 'کالای فیزیکی',
    type: 'PHYSICAL',
    price: '5000000',
    duration: null,
    metadata: null,
  },
];
async function database(name, work) {
  const password = (await readFile(`/run/secrets/${name}_migration_password`, 'utf8')).trim();
  const client = new Client({
    host: 'postgres',
    database: name,
    user: `${name}_migrator`,
    password,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
await database('commerce', async (client) => {
  for (const product of products) {
    const inserted = await client.query(
      `INSERT INTO products (id,name,type,price_minor,subscription_days,digital_metadata)
      VALUES ($1,$2,$3,$4::numeric,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [
        product.id,
        product.name,
        product.type,
        product.price,
        product.duration,
        product.metadata === null ? null : JSON.stringify(product.metadata),
      ],
    );
    if (product.type === 'PHYSICAL' && inserted.rowCount)
      await client.query('INSERT INTO inventory(product_id,available) VALUES ($1,50)', [
        product.id,
      ]);
  }
});
await database('bank', async (client) => {
  for (const [reference, outcome, description] of [
    ['SUCCESS', 'SUCCEED', 'Known successful payment'],
    ['FAIL', 'FAIL', 'Definitive bank decline'],
    ['TIMEOUT_BEFORE', 'TIMEOUT_BEFORE', 'Pending before any successful charge'],
    ['TIMEOUT_AFTER', 'TIMEOUT_AFTER', 'Successful charge with lost response'],
  ])
    await client.query(
      'INSERT INTO simulation_rules(reference,outcome,description) VALUES ($1,$2,$3) ON CONFLICT(reference) DO NOTHING',
      [reference, outcome, description],
    );
});
console.log(
  'Deterministic products/stock and provider rule fixtures inserted; existing admin changes preserved.',
);
