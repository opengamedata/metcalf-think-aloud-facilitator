import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/db.mjs';
import { normalizeCode, codeKey, applyCode, applyCodes } from '../src/codebook.mjs';

const withDb = (fn) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-codebook-'));
  try { fn(openDb(dataDir)); } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
};

test('normalizeCode trims and rejects blank or non-string input', () => {
  assert.equal(normalizeCode('clickable'), 'clickable');
  assert.equal(normalizeCode('  spatial reasoning  '), 'spatial reasoning');
  assert.equal(normalizeCode('Mixed Case'), 'Mixed Case');
  for (const bad of ['', '   ', '\t\n ', null, undefined, 42, {}])
    assert.equal(normalizeCode(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
});

test('codeKey is the trimmed, lowercased uniqueness key', () => {
  assert.equal(codeKey('  Clickable  '), 'clickable');
  assert.equal(codeKey('CLICKABLE'), codeKey('clickable'));
  assert.equal(codeKey('  '), null);
});

test('applying a new code string creates a codebook entry with blank fields', () => withDb((db) => {
  const { entry, created } = applyCode(db, 'wake-test', 'thinks aloud');
  assert.equal(created, true);
  assert.equal(entry.code, 'thinks aloud');
  assert.equal(entry.slug, 'wake-test');
  assert.equal(entry.description, '');
  assert.equal(entry.positive_example, '');
  assert.equal(entry.negative_example, '');
  assert.deepEqual(db.listCodebook('wake-test').map((e) => e.code), ['thinks aloud']);
}));

test('reapplying a code reuses the entry instead of duplicating it', () => withDb((db) => {
  assert.equal(applyCode(db, 'wake-test', 'confusion').created, true);

  // same string, plus the trimming and case-insensitivity variants
  for (const variant of ['confusion', '  confusion  ', 'Confusion', 'CONFUSION']) {
    const { entry, created } = applyCode(db, 'wake-test', variant);
    assert.equal(created, false, `${JSON.stringify(variant)} should have reused the entry`);
    assert.equal(entry.code, 'confusion'); // casing of first use is kept
  }
  assert.equal(db.listCodebook('wake-test').length, 1);
}));

test('reuse does not clobber a description written after first use', () => withDb((db) => {
  applyCode(db, 'wake-test', 'confusion');
  db.updateCode('wake-test', 'confusion', {
    description: 'Participant cannot tell what to do next.',
    positive_example: '"wait, what am I supposed to click?"',
    negative_example: '"this is hard but I know the goal"',
  });

  const { entry, created } = applyCode(db, 'wake-test', 'Confusion');
  assert.equal(created, false);
  assert.equal(entry.description, 'Participant cannot tell what to do next.');
  assert.match(entry.positive_example, /supposed to click/);
  assert.match(entry.negative_example, /know the goal/);
}));

test('two campaigns hold the same code string independently', () => withDb((db) => {
  const a = applyCode(db, 'wake-test', 'confusion');
  const b = applyCode(db, 'other-study', 'confusion');
  assert.equal(a.created, true);
  assert.equal(b.created, true);

  db.updateCode('wake-test', 'confusion', { description: 'wake definition' });
  assert.equal(db.getCode('wake-test', 'confusion').description, 'wake definition');
  assert.equal(db.getCode('other-study', 'confusion').description, '');
  assert.equal(db.listCodebook('wake-test').length, 1);
  assert.equal(db.listCodebook('other-study').length, 1);
}));

test('blank and whitespace-only codes are rejected and stored nowhere', () => withDb((db) => {
  for (const bad of ['', '   ', '\t', '\n  \n', null, undefined, 7]) {
    assert.throws(() => applyCode(db, 'wake-test', bad), (err) => err.code === 'INVALID_CODE',
      `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.deepEqual(db.listCodebook('wake-test'), []);
}));

test('applyCodes applies a batch in order, minting each string once', () => withDb((db) => {
  const results = applyCodes(db, 'wake-test', ['confusion', 'Confusion', 'delight']);
  assert.deepEqual(results.map((r) => r.created), [true, false, true]);
  assert.deepEqual(db.listCodebook('wake-test').map((e) => e.code), ['confusion', 'delight']);
}));

test('deleting a campaign clears its codebook but not another campaign\'s', () => withDb((db) => {
  db.putCampaign({ slug: 'wake-test', name: 'Wake', gameUrl: 'https://example.com/g/' });
  applyCode(db, 'wake-test', 'confusion');
  applyCode(db, 'other-study', 'confusion');

  db.deleteCampaign('wake-test');
  assert.deepEqual(db.listCodebook('wake-test'), []);
  assert.equal(db.listCodebook('other-study').length, 1);

  // a slug reused later starts from an empty codebook
  const again = applyCode(db, 'wake-test', 'confusion');
  assert.equal(again.created, true);
}));
