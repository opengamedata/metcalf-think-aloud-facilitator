import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/db.mjs';
import { applyCode } from '../src/codebook.mjs';
import { createServer } from '../src/server.mjs';
import { replayPage } from '../src/adminui.mjs';
import { laneFor, LANE_CONFIG } from '../src/replay-lanes.mjs';

const PW = 'test-secret';
const admin = { authorization: `Bearer ${PW}`, 'content-type': 'application/json' };
const campaign = {
  slug: 'wake-test', name: 'Wake test', gameUrl: 'https://example.com/game/',
  instructionsMd: 'Play.', consentMd: 'OK?', thankyouMd: 'Thanks!',
};

// Like api.test.mjs's withApp, but hands back a `restart` so a test can prove a
// code survives the process that wrote it, not just the request that wrote it.
const withApp = async (fn) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-codes-'));
  let server = null;
  const start = async () => {
    server = createServer({ dataDir, adminPassword: PW });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise((r) => server.close(r));
  try {
    await fn({ dataDir, base: await start(), restart: async () => { await stop(); return start(); } });
  } finally { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
};

const get = (base, p) => fetch(base + p, { headers: admin }).then(async (r) => [r.status, await r.json()]);
const post = (base, p, b) => fetch(base + p, { method: 'POST', headers: admin, body: JSON.stringify(b) })
  .then(async (r) => [r.status, await r.json()]);

// A campaign with one ended session carrying a couple of recorded events.
const seed = async (base) => {
  await post(base, '/api/admin/campaigns', campaign);
  const [, { sessionId }] = await post(base, '/api/session/start', { slug: 'wake-test', consent: true });
  await post(base, `/api/s/${sessionId}/events`, { events: [
    { lane: 'clicks', t: 400, n: 1, x: 1, y: 2 },
    { lane: 'transcript', t: 900, text: 'hm' },
    { lane: 'ogd', t: 1800, url: 'https://example.com/x', bytes: 12 },
    { lane: 'transcript', t: 6000, text: 'oh I see' },
  ] });
  await post(base, `/api/s/${sessionId}/end`, {});
  return sessionId;
};

test('a point code persists and reloads with the session', () => withApp(async ({ base, restart }) => {
  const sid = await seed(base);
  const [status, out] = await post(base, `/api/admin/sessions/${sid}/codes`, { code: 'confusion', tStart: 1200 });
  assert.equal(status, 200);
  assert.equal(out.application.tStart, 1200);
  assert.equal(out.application.tEnd, null);

  const fresh = await restart();
  const [, codes] = await get(fresh, `/api/admin/sessions/${sid}/codes`);
  assert.equal(codes.length, 1);
  assert.equal(codes[0].code, 'confusion');
  assert.equal(codes[0].tStart, 1200);
  assert.equal(codes[0].tEnd, null, 'a point code has no end');
  assert.equal(codes[0].slug, 'wake-test', 'the application records its campaign');
}));

test('a region code persists both start and end', () => withApp(async ({ base, restart }) => {
  const sid = await seed(base);
  const [status] = await post(base, `/api/admin/sessions/${sid}/codes`,
    { code: 'stuck on the helm', tStart: 1200, tEnd: 4800 });
  assert.equal(status, 200);

  const fresh = await restart();
  const [, codes] = await get(fresh, `/api/admin/sessions/${sid}/codes`);
  assert.equal(codes.length, 1);
  assert.equal(codes[0].tStart, 1200);
  assert.equal(codes[0].tEnd, 4800);
}));

test('inline creation of an unseen code applies it AND adds it to the codebook', () =>
  withApp(async ({ base }) => {
    const sid = await seed(base);
    assert.deepEqual((await get(base, '/api/admin/campaigns/wake-test/codebook'))[1], [],
      'the campaign starts with an empty codebook');

    // typed inline, never seen before: one call both applies and mints it
    const [, first] = await post(base, `/api/admin/sessions/${sid}/codes`,
      { code: 'Spatial Reasoning', tStart: 1200 });
    assert.equal(first.created, true);
    assert.equal(first.application.code, 'Spatial Reasoning');

    const [, book] = await get(base, '/api/admin/campaigns/wake-test/codebook');
    assert.deepEqual(book.map((e) => e.code), ['Spatial Reasoning']);
    assert.equal(book[0].description, '', 'minted blank, fillable later');

    // picking that same code again reuses the entry rather than duplicating it
    const [, second] = await post(base, `/api/admin/sessions/${sid}/codes`,
      { code: 'spatial reasoning', tStart: 3000, tEnd: 3500 });
    assert.equal(second.created, false);
    assert.equal(second.application.code, 'Spatial Reasoning', 'casing of first use wins');
    assert.equal((await get(base, '/api/admin/campaigns/wake-test/codebook'))[1].length, 1);
    assert.equal((await get(base, `/api/admin/sessions/${sid}/codes`))[1].length, 2);
  }));

test('codes come back on the timeline alongside the recorded event lanes', () =>
  withApp(async ({ base, restart }) => {
    const sid = await seed(base);
    await post(base, `/api/admin/sessions/${sid}/codes`, { code: 'confusion', tStart: 1200 });
    await post(base, `/api/admin/sessions/${sid}/codes`, { code: 'delight', tStart: 5000, tEnd: 5800 });

    const fresh = await restart();
    const [, tl] = await get(fresh, `/api/admin/sessions/${sid}/timeline`);
    const ts = tl.events.map((e) => e.t);
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'codes merge into the t-sorted list');
    for (const lane of ['clicks', 'transcript', 'ogd', 'codes'])
      assert.ok(tl.events.some((e) => e.lane === lane), `${lane} events are present`);

    const codes = tl.events.filter((e) => e.lane === 'codes');
    assert.deepEqual(codes.map((e) => [e.code, e.t, e.ms]), [['confusion', 1200, 0], ['delight', 5000, 800]]);
    // and they are drawn by the same lane machinery as everything else
    for (const e of codes) assert.equal(laneFor(e), 'codes');
  }));

test('the codes lane renders in the replay strip beside the existing lanes', () => {
  const page = replayPage('ab12cd34ef56ab78');
  assert.match(page, /<span class="lanelabel">codes<\/span>/);
  assert.match(page, /id="track-codes"/);
  assert.ok(LANE_CONFIG.some((l) => l.id === 'codes'), 'codes is a LANE_CONFIG entry');
  assert.ok(page.includes('id:"codes"'), 'the client shares the same config entry');
  // point vs region is a per-event shape on one lane, not two lanes
  assert.match(page, /const shape=l\.shapeFor\?l\.shapeFor\(e\):l\.shape/);
  const codes = LANE_CONFIG.find((l) => l.id === 'codes');
  assert.equal(codes.shapeFor({ ms: 0 }), 'dot');
  assert.equal(codes.shapeFor({ ms: 800 }), 'bar');
  assert.equal(codes.titleFor({ code: 'confusion' }), 'confusion');
  // the recorded lanes keep their tracks
  for (const id of ['clicks', 'keys', 'wheel', 'dwell', 'ogd'])
    assert.match(page, new RegExp(`id="track-${id}"`));
});

test('the replay page offers codebook picking with inline creation', () => {
  const page = replayPage('ab12cd34ef56ab78');
  // one input backed by the campaign's codebook — picking and typing new are the same gesture
  assert.match(page, /<input id="codeinput" list="codelist"/);
  assert.match(page, /<datalist id="codelist">/);
  assert.match(page, /campaigns\/'\+data\.session\.slug\+'\/codebook/);
  assert.match(page, /\$\('#codelist'\)\.innerHTML=/);
  // point and region both POST to the session's codes route
  assert.match(page, /'\/api\/admin\/sessions\/'\+SID\+'\/codes'/);
  assert.match(page, /\$\('#codepoint'\)\.onclick=\(\)=>postCode\(Math\.round\(now\(\)\),null\)/);
  assert.match(page, /regionStart=Math\.round\(now\(\)\)/);
  assert.match(page, /postCode\(Math\.min\(a,b\),Math\.max\(a,b\)\)/);
  // a freshly created code joins the picker without a reload
  assert.match(page, /if\(out\.created\)loadCodebook\(\)/);
  // clicking the controls must not be read as a scrub on the strip
  assert.match(page, /if\(ev\.target\.closest\('#codebar'\)\)return/);
});

test('applying a code rejects blank codes and impossible spans', () => withApp(async ({ base }) => {
  const sid = await seed(base);
  for (const bad of [{ code: '   ', tStart: 10 }, { code: 'c' }, { code: 'c', tStart: -5 },
    { code: 'c', tStart: 500, tEnd: 100 }]) {
    const [status, out] = await post(base, `/api/admin/sessions/${sid}/codes`, bad);
    assert.equal(status, 400, `${JSON.stringify(bad)} should be refused`);
    assert.ok(out.error, 'the refusal explains itself');
  }
  assert.deepEqual((await get(base, `/api/admin/sessions/${sid}/codes`))[1], []);
  assert.deepEqual((await get(base, '/api/admin/campaigns/wake-test/codebook'))[1], []);
}));

test('the codes routes need admin auth and a real session', () => withApp(async ({ base }) => {
  const sid = await seed(base);
  const noAuth = await fetch(`${base}/api/admin/sessions/${sid}/codes`,
    { method: 'POST', body: JSON.stringify({ code: 'confusion', tStart: 1 }) });
  assert.equal(noAuth.status, 401);
  assert.equal((await fetch(`${base}/api/admin/campaigns/wake-test/codebook`)).status, 401);

  const [status] = await post(base, '/api/admin/sessions/0000000000000000/codes', { code: 'c', tStart: 1 });
  assert.equal(status, 404);
  assert.deepEqual((await get(base, `/api/admin/sessions/${sid}/codes`))[1], []);
}));

const bookPath = '/api/admin/campaigns/wake-test/codebook';
const changeCode = (base, code, fields, method = 'PATCH') => fetch(
  base + bookPath + '/' + encodeURIComponent(code),
  { method, headers: admin, body: method === 'DELETE' ? undefined : JSON.stringify(fields) }
).then(async (r) => [r.status, await r.json()]);

test('codebook field edits persist across restart and partial edits preserve other fields', () =>
  withApp(async ({ base, restart }) => {
    const sid = await seed(base);
    await post(base, `/api/admin/sessions/${sid}/codes`, { code: 'why / what? #困惑', tStart: 20 });
    const fields = { description: 'Cannot find the goal', positive_example: '<wait> "what?"', negative_example: 'I know what to do' };
    assert.equal((await changeCode(base, 'why / what? #困惑', fields))[0], 200);
    assert.equal((await changeCode(base, 'why / what? #困惑', { description: 'Changed' }))[0], 200);
    const [, book] = await get(await restart(), bookPath);
    assert.equal(book[0].description, 'Changed');
    assert.equal(book[0].positive_example, fields.positive_example);
    assert.equal(book[0].negative_example, fields.negative_example);
  }));

test('codebook rename updates all existing timelines, retains identities and reuses the new label', () =>
  withApp(async ({ base, restart }) => {
    const sid = await seed(base);
    const [, { sessionId: second }] = await post(base, '/api/session/start', { slug: campaign.slug, consent: true });
    for (const id of [sid, second])
      await post(base, `/api/admin/sessions/${id}/codes`, { code: 'confusion', tStart: 20, tEnd: 80 });
    const [, before] = await get(base, `/api/admin/sessions/${sid}/codes`);
    assert.equal((await changeCode(base, 'confusion', { code: '  New / Label?  ' }))[0], 200);
    base = await restart();
    for (const id of [sid, second]) {
      const [, timeline] = await get(base, `/api/admin/sessions/${id}/timeline`);
      const code = timeline.events.find(e => e.lane === 'codes');
      assert.equal(code.code, 'New / Label?');
      assert.equal(code.codeKey, 'new / label?');
      assert.equal(code.t, 20);
      assert.equal(code.ms, 60);
      if (id === sid) assert.equal(code.id, before[0].id);
    }
    const [, reused] = await post(base, `/api/admin/sessions/${sid}/codes`, { code: 'NEW / LABEL?', tStart: 30 });
    assert.equal(reused.created, false);
    assert.equal((await get(base, bookPath))[1][0].usageCount, 3);
    assert.equal((await changeCode(base, 'new / label?', { code: 'NEW / LABEL?' }))[0], 200);
    assert.equal((await get(base, `/api/admin/sessions/${sid}/codes`))[1][0].code, 'NEW / LABEL?');
  }));

test('codebook usage counts include zero and deletion blocks used codes but removes unused ones', () =>
  withApp(async ({ base, restart, dataDir }) => {
    const sid = await seed(base);
    await post(base, `/api/admin/sessions/${sid}/codes`, { code: 'used', tStart: 20 });
    const db = openDb(dataDir);
    applyCode(db, campaign.slug, 'unused');
    db.raw.close();
    const [, book] = await get(base, bookPath);
    assert.deepEqual(book.map(e => [e.code, e.usageCount]), [['unused', 0], ['used', 1]]);
    const [status, out] = await changeCode(base, 'used', null, 'DELETE');
    assert.equal(status, 409);
    assert.match(out.error, /applied/i);
    assert.equal((await changeCode(base, 'unused', null, 'DELETE'))[0], 200);
    base = await restart();
    assert.deepEqual((await get(base, bookPath))[1].map(e => e.code), ['used']);
    assert.equal((await get(base, `/api/admin/sessions/${sid}/codes`))[1].length, 1);
  }));

test('codebook mutations validate labels and fields, reject collisions, and stay campaign scoped', () =>
  withApp(async ({ base, dataDir }) => {
    const sid = await seed(base);
    for (const code of ['one', 'two']) await post(base, `/api/admin/sessions/${sid}/codes`, { code, tStart: 20 });
    await post(base, '/api/admin/campaigns', { ...campaign, slug: 'other-study' });
    const db = openDb(dataDir);
    applyCode(db, 'other-study', 'one');
    db.raw.close();
    for (const fields of [{ code: ' ' }, { code: 3 }, { description: null }, { positive_example: [] }, { negative_example: 1 }, null])
      assert.equal((await changeCode(base, 'one', fields))[0], 400);
    assert.equal((await changeCode(base, 'one', { code: ' TWO ', description: 'must not save' }))[0], 409);
    assert.equal((await get(base, bookPath))[1][0].description, '');
    assert.equal((await changeCode(base, 'missing', { code: 'x' }))[0], 404);
    assert.equal((await changeCode(base, 'one', { code: 'renamed' }))[0], 200);
    assert.equal((await get(base, '/api/admin/campaigns/other-study/codebook'))[1][0].code, 'one');
    for (const method of ['PATCH', 'DELETE']) {
      assert.equal((await fetch(base + bookPath + '/two', { method, body: '{}' })).status, 401);
      assert.equal((await fetch(base + '/api/admin/campaigns/missing/codebook/two', { method, headers: admin, body: '{}' })).status, 404);
    }
  }));

test('campaign admin provides an inline codebook table with usage and save feedback', () =>
  withApp(async ({ base }) => {
    const page = await (await fetch(base + '/admin')).text();
    assert.match(page, /id="codebook"/);
    for (const label of ['Code', 'Description', 'Positive example', 'Negative example', 'Usage'])
      assert.ok(page.includes('<th>' + label + '</th>'));
    assert.match(page, /loadCampaignCodebook\(slug\)/);
    assert.match(page, /encodeURIComponent\(entry.codeKey\)/);
    assert.match(page, /0 · unused/);
    assert.match(page, /role="status"/);
    assert.match(page, /method:'PATCH'/);
  }));
