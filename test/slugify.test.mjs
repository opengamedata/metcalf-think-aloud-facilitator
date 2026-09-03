import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { slugify } from '../src/slugify.mjs';
import { createServer } from '../src/server.mjs';

test('slugify normalizes free-form text into URL-safe slugs', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Leading and Trailing Spaces  '), 'leading-and-trailing-spaces');
  assert.equal(slugify('Multiple    Spaces'), 'multiple-spaces');
  assert.equal(slugify('Special!@#Chars$%'), 'special-chars');
  assert.equal(slugify('Already--Hyphenated'), 'already-hyphenated');
  assert.equal(slugify(''), '');
  assert.equal(slugify('---'), '');
});

test('slugify passes already-valid slugs through byte-identical', () => {
  for (const s of ['wake-test', 'stub-camp', 'zip-camp', 'a1', 'x-9-y', '2024-study'])
    assert.equal(slugify(s), s);
});

test('slugify tolerates non-string input', () => {
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
  assert.equal(slugify(42), '42');
});

const PW = 'test-secret';
const admin = { authorization: `Bearer ${PW}`, 'content-type': 'application/json' };

const withApp = async (fn) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-slug-'));
  const server = createServer({ dataDir, adminPassword: PW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
};

test('POST /api/admin/campaigns slugifies instead of rejecting', () => withApp(async (base) => {
  const res = await fetch(`${base}/api/admin/campaigns`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ slug: 'My Great Study!', name: 'S', gameUrl: 'https://example.com/g/' }) });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.slug, 'my-great-study');
  assert.equal(out.url, '/c/my-great-study');

  // stored under the normalized slug, and the participant URL resolves
  const got = await (await fetch(`${base}/api/admin/campaigns/my-great-study`, { headers: admin })).json();
  assert.equal(got.name, 'S');
  assert.equal((await fetch(`${base}/c/my-great-study`)).status, 200);
}));

test('a slug that slugify cannot rescue still returns the helpful 400', () => withApp(async (base) => {
  for (const slug of ['', '---', '!!']) {
    const res = await fetch(`${base}/api/admin/campaigns`, {
      method: 'POST', headers: admin,
      body: JSON.stringify({ slug, name: 'S', gameUrl: 'https://example.com/g/' }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /3-40 characters/);
  }
}));
