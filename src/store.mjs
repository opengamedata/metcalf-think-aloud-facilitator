// Session directories (CONTRACTS.md §4): append-only jsonl lanes plus video
// chunks. Everything here is crash-safe by construction — a partial session
// is a valid session.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LANES = ['clicks', 'input', 'transcript', 'ogd', 'checklist', 'marks'];

export function sessionDir(dataDir, slug, sessionId) {
  return path.join(dataDir, 'sessions', slug, sessionId);
}

export function createSession(dataDir, slug, sessionId, meta) {
  const dir = sessionDir(dataDir, slug, sessionId);
  fs.mkdirSync(path.join(dir, 'video'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(meta, null, 2));
  for (const lane of LANES) fs.writeFileSync(path.join(dir, `${lane}.jsonl`), '');
  appendEvents(dir, [{ lane: 'marks', t: 0, kind: 'start' }]);
  return dir;
}

export function appendEvents(dir, events) {
  let n = 0;
  for (const ev of events) {
    const { lane, ...record } = ev ?? {};
    if (!LANES.includes(lane) || typeof record.t !== 'number') continue;
    fs.appendFileSync(path.join(dir, `${lane}.jsonl`), JSON.stringify(record) + '\n');
    n++;
  }
  return n;
}

export function writeChunk(dir, seq, buf) {
  const name = `chunk-${String(Math.max(0, seq | 0)).padStart(5, '0')}.webm`;
  fs.writeFileSync(path.join(dir, 'video', name), buf);
}

export function readLane(dir, lane) {
  try {
    return fs.readFileSync(path.join(dir, `${lane}.jsonl`), 'utf8').split('\n')
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Merge = byte concat, then ffmpeg -c copy remux to restore duration/cues
// (spike S2 finding: streamed webm has neither, and the replay slider needs
// both). Without ffmpeg the concat alone still plays; remux is best-effort.
export function mergeVideo(dir) {
  const vdir = path.join(dir, 'video');
  const chunks = fs.existsSync(vdir) ? fs.readdirSync(vdir).filter((f) => f.startsWith('chunk-')).sort() : [];
  if (!chunks.length) return null;
  const out = path.join(dir, 'session.webm');
  const raw = path.join(vdir, 'concat.tmp.webm');
  fs.writeFileSync(raw, Buffer.concat(chunks.map((c) => fs.readFileSync(path.join(vdir, c)))));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-c', 'copy', out]);
  if (r.status !== 0 || !fs.existsSync(out)) fs.copyFileSync(raw, out);
  fs.rmSync(raw, { force: true });
  return out;
}

export function summarize(dir) {
  const transcript = readLane(dir, 'transcript');
  const clicks = readLane(dir, 'clicks');
  const ogd = readLane(dir, 'ogd');
  const all = [...transcript, ...clicks, ...ogd, ...readLane(dir, 'input'),
    ...readLane(dir, 'checklist'), ...readLane(dir, 'marks')];
  const durationMs = all.reduce((m, e) => Math.max(m, e.t ?? 0), 0);
  return {
    durationMs,
    utterances: transcript.length,
    clicks: clicks.length,
    ogdLogs: ogd.length,
    playerCode: ogd.map((e) => e.playerCode).find(Boolean) ?? null,
  };
}
