import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// The jsonl half of the export contract (frames need ffmpeg + a video and
// are validated in the container; see tasks/decisions.md S2/M7 notes).
test('export-playtester emits the parent repo layout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-exp-'));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    sessionId: 'x', campaign: 'wake-test', url: 'https://example.com/g/',
    game: { w: 1280, h: 800 }, serverStartedAt: '2026-08-26T00:00:00Z',
  }));
  fs.writeFileSync(path.join(dir, 'clicks.jsonl'),
    '{"n":1,"t":1200,"x":10,"y":20}\n{"n":2,"t":3400,"x":30,"y":40}\n');
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '{"t":900,"text":"hm","typed":true}\n');
  fs.writeFileSync(path.join(dir, 'input.jsonl'), '{"t":500,"kind":"move","x":1,"y":2}\n');
  fs.writeFileSync(path.join(dir, 'marks.jsonl'), '{"t":0,"kind":"start"}\n');

  execFileSync('node', ['scripts/export-playtester.mjs', dir]);
  const out = path.join(dir, 'export');
  const session = JSON.parse(fs.readFileSync(path.join(out, 'session.json'), 'utf8'));
  assert.equal(session.game.w, 1280);
  assert.equal(session.label, 'wake-test');
  const clicks = fs.readFileSync(path.join(out, 'clicks.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(clicks.length, 2);
  assert.ok(clicks.every((c) => 'beforeAgeMs' in c && 'n' in c && 'x' in c));
  const tx = JSON.parse(fs.readFileSync(path.join(out, 'transcript.jsonl'), 'utf8').trim());
  assert.deepEqual(tx, { t: 900, text: 'hm' });
  assert.ok(fs.existsSync(path.join(out, 'frames')));
  fs.rmSync(dir, { recursive: true, force: true });
});
