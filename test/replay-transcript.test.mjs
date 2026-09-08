import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayPage } from '../src/adminui.mjs';
import {
  LANE_CONFIG, laneFor, isTypedUtterance, transcriptEntries, activeUtteranceIndex,
  effectiveDurationMs, isTextEntry, nextEventTime, replayHelpersSource, SHORTCUTS, SPEEDS,
} from '../src/replay-lanes.mjs';

const page = replayPage('ab12cd34ef56ab78');

// --- problem 1: transcript + checklist lanes -------------------------------

test('transcript speech and typed are separate lanes, checklist has one too', () => {
  const ids = LANE_CONFIG.map((l) => l.id);
  for (const id of ['speech', 'typed', 'checks']) assert.ok(ids.includes(id), `${id} lane exists`);
  assert.equal(laneFor({ lane: 'transcript', t: 10, text: 'hi' }), 'speech');
  assert.equal(laneFor({ lane: 'transcript', t: 10, text: 'hi', typed: true }), 'typed');
  assert.equal(laneFor({ lane: 'transcript', text: 'no time' }), null);
  assert.equal(laneFor({ lane: 'checklist', t: 5, item: 'a', checked: true }), 'checks');
  assert.equal(laneFor({ lane: 'checklist', item: 'a' }), null);
});

test('typed and spoken utterances stay distinguishable', () => {
  assert.equal(isTypedUtterance({ lane: 'transcript', t: 1, text: 'a', typed: true }), true);
  assert.equal(isTypedUtterance({ lane: 'transcript', t: 1, text: 'a' }), false);
  assert.equal(isTypedUtterance({ lane: 'clicks', t: 1, typed: true }), false);
  assert.equal(isTypedUtterance(null), false);
});

test('transcriptEntries normalizes, filters and sorts utterances', () => {
  const got = transcriptEntries([
    { lane: 'transcript', t: 300, text: 'third' },
    { lane: 'clicks', t: 1, n: 1 },
    { lane: 'transcript', t: 100, text: 'first', typed: true },
    { lane: 'transcript', t: 200, text: '   ' },
    { lane: 'transcript', text: 'no time' },
    { lane: 'transcript', t: 250, text: 'second' },
  ]);
  assert.deepEqual(got, [
    { t: 100, text: 'first', typed: true },
    { t: 250, text: 'second', typed: false },
    { t: 300, text: 'third', typed: false },
  ]);
  assert.deepEqual(transcriptEntries(undefined), []);
});

test('activeUtteranceIndex tracks the playhead', () => {
  const tx = transcriptEntries([
    { lane: 'transcript', t: 1000, text: 'a' },
    { lane: 'transcript', t: 5000, text: 'b' },
    { lane: 'transcript', t: 9000, text: 'c' },
  ]);
  assert.equal(activeUtteranceIndex(tx, 0), -1);
  assert.equal(activeUtteranceIndex(tx, 999), -1);
  assert.equal(activeUtteranceIndex(tx, 1000), 0);
  assert.equal(activeUtteranceIndex(tx, 4999), 0);
  assert.equal(activeUtteranceIndex(tx, 5000), 1);
  assert.equal(activeUtteranceIndex(tx, 999999), 2);
  assert.equal(activeUtteranceIndex(tx, NaN), -1);
  assert.equal(activeUtteranceIndex([], 10), -1);
});

test('replay page renders a transcript pane whose utterances seek', () => {
  assert.match(page, /id="tx"/);
  assert.ok(/Transcript/i.test(page), 'transcript pane is labelled');
  assert.match(page, /transcriptEntries\(/);
  assert.match(page, /activeUtteranceIndex\(/);
  assert.match(page, /u\.typed/);                               // typed styling differs
  assert.match(page, /e\.typed\?' typed'/);                     // ...and is applied per entry
  assert.match(page, /#tx'\)\.addEventListener\('click'/);      // click an utterance to seek
});

// --- problem 2: effective duration -----------------------------------------

test('effectiveDurationMs survives a null or short stored duration', () => {
  const events = [{ t: 0 }, { t: 12000 }, { t: 30000, ms: 2000 }];
  assert.equal(effectiveDurationMs({ storedMs: null, events, padMs: 1000 }), 33000);
  assert.equal(effectiveDurationMs({ storedMs: 0, events, padMs: 1000 }), 33000);
  assert.equal(effectiveDurationMs({ storedMs: 5000, events, padMs: 1000 }), 33000);
  assert.equal(effectiveDurationMs({ storedMs: 90000, events, padMs: 1000 }), 90000);
  assert.equal(effectiveDurationMs({ storedMs: null, events: [], mediaMs: 20000, offsetMs: 3000 }), 23000);
  assert.equal(effectiveDurationMs({ storedMs: null, events: [{ t: 'x' }, null] }), 1);
  assert.equal(effectiveDurationMs({}), 1);
  assert.equal(effectiveDurationMs(), 1);
});

test('replay page derives its duration instead of trusting durationMs', () => {
  assert.match(page, /effectiveDurationMs\(/);
  assert.doesNotMatch(page, /durationMs\?\?1/);
  assert.match(page, /loadedmetadata/); // media duration folded in once known
});

// --- problem 3: analyst ergonomics -----------------------------------------

test('isTextEntry only guards real text fields', () => {
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextEntry({ tagName: 'textarea' }), true);
  assert.equal(isTextEntry({ tagName: 'SELECT' }), true);
  assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(isTextEntry({ tagName: 'BUTTON' }), false);
  assert.equal(isTextEntry(null), false);
});

test('nextEventTime jumps between event times', () => {
  const times = [0, 1000, 4000, 4100, 9000];
  assert.equal(nextEventTime(times, 0, 1), 1000);
  assert.equal(nextEventTime(times, 1000, 1), 4000);
  assert.equal(nextEventTime(times, 4000, 1), 9000); // epsilon (250ms) skips near-ties
  assert.equal(nextEventTime(times, 9000, 1), null);
  assert.equal(nextEventTime(times, 4000, -1), 1000);
  assert.equal(nextEventTime(times, 0, -1), null);
  assert.equal(nextEventTime([], 5, 1), null);
  assert.equal(nextEventTime([NaN, 3000], 0, 1), 3000);
});

test('replay page ships discoverable shortcuts and a speed control', () => {
  assert.match(page, /addEventListener\('keydown'/);
  assert.match(page, /isTextEntry\(/);            // shortcuts never hijack typing
  assert.match(page, /id="speed"/);
  assert.match(page, /playbackRate/);
  assert.match(page, /id="legend"/);
  for (const s of SHORTCUTS) assert.ok(page.includes(s.label), `legend mentions ${s.label}`);
  for (const s of SPEEDS) assert.ok(page.includes(String(s) + 'x'), `speed ${s}x offered`);
  assert.match(page, /id="prevEv"/);
  assert.match(page, /id="nextEv"/);
});

test('helpers are shared with the browser rather than re-implemented', () => {
  const src = replayHelpersSource();
  for (const name of ['isTypedUtterance', 'transcriptEntries', 'activeUtteranceIndex',
    'effectiveDurationMs', 'isTextEntry', 'nextEventTime']) {
    assert.ok(src.includes('const ' + name + '='), `${name} is serialized`);
  }
  assert.ok(page.includes(src), 'the page embeds exactly that shared source');
});
