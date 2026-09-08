import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { replayPage } from '../src/adminui.mjs';
import { laneFor, posPct, LANE_CONFIG } from '../src/replay-lanes.mjs';

const SID = 'ab12cd34ef56ab78';
const page = replayPage(SID);

test('replay page renders the lane strip with labels in order', () => {
  assert.match(page, /id="strip"/);
  assert.match(page, /id="lanebody"/);
  const at = (label) => page.indexOf(`<span class="lanelabel">${label}</span>`);
  const order = ['clicks', 'keys', 'wheel', 'dwell', 'ogd'].map(at);
  for (const i of order) assert.ok(i > -1, 'every lane label is rendered');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'labels appear top-to-bottom in lane order');
});

test('each lane has its own track element and a playhead', () => {
  for (const lane of LANE_CONFIG) assert.match(page, new RegExp(`id="track-${lane.id}"`));
  assert.match(page, /id="ph"/);
});

test('lanes come from one config array, not a per-lane branch chain', () => {
  assert.match(page, /const LANE_CONFIG=\[\{id:"/);
  for (const lane of LANE_CONFIG) assert.ok(page.includes(`id:"${lane.id}"`), `${lane.id} is in the config literal`);
  // the strip builder itself never names a lane — it only walks the config.
  // ('clicks' is still branched on outside it, for the pre-existing video overlay.)
  const buildStrip = page.slice(page.indexOf('function buildStrip()'), page.indexOf('const now=()=>'));
  assert.ok(buildStrip.length > 100, 'found the buildStrip source');
  for (const id of LANE_CONFIG.map((l) => l.id)) {
    assert.ok(!buildStrip.includes(`'${id}'`) && !buildStrip.includes(`"${id}"`), `buildStrip does not name ${id}`);
  }
  // and no per-lane if-chain drives layout anywhere in the page or the module
  const src = page + fs.readFileSync(new URL('../src/adminui.mjs', import.meta.url), 'utf8');
  for (const id of ['keys', 'wheel', 'dwell', 'ogd']) {
    assert.doesNotMatch(src, new RegExp(`if\\s*\\(\\s*[\\w.]*lane\\s*===?\\s*['"]${id}['"]`, 'i'));
  }
});

test('markers are positioned by percentage and built in one write per lane', () => {
  assert.match(page, /left:'\+left\.toFixed/);
  assert.match(page, /\$\('#track-'\+l\.id\)\.innerHTML=/);
});

test('scrubbing and lane clicks both seek', () => {
  assert.match(page, /\$\('#scrub'\)\.addEventListener\('input'/);
  assert.match(page, /\$\('#strip'\)\.addEventListener\('click'/);
  assert.match(page, /const seek=\(t\)=>/);
  assert.match(page, /#ph'\)\.style\.left=/); // playhead follows render()
});

test('existing replay affordances survive', () => {
  assert.match(page, /<video id="v">/);
  assert.match(page, /id="scrub" type="range"/);
  assert.match(page, /<h2>Timeline<\/h2><div class="pane" id="lanes">/); // transcript / event pane
  assert.match(page, /m\.className='mark'/);                             // click overlay on video
  assert.ok(page.includes(SID));
  assert.match(page, /e\.lane==='input'&&e\.kind==='move'\)continue/);   // move still skipped
});

test('laneFor maps events to lanes', () => {
  assert.equal(laneFor({ lane: 'clicks', t: 10, n: 1, x: 2, y: 3 }), 'clicks');
  assert.equal(laneFor({ lane: 'input', kind: 'key' }), 'keys');
  assert.equal(laneFor({ lane: 'input', kind: 'wheel' }), 'wheel');
  assert.equal(laneFor({ lane: 'input', kind: 'dwell' }), 'dwell');
  assert.equal(laneFor({ lane: 'input', kind: 'move' }), null);
  assert.equal(laneFor({ lane: 'ogd', t: 5 }), 'ogd');
  assert.equal(laneFor({ lane: 'ogd' }), null);
  assert.equal(laneFor({ lane: 'ogd', t: 'nope' }), null);
  assert.equal(laneFor({ lane: 'transcript', t: 1, text: 'hi' }), 'speech');
  assert.equal(laneFor({ lane: 'transcript', t: 1, text: 'hi', typed: true }), 'typed');
  assert.equal(laneFor({ lane: 'marks', t: 1, kind: 'video-start' }), null);
  assert.equal(laneFor(null), null);
});

test('posPct clamps to 0..100', () => {
  assert.equal(posPct(0, 1000), 0);
  assert.equal(posPct(500, 1000), 50);
  assert.equal(posPct(2000, 1000), 100);
  assert.equal(posPct(-500, 1000), 0);
  assert.equal(posPct(500, 0), 0);
  assert.equal(posPct(NaN, 1000), 0);
});
