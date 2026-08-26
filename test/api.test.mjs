import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.mjs';

const PW = 'test-secret';
const admin = { authorization: `Bearer ${PW}`, 'content-type': 'application/json' };

const withApp = async (fn) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-'));
  const server = createServer({ dataDir, adminPassword: PW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, dataDir); } finally { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
};

const campaign = {
  slug: 'wake-test', name: 'Wake test', gameUrl: 'https://example.com/game/',
  instructionsMd: 'Play.', consentMd: 'OK?', thankyouMd: 'Thanks!',
  checklist: [{ id: 'a', label: 'Do a thing' }],
};

test('campaign CRUD requires auth and round-trips', () => withApp(async (base) => {
  const noAuth = await fetch(`${base}/api/admin/campaigns`, { method: 'POST', body: '{}' });
  assert.equal(noAuth.status, 401);

  const create = await fetch(`${base}/api/admin/campaigns`, {
    method: 'POST', headers: admin, body: JSON.stringify(campaign) });
  assert.equal(create.status, 200);

  const got = await (await fetch(`${base}/api/admin/campaigns/wake-test`, { headers: admin })).json();
  assert.equal(got.name, 'Wake test');
  assert.equal((await (await fetch(`${base}/api/admin/campaigns`, { headers: admin })).json()).length, 1);

  const bad = await fetch(`${base}/api/admin/campaigns`, {
    method: 'POST', headers: admin, body: JSON.stringify({ slug: 'X!', gameUrl: 'nope' }) });
  assert.equal(bad.status, 400);
}));

test('session lifecycle: start -> events -> video -> end summary', () => withApp(async (base, dataDir) => {
  await fetch(`${base}/api/admin/campaigns`, { method: 'POST', headers: admin, body: JSON.stringify(campaign) });

  const noConsent = await fetch(`${base}/api/session/start`, {
    method: 'POST', body: JSON.stringify({ slug: 'wake-test' }) });
  assert.equal(noConsent.status, 400);

  const { sessionId } = await (await fetch(`${base}/api/session/start`, {
    method: 'POST', body: JSON.stringify({ slug: 'wake-test', consent: true }) })).json();
  assert.match(sessionId, /^[a-f0-9]{16}$/);

  const events = [
    { lane: 'clicks', t: 1000, n: 1, x: 10, y: 20 },
    { lane: 'clicks', t: 2000, n: 2, x: 30, y: 40 },
    { lane: 'transcript', t: 1500, text: 'this looks clickable' },
    { lane: 'ogd', t: 1800, url: 'https://fieldday-web.wcer.wisc.edu/x', bytes: 12, playerCode: 'FROG42' },
    { lane: 'checklist', t: 2500, item: 'a', checked: true },
    { lane: 'bogus', t: 1, nope: true },
  ];
  const ing = await (await fetch(`${base}/api/s/${sessionId}/events`, {
    method: 'POST', body: JSON.stringify({ events }) })).json();
  assert.equal(ing.accepted, 5);

  const chunk = Buffer.from('fake-webm-bytes');
  await fetch(`${base}/api/s/${sessionId}/video?seq=0&t=0`, { method: 'POST', body: chunk });

  const sum = await (await fetch(`${base}/api/s/${sessionId}/end`, { method: 'POST' })).json();
  assert.equal(sum.utterances, 1);
  assert.equal(sum.clicks, 2);
  assert.equal(sum.ogdLogs, 1);
  assert.equal(sum.durationMs, 2500);

  const dir = path.join(dataDir, 'sessions', 'wake-test', sessionId);
  assert.ok(fs.existsSync(path.join(dir, 'session.webm')));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(meta.playerCode, 'FROG42');
  assert.equal(meta.counts.clicks, 2);

  const late = await fetch(`${base}/api/s/${sessionId}/video?seq=1`, { method: 'POST', body: chunk });
  assert.equal(late.status, 409);
}));

test('admin sessions table and merged timeline', () => withApp(async (base) => {
  await fetch(`${base}/api/admin/campaigns`, { method: 'POST', headers: admin, body: JSON.stringify(campaign) });
  const { sessionId } = await (await fetch(`${base}/api/session/start`, {
    method: 'POST', body: JSON.stringify({ slug: 'wake-test', consent: true }) })).json();
  await fetch(`${base}/api/s/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({ events: [
      { lane: 'transcript', t: 900, text: 'hm' },
      { lane: 'clicks', t: 400, n: 1, x: 1, y: 2 },
    ] }) });
  await fetch(`${base}/api/s/${sessionId}/end`, { method: 'POST' });

  const rows = await (await fetch(`${base}/api/admin/campaigns/wake-test/sessions`, { headers: admin })).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ended');

  const tl = await (await fetch(`${base}/api/admin/sessions/${sessionId}/timeline`, { headers: admin })).json();
  const ts = tl.events.map((e) => e.t);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  assert.ok(tl.events.some((e) => e.lane === 'marks' && e.kind === 'start'));
  assert.ok(tl.events.some((e) => e.lane === 'marks' && e.kind === 'end'));
}));

test('login sets a cookie that authorizes admin routes', () => withApp(async (base) => {
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', body: JSON.stringify({ password: PW }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const list = await fetch(`${base}/api/admin/campaigns`, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal((await fetch(`${base}/api/admin/login`, {
    method: 'POST', body: JSON.stringify({ password: 'wrong' }) })).status, 401);
}));
