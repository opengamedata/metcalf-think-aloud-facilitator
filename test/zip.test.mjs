import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { buildZip, crc32 } from '../src/zip.mjs';
import { createServer } from '../src/server.mjs';

const PW = 'test-secret';
const admin = { authorization: `Bearer ${PW}`, 'content-type': 'application/json' };

test('crc32 matches known vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('buildZip output round-trips through system unzip', () => {
  const zip = buildZip([
    { name: 'a/hello.txt', data: Buffer.from('hello metcalf\n') },
    { name: 'a/b.jsonl', data: Buffer.from('{"t":1}\n{"t":2}\n') },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-zip-'));
  const zPath = path.join(dir, 'x.zip');
  fs.writeFileSync(zPath, zip);
  try {
    execFileSync('unzip', ['-o', '-q', zPath, '-d', dir]);
    assert.equal(fs.readFileSync(path.join(dir, 'a/hello.txt'), 'utf8'), 'hello metcalf\n');
    assert.equal(fs.readFileSync(path.join(dir, 'a/b.jsonl'), 'utf8'), '{"t":1}\n{"t":2}\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('campaign package.zip contains manifest and session files', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-'));
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<head></head>'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const server = createServer({ dataDir, adminPassword: PW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/api/admin/campaigns`, { method: 'POST', headers: admin, body: JSON.stringify({
      slug: 'zip-camp', name: 'Z', gameUrl: `http://127.0.0.1:${upstream.address().port}/` }) });
    const { sessionId } = await (await fetch(`${base}/api/session/start`, {
      method: 'POST', body: JSON.stringify({ slug: 'zip-camp', consent: true }) })).json();
    await fetch(`${base}/api/s/${sessionId}/events`, { method: 'POST',
      body: JSON.stringify({ events: [{ lane: 'transcript', t: 100, text: 'hi' }] }) });
    await fetch(`${base}/api/s/${sessionId}/end`, { method: 'POST' });

    const r = await fetch(`${base}/api/admin/campaigns/zip-camp/package.zip`, { headers: admin });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    const buf = Buffer.from(await r.arrayBuffer());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-pkg-'));
    fs.writeFileSync(path.join(dir, 'p.zip'), buf);
    execFileSync('unzip', ['-o', '-q', path.join(dir, 'p.zip'), '-d', dir]);
    const manifest = fs.readFileSync(path.join(dir, 'zip-camp/manifest.csv'), 'utf8');
    assert.match(manifest, /sessionId,playerCode,startedAt/);
    assert.match(manifest, new RegExp(sessionId));
    assert.match(fs.readFileSync(path.join(dir, `zip-camp/${sessionId}/transcript.jsonl`), 'utf8'), /"hi"/);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { server.close(); upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
