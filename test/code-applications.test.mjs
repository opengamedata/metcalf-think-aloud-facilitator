import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/db.mjs';
import { applyCodeAt, normalizeApplication, isRegion, toTimelineEvent } from '../src/code-applications.mjs';

const withDb = (fn) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-codeapp-'));
  try { fn(openDb(dataDir)); } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
};
const at = (extra) => ({ slug: 'wake-test', sessionId: 'ab12cd34ef56ab78', ...extra });

test('normalizeApplication distinguishes a point from a region', () => {
  assert.deepEqual(normalizeApplication({ code: 'confusion', tStart: 1200 }),
    { code: 'confusion', tStart: 1200, tEnd: null });
  assert.deepEqual(normalizeApplication({ code: 'confusion', tStart: 1200, tEnd: null }),
    { code: 'confusion', tStart: 1200, tEnd: null });
  assert.deepEqual(normalizeApplication({ code: '  confusion  ', tStart: 1200.4, tEnd: 4800.6 }),
    { code: 'confusion', tStart: 1200, tEnd: 4801 });
  assert.equal(isRegion(normalizeApplication({ code: 'c', tStart: 0 })), false);
  assert.equal(isRegion(normalizeApplication({ code: 'c', tStart: 0, tEnd: 5 })), true);
});

test('normalizeApplication rejects bad codes and bad timestamps', () => {
  const bad = (input, code) => assert.throws(() => normalizeApplication(input),
    (err) => err.code === code, `${JSON.stringify(input)} should raise ${code}`);

  for (const c of ['', '   ', null, undefined, 42]) bad({ code: c, tStart: 0 }, 'INVALID_CODE');
  for (const t of [undefined, null, NaN, Infinity, '1200', {}]) bad({ code: 'c', tStart: t }, 'INVALID_TIME');
  bad({ code: 'c', tStart: -1 }, 'INVALID_TIME');
  bad({ code: 'c', tStart: 100, tEnd: 99 }, 'INVALID_TIME');
  bad({ code: 'c', tStart: 100, tEnd: 'later' }, 'INVALID_TIME');
  // a zero-length region is still a region, not an error
  assert.deepEqual(normalizeApplication({ code: 'c', tStart: 100, tEnd: 100 }),
    { code: 'c', tStart: 100, tEnd: 100 });
});

test('applyCodeAt stores a point application with a null tEnd', () => withDb((db) => {
  const { application, created } = applyCodeAt(db, at({ code: 'confusion', tStart: 1200 }));
  assert.equal(created, true);
  assert.equal(application.code, 'confusion');
  assert.equal(application.codeKey, 'confusion');
  assert.equal(application.slug, 'wake-test');
  assert.equal(application.sessionId, 'ab12cd34ef56ab78');
  assert.equal(application.tStart, 1200);
  assert.equal(application.tEnd, null);
  assert.equal(isRegion(application), false);
}));

test('applyCodeAt stores a region application with both bounds', () => withDb((db) => {
  const { application } = applyCodeAt(db, at({ code: 'confusion', tStart: 1200, tEnd: 4800 }));
  assert.equal(application.tStart, 1200);
  assert.equal(application.tEnd, 4800);
  assert.equal(isRegion(application), true);
}));

test('applying an unseen code mints it in the campaign codebook; reapplying reuses it', () => withDb((db) => {
  const first = applyCodeAt(db, at({ code: 'Spatial Reasoning', tStart: 100 }));
  assert.equal(first.created, true);
  assert.deepEqual(db.listCodebook('wake-test').map((e) => e.code), ['Spatial Reasoning']);

  const second = applyCodeAt(db, at({ code: '  spatial reasoning  ', tStart: 900, tEnd: 1500 }));
  assert.equal(second.created, false);
  assert.equal(db.listCodebook('wake-test').length, 1, 'no duplicate codebook entry');
  // the application records the codebook's label — the casing of first use
  assert.equal(second.application.code, 'Spatial Reasoning');
  assert.equal(second.application.codeKey, 'spatial reasoning');
  assert.equal(db.listCodeApplications('ab12cd34ef56ab78').length, 2);
}));

test('a rejected application stores neither an application nor a codebook entry', () => withDb((db) => {
  assert.throws(() => applyCodeAt(db, at({ code: '   ', tStart: 100 })), (e) => e.code === 'INVALID_CODE');
  assert.throws(() => applyCodeAt(db, at({ code: 'never-stored', tStart: 500, tEnd: 100 })),
    (e) => e.code === 'INVALID_TIME');
  assert.deepEqual(db.listCodebook('wake-test'), []);
  assert.deepEqual(db.listCodeApplications('ab12cd34ef56ab78'), []);
}));

test('applications list in time order and stay scoped to their session', () => withDb((db) => {
  applyCodeAt(db, at({ code: 'late', tStart: 9000 }));
  applyCodeAt(db, at({ code: 'early', tStart: 100 }));
  applyCodeAt(db, at({ sessionId: '00112233445566ff', code: 'elsewhere', tStart: 50 }));

  assert.deepEqual(db.listCodeApplications('ab12cd34ef56ab78').map((a) => a.code), ['early', 'late']);
  assert.deepEqual(db.listCodeApplications('00112233445566ff').map((a) => a.code), ['elsewhere']);
  // the codebook is per campaign, so all three strings live in it
  assert.equal(db.listCodebook('wake-test').length, 3);
}));

test('deleting a campaign clears its code applications', () => withDb((db) => {
  db.putCampaign({ slug: 'wake-test', name: 'Wake', gameUrl: 'https://example.com/g/' });
  applyCodeAt(db, at({ code: 'confusion', tStart: 10 }));
  applyCodeAt(db, at({ slug: 'other-study', sessionId: '00112233445566ff', code: 'confusion', tStart: 10 }));

  db.deleteCampaign('wake-test');
  assert.deepEqual(db.listCodeApplications('ab12cd34ef56ab78'), []);
  assert.equal(db.listCodeApplications('00112233445566ff').length, 1);
}));

test('toTimelineEvent turns an application into a codes-lane event', () => {
  assert.deepEqual(toTimelineEvent({ id: 1, code: 'confusion', tStart: 1200, tEnd: null }),
    { id: 1, code: 'confusion', tStart: 1200, tEnd: null, lane: 'codes', t: 1200, ms: 0 });
  assert.deepEqual(toTimelineEvent({ id: 2, code: 'confusion', tStart: 1200, tEnd: 4800 }),
    { id: 2, code: 'confusion', tStart: 1200, tEnd: 4800, lane: 'codes', t: 1200, ms: 3600 });
});
