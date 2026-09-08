// Session lifecycle: idle reaping with an injected clock, force-end,
// abandoned-session duration, researcher flags, and schema migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrateSessions, SESSION_COLUMNS } from '../src/db.mjs';
import { createApi } from '../src/api.mjs';

const PW = 'test-secret';
const admin = { authorization: `Bearer ${PW}`, 'content-type': 'application/json' };

const campaign = {
  slug: 'wake-test', name: 'Wake test', gameUrl: 'https://example.com/game/',
  instructionsMd: 'Play.', consentMd: 'OK?', thankyouMd: 'Thanks!',
  checklist: [{ id: 'a', label: 'Do a thing' }],
};

// Same shape as test/api.test.mjs's withApp, but wires the API directly so the
// clock can be injected and the interval reaper disabled. No sleeps anywhere.
const withApp = async (fn, { idleMs = 60_000, start = Date.UTC(2026, 8, 8, 12, 0, 0) } = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-life-'));
  const clock = { t: start };
  const db = openDb(dataDir);
  const api = createApi({
    db, dataDir, adminPassword: PW, idleMs, reapIntervalMs: 0, now: () => clock.t,
  });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (await api(req, res, u)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b, h = {}) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json', ...h },
    body: b === undefined ? undefined : JSON.stringify(b) });
  const getJson = async (p, h = admin) => (await fetch(base + p, { headers: h })).json();
  const startSession = async () => (await (await post('/api/session/start',
    { slug: 'wake-test', consent: true })).json()).sessionId;

  await post('/api/admin/campaigns', campaign, admin);
  try {
    await fn({ base, dataDir, clock, api, db, post, getJson, startSession });
  } finally {
    api.stopReaper();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
};

test('idle live sessions are reaped as abandoned; active ones are not', () => withApp(
  async ({ clock, api, db, post, startSession }) => {
    const idle = await startSession();
    const active = await startSession();

    // Both are live and untouched at t0.
    assert.equal(db.getSession(idle).status, 'live');
    assert.deepEqual(api.reap().reaped, []);

    // 30s in: only `active` sends events, so only it gets a fresh heartbeat.
    clock.t += 30_000;
    await post(`/api/s/${active}/events`, { events: [{ lane: 'clicks', t: 30_000, n: 1, x: 1, y: 2 }] });

    // 61s past `idle`'s last heartbeat, 31s past `active`'s.
    clock.t += 31_000;
    const r = api.reap();
    assert.deepEqual(r.reaped, [idle]);
    assert.equal(r.idleMs, 60_000);

    assert.equal(db.getSession(idle).status, 'abandoned');
    assert.equal(db.getSession(idle).closedReason, 'idle-timeout');
    assert.ok(db.getSession(idle).endedAt);
    assert.equal(db.getSession(active).status, 'live');

    // A second sweep at the same instant does not touch the already-closed row.
    assert.deepEqual(api.reap().reaped, []);
  }));

test('abandoned durationMs comes from event t; zero-event sessions are 0 not null', () => withApp(
  async ({ clock, api, post, getJson, startSession }) => {
    const withEvents = await startSession();
    const empty = await startSession();
    await post(`/api/s/${withEvents}/events`, { events: [
      { lane: 'transcript', t: 4200, text: 'stuck here' },
      { lane: 'clicks', t: 7500, n: 1, x: 3, y: 4 },
    ] });

    clock.t += 10 * 60_000;
    api.reap();

    const rows = await getJson('/api/admin/campaigns/wake-test/sessions');
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
    assert.equal(byId[withEvents].status, 'abandoned');
    assert.equal(byId[withEvents].durationMs, 7500);
    // Only the t=0 'start' mark exists: a real number, not null/NaN.
    assert.equal(byId[empty].durationMs, 0);
    assert.equal(byId[empty].status, 'abandoned');

    // The replay screen reads the per-session record too.
    const tl = await getJson(`/api/admin/sessions/${withEvents}/timeline`);
    assert.equal(tl.session.durationMs, 7500);
  }));

test('listing sessions lazily reaps, and a live row still reports a usable duration', () => withApp(
  async ({ clock, post, getJson, startSession }) => {
    const sid = await startSession();
    await post(`/api/s/${sid}/events`, { events: [{ lane: 'clicks', t: 3000, n: 1, x: 1, y: 1 }] });

    // Still live: durationMs is null in SQLite but the API must not hand the
    // replay UI a null (that is what rendered 0:00 against a 0:03 playhead).
    let rows = await getJson('/api/admin/campaigns/wake-test/sessions');
    assert.equal(rows[0].status, 'live');
    assert.equal(rows[0].durationMs, 3000);

    clock.t += 5 * 60_000;
    rows = await getJson('/api/admin/campaigns/wake-test/sessions');
    assert.equal(rows[0].status, 'abandoned');
    assert.equal(rows[0].durationMs, 3000);
  }));

test('force-end closes a live session, is idempotent, and requires admin auth', () => withApp(
  async ({ base, post, getJson, startSession }) => {
    const sid = await startSession();
    await post(`/api/s/${sid}/events`, { events: [
      { lane: 'transcript', t: 1000, text: 'a' },
      { lane: 'clicks', t: 2000, n: 1, x: 1, y: 1 },
      { lane: 'clicks', t: 2400, n: 2, x: 2, y: 2 },
    ] });

    const anon = await fetch(`${base}/api/admin/sessions/${sid}/force-end`, { method: 'POST' });
    assert.equal(anon.status, 401);
    assert.deepEqual(await anon.json(), { error: 'unauthorized' });

    const first = await (await post(`/api/admin/sessions/${sid}/force-end`, {}, admin)).json();
    assert.equal(first.ok, true);
    assert.equal(first.alreadyClosed, false);
    assert.equal(first.session.status, 'abandoned');
    assert.equal(first.session.closedReason, 'force');
    assert.equal(first.session.durationMs, 2400);
    assert.equal(first.session.clicks, 2);
    assert.equal(first.session.utterances, 1);

    const again = await post(`/api/admin/sessions/${sid}/force-end`, {}, admin);
    assert.equal(again.status, 200);
    const second = await again.json();
    assert.equal(second.alreadyClosed, true);
    // Counts must not double up and endedAt must not move.
    assert.equal(second.session.clicks, 2);
    assert.equal(second.session.durationMs, 2400);
    assert.equal(second.session.endedAt, first.session.endedAt);

    // The participant's own end button on an already-closed session is a no-op.
    const late = await (await post(`/api/s/${sid}/end`)).json();
    assert.equal(late.clicks, 2);
    assert.equal(late.status, 'abandoned');

    // Raw jsonl is untouched by any of this.
    const rows = await getJson('/api/admin/campaigns/wake-test/sessions');
    assert.equal(rows[0].status, 'abandoned');
  }));

test('participant end still yields status ended, distinct from abandoned', () => withApp(
  async ({ post, getJson, startSession }) => {
    const sid = await startSession();
    await post(`/api/s/${sid}/events`, { events: [{ lane: 'clicks', t: 500, n: 1, x: 1, y: 1 }] });
    const sum = await (await post(`/api/s/${sid}/end`)).json();
    assert.equal(sum.status, 'ended');
    assert.equal(sum.closedReason, 'participant');
    assert.equal(sum.durationMs, 500);
    const rows = await getJson('/api/admin/campaigns/wake-test/sessions');
    assert.equal(rows[0].status, 'ended');
  }));

test('researcher flags round-trip through the sessions API and need auth', () => withApp(
  async ({ base, post, getJson, startSession }) => {
    const sid = await startSession();

    const anon = await fetch(`${base}/api/admin/sessions/${sid}/flags`, {
      method: 'POST', body: '{"excluded":true}' });
    assert.equal(anon.status, 401);

    const set = await (await post(`/api/admin/sessions/${sid}/flags`, {
      excluded: true, exclusionReason: 'mic dead', pilot: true,
      note: 'RA test run before 3rd period', tags: ['pilot', 'bad-audio'],
    }, admin)).json();
    assert.equal(set.session.excluded, true);
    assert.equal(set.session.pilot, true);
    assert.equal(set.session.exclusionReason, 'mic dead');
    assert.deepEqual(set.session.tags, ['pilot', 'bad-audio']);
    assert.ok(set.session.flaggedAt);
    // Analysis judgement must not collide with lifecycle status.
    assert.equal(set.session.status, 'live');

    // Partial update leaves untouched fields alone.
    await post(`/api/admin/sessions/${sid}/flags`, { excluded: false }, admin);
    const rows = await getJson('/api/admin/campaigns/wake-test/sessions');
    assert.equal(rows[0].excluded, false);
    assert.equal(rows[0].pilot, true);
    assert.equal(rows[0].note, 'RA test run before 3rd period');
    assert.deepEqual(rows[0].tags, ['pilot', 'bad-audio']);

    // Flags survive the session being closed.
    await post(`/api/admin/sessions/${sid}/force-end`, {}, admin);
    const one = await getJson(`/api/admin/sessions/${sid}`);
    assert.equal(one.status, 'abandoned');
    assert.equal(one.pilot, true);
    assert.deepEqual(one.tags, ['pilot', 'bad-audio']);

    const bad = await post(`/api/admin/sessions/${sid}/flags`, { tags: 'nope' }, admin);
    assert.equal(bad.status, 400);
  }));

test('migration: fresh database has every lifecycle column', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-mig-new-'));
  try {
    const db = openDb(dir);
    const cols = new Set(db.raw.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
    for (const name of Object.keys(SESSION_COLUMNS)) assert.ok(cols.has(name), `missing ${name}`);
    // Re-opening (and re-migrating) must not throw.
    assert.deepEqual(migrateSessions(db.raw), []);
    db.raw.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration: an OLD-schema database gains the columns without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-mig-old-'));
  try {
    // Exactly the v1 schema that is live in production today.
    const old = new DatabaseSync(path.join(dir, 'app.db'));
    old.exec(`CREATE TABLE sessions (
      sessionId TEXT PRIMARY KEY, slug TEXT NOT NULL,
      startedAt TEXT NOT NULL, endedAt TEXT,
      durationMs INTEGER, playerCode TEXT,
      utterances INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
      ogdLogs INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'live');`);
    old.exec(`INSERT INTO sessions (sessionId, slug, startedAt, status)
      VALUES ('63f0e0a650ef3ade', 'lockes-gambit', '2026-08-27T21:07:04.678Z', 'live');`);
    old.exec(`INSERT INTO sessions (sessionId, slug, startedAt, endedAt, durationMs,
      utterances, clicks, ogdLogs, status) VALUES ('a3f67f29ef0f35a6', 'lockes-gambit',
      '2026-08-26T23:12:13.387Z', '2026-08-26T23:14:36.001Z', 136091, 20, 32, 4, 'ended');`);
    old.close();

    const db = openDb(dir);
    const cols = new Set(db.raw.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
    for (const name of Object.keys(SESSION_COLUMNS)) assert.ok(cols.has(name), `missing ${name}`);

    const live = db.getSession('63f0e0a650ef3ade');
    assert.equal(live.status, 'live');
    assert.equal(live.excluded, 0);
    assert.equal(live.lastEventAt, '2026-08-27T21:07:04.678Z');  // backfilled from startedAt
    const ended = db.getSession('a3f67f29ef0f35a6');
    assert.equal(ended.durationMs, 136091);
    assert.equal(ended.clicks, 32);

    // Idempotent: opening again applies nothing new.
    db.raw.close();
    const again = openDb(dir);
    assert.equal(again.getSession('a3f67f29ef0f35a6').clicks, 32);
    assert.deepEqual(migrateSessions(again.raw), []);
    again.raw.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the twelve-day stale production session is reaped on the next admin read', () => withApp(
  async ({ clock, getJson, startSession, post }) => {
    const sid = await startSession();
    await post(`/api/s/${sid}/events`, { events: [{ lane: 'transcript', t: 136091, text: 'bye' }] });
    clock.t += 12 * 24 * 3600 * 1000;
    const rows = await getJson('/api/admin/campaigns/wake-test/sessions');
    assert.equal(rows[0].status, 'abandoned');
    assert.equal(rows[0].durationMs, 136091);
    assert.equal(rows[0].closedReason, 'idle-timeout');
  }));
