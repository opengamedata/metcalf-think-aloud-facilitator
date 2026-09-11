// Ability to delete a prior recording (card ybcxJgOz).
//
// A "recording" is a session: a SQLite row (src/db.mjs) plus its on-disk
// media (the sessionDir from src/store.mjs — jsonl lanes + session.webm).
// This file pins the delete capability at the service/HTTP layer, where the
// "the stored media is actually deleted" and "gone after a refresh" acceptance
// criteria live, plus the UI affordance contract (delete button + confirm
// dialog) that the admin list and the replay page must ship.
//
// Baseline: none of these pass yet. The DELETE route, the row's delete control,
// and the confirm dialog all 404 / do not exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.mjs';
import { sessionDir } from '../src/store.mjs';
import { openDb } from '../src/db.mjs';
import { replayPage } from '../src/adminui.mjs';

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

// Create a real, ended recording (lanes + a video file on disk) and return its id.
const seedRecording = async (base) => {
  await fetch(`${base}/api/admin/campaigns`, { method: 'POST', headers: admin, body: JSON.stringify(campaign) });
  const { sessionId } = await (await fetch(`${base}/api/session/start`, {
    method: 'POST', body: JSON.stringify({ slug: 'wake-test', consent: true }) })).json();
  await fetch(`${base}/api/s/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({ events: [
      { lane: 'transcript', t: 900, text: 'a sentence' },
      { lane: 'clicks', t: 400, n: 1, x: 1, y: 2 },
    ] }) });
  await fetch(`${base}/api/s/${sessionId}/video?seq=0&t=0`, {
    method: 'POST', body: Buffer.from('fake-webm-bytes') });
  await fetch(`${base}/api/s/${sessionId}/end`, { method: 'POST' });
  return sessionId;
};

const dir = (dataDir, sessionId) => sessionDir(dataDir, 'wake-test', sessionId);

// --- Service / storage layer ------------------------------------------------

test('DELETE /api/admin/sessions/:id requires admin auth', () => withApp(async (base, dataDir) => {
  const sid = await seedRecording(base);
  const res = await fetch(`${base}/api/admin/sessions/${sid}`, { method: 'DELETE' });
  assert.equal(res.status, 401, 'unauthenticated delete is rejected');
  // And nothing was touched: the recording is still retrievable.
  assert.equal((await fetch(`${base}/api/admin/sessions/${sid}`, { headers: admin })).status, 200);
  assert.ok(fs.existsSync(path.join(dir(dataDir, sid), 'session.webm')));
  // The gate is real (not a missing route): with the admin credential the same
  // request is a success and actually removes the recording.
  const ok = await fetch(`${base}/api/admin/sessions/${sid}`, { method: 'DELETE', headers: admin });
  assert.equal(ok.status, 200, 'authenticated delete succeeds');
  assert.equal((await fetch(`${base}/api/admin/sessions/${sid}`, { headers: admin })).status, 404, 'gone after the authenticated delete');
}));

test('deleting a recording removes the row and its stored media, and it is gone after a refresh', () => withApp(async (base, dataDir) => {
  const sid = await seedRecording(base);
  const before = await (await fetch(`${base}/api/admin/campaigns/wake-test/sessions`, { headers: admin })).json();
  assert.equal(before.length, 1);

  const del = await fetch(`${base}/api/admin/sessions/${sid}`, { method: 'DELETE', headers: admin });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).ok, true);

  // The record is gone from the list and a fresh GET (a page refresh) 404s.
  const after = await (await fetch(`${base}/api/admin/campaigns/wake-test/sessions`, { headers: admin })).json();
  assert.equal(after.length, 0, 'no rows remain after deleting the only recording');
  assert.equal((await fetch(`${base}/api/admin/sessions/${sid}`, { headers: admin })).status, 404, 'not retrievable after a refresh');

  // The stored media/asset is actually removed at the storage layer.
  assert.ok(!fs.existsSync(dir(dataDir, sid)), 'session directory (lanes + media) is deleted');
  assert.ok(!fs.existsSync(path.join(dir(dataDir, sid), 'session.webm')), 'the recorded video is deleted');

  // The DB row is gone, not merely hidden.
  const db = openDb(dataDir);
  assert.equal(db.getSession(sid), null);
  db.raw.close();
}));

test('deleting is idempotent-safe and reports success on the first call', () => withApp(async (base) => {
  const sid = await seedRecording(base);
  assert.equal((await fetch(`${base}/api/admin/sessions/${sid}`, { method: 'DELETE', headers: admin })).status, 200);
  // A second delete of the now-gone recording is a 404, not an error that
  // corrupts anything — the rest of the data is untouched.
  assert.equal((await fetch(`${base}/api/admin/sessions/${sid}`, { method: 'DELETE', headers: admin })).status, 404);
}));

test('deleting the last remaining recording leaves an empty list', () => withApp(async (base) => {
  const sid = await seedRecording(base);
  await fetch(`${base}/api/admin/sessions/${sid}`, { method: 'DELETE', headers: admin });
  const rows = await (await fetch(`${base}/api/admin/campaigns/wake-test/sessions`, { headers: admin })).json();
  assert.deepEqual(rows, [], 'the campaign has no recordings left -> the empty state renders');
}));

test('a recording you cannot address is rejected and nothing changes', () => withApp(async (base, dataDir) => {
  const sid = await seedRecording(base);
  // The delete route must actually exist: deleting your own recording succeeds.
  // (Pins the new DELETE route — a missing route would return 404 here.)
  assert.equal((await fetch(`${base}/api/admin/sessions/${sid}`, { method: 'DELETE', headers: admin })).status, 200,
    'the delete route exists and accepts the owner\'s own recording');
  // Re-seed, then try a foreign/unknown id. Unknown ids are indistinguishable from
  // recordings you do not own, so that delete is rejected without touching anything.
  const sid2 = await seedRecording(base);
  const other = 'f'.repeat(16);
  const res = await fetch(`${base}/api/admin/sessions/${other}`, { method: 'DELETE', headers: admin });
  assert.ok([403, 404].includes(res.status), 'unknown/foreign recording is forbidden or not-found');
  assert.equal((await fetch(`${base}/api/admin/sessions/${sid2}`, { headers: admin })).status, 200, 'the real recording is untouched');
  assert.ok(fs.existsSync(path.join(dir(dataDir, sid2), 'session.webm')), 'the real recording\'s media is untouched');
  const rows = await (await fetch(`${base}/api/admin/campaigns/wake-test/sessions`, { headers: admin })).json();
  assert.equal(rows.length, 1, 'list length unchanged after a rejected delete');
}));

// --- UI contract ------------------------------------------------------------

test('the sessions list ships a delete affordance and a confirm dialog', () => withApp(async (base) => {
  const page = await (await fetch(base + '/admin', { headers: admin })).text();
  // A per-row, accessible delete control in the row's action area, next to replay.
  assert.match(page, /aria-label="Delete recording"/, 'row carries an accessible "Delete recording" control');
  // Deletion is irreversible, so the UI must gate it behind a confirm dialog.
  assert.match(page, /Delete this recording\?/);
  assert.match(page, /can't be undone|cannot be undone/i);
  assert.match(page, /Cancel/);
}));

test('the replay page exposes a delete control for the recording being played', () => {
  const page = replayPage('ab12cd34ef56ab78');
  assert.match(page, /aria-label="Delete recording"/, 'the detail view can delete its recording');
  assert.match(page, /Delete this recording\?/);
});
