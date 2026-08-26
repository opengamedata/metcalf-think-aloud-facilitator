import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

const withServer = async (fn) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
};

test('healthz answers ok', () => withServer(async (base) => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
}));

test('unknown routes 404 as json', () => withServer(async (base) => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
}));
