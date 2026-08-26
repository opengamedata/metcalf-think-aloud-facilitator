// Export a session to ai-playtester's runs/human/ layout (CONTRACTS.md §6),
// the exact shape evals/lib/human-session.mjs reads: session.json with
// game:{w,h}, clicks.jsonl with beforeAgeMs, input.jsonl, transcript.jsonl,
// and frames/ (cNNN-before/after + tNNNN timeline) pulled from session.webm
// by timestamp with ffmpeg.
//
//   node scripts/export-playtester.mjs <sessionDir> [--out DIR]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'session.json'))) {
  console.error('usage: node scripts/export-playtester.mjs <sessionDir> [--out DIR]');
  process.exit(1);
}
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const out = flag('out', path.join(dir, 'export'));
fs.mkdirSync(path.join(out, 'frames'), { recursive: true });

const jsonl = (f) => fs.existsSync(path.join(dir, f))
  ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
const clicks = jsonl('clicks.jsonl');
const marks = jsonl('marks.jsonl');

fs.writeFileSync(path.join(out, 'session.json'), JSON.stringify({
  url: meta.url, label: meta.campaign,
  game: meta.game ?? { w: 1280, h: 800 },
  started: meta.serverStartedAt,
  playerCode: meta.playerCode ?? null,
  source: 'metcalf-think-aloud-facilitator',
}, null, 2));

const writeLane = (name, rows) =>
  fs.writeFileSync(path.join(out, name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
writeLane('clicks.jsonl', clicks.map((c) => ({ n: c.n, t: c.t, x: c.x, y: c.y, beforeAgeMs: c.beforeAgeMs ?? 0 })));
writeLane('input.jsonl', jsonl('input.jsonl'));
writeLane('transcript.jsonl', jsonl('transcript.jsonl').map((e) => ({ t: e.t, text: e.text })));

// ---- frames from video ------------------------------------------------------
const video = path.join(dir, 'session.webm');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let frames = 0;
if (fs.existsSync(video) && hasFfmpeg) {
  const videoStart = marks.find((m) => m.kind === 'video-start')?.t ?? 0;
  const durationMs = Math.max(0, ...[...clicks, ...marks].map((e) => e.t ?? 0));
  const grab = (sessionT, file) => {
    const vt = Math.max(0, (sessionT - videoStart) / 1000);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', vt.toFixed(3), '-i', video,
      '-frames:v', '1', '-q:v', '4', path.join(out, 'frames', file)]);
    if (r.status === 0 && fs.existsSync(path.join(out, 'frames', file))) frames++;
  };
  for (const c of clicks) {
    const n = String(c.n).padStart(3, '0');
    grab(Math.max(videoStart, c.t - 50), `c${n}-before.jpg`);
    grab(c.t + 900, `c${n}-after.jpg`);
  }
  for (let s = 0; s * 1000 <= durationMs; s += 4) {
    grab(Math.max(videoStart, s * 1000), `t${String(s).padStart(4, '0')}.jpg`);
  }
} else if (!hasFfmpeg) {
  console.error('warning: ffmpeg not found — jsonl exported, frames skipped');
}

console.log(`exported -> ${out}`);
console.log(`  ${clicks.length} clicks · ${jsonl('transcript.jsonl').length} utterances · ${frames} frames`);
