import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { token, save, pass } from './client.mjs';
const bearer = await token('fixture-customer-a', 'fixture_customer_a');
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
let connections = 0;
const connect = agent.createConnection.bind(agent);
agent.createConnection = (...args) => {
  connections++;
  return connect(...args);
};
async function read() {
  return new Promise((resolve, reject) => {
    const req = request(
      'http://gateway:3000/api/products?limit=1',
      { agent, headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10000) },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}
try {
  for (let n = 0; n < 200; n++) assert.equal(await read(), 200);
  assert.equal(connections, 1, 'The burst must exercise one reused incoming socket');
  const burstConnections = connections;
  await pause(6500);
  assert.equal(await read(), 200);
  await save('proxy-reuse', {
    requests: 201,
    burstConnections,
    status: 200,
    checkedAt: new Date().toISOString(),
  });
  pass(
    '200 authenticated reads reuse one socket; a request after the deadline interval still succeeds',
  );
} finally {
  agent.destroy();
}
