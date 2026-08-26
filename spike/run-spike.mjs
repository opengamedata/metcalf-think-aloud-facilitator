// Drives spike 01+02 headlessly: starts the proxy for a game, opens it in
// Playwright Chromium (stand-in for a participant's browser — the recorder
// runs as ordinary injected page JS, nothing Playwright-specific), performs
// a scripted minute of input, then reports what the recorder captured.
//
//   node spike/run-spike.mjs <gameUrl> [--secs 60]

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GAME = process.argv[2] ?? 'https://fielddaylab.org/play/wake/ci/production/';
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECS = Number(flag('secs', 60));
const PORT = 7901;
const label = new URL(GAME).pathname.split('/').filter(Boolean)[1] ?? 'game';
const OUT = path.join('spike', 'out', label);

const proxy = spawn('node', ['spike/proxy.mjs', GAME, '--port', String(PORT), '--out', OUT], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const assetFailures = [];
page.on('response', (r) => { if (r.status() >= 400) assetFailures.push(`${r.status()} ${r.url().slice(0, 120)}`); });
page.on('pageerror', (e) => assetFailures.push(`PAGEERROR ${String(e).slice(0, 120)}`));

console.log(`\n== ${label} ==  ${GAME}`);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

// A scripted "participant": wait for load, then click around, type, scroll.
const half = Math.floor(SECS / 2) * 1000;
await page.waitForTimeout(half);
for (const [x, y] of [[640, 400], [640, 500], [200, 300], [1000, 600], [640, 640]]) {
  await page.mouse.move(x - 40, y - 20); await page.mouse.move(x, y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(1500);
}
await page.keyboard.press('Escape');
await page.mouse.wheel(0, 240);
await page.waitForTimeout(half - 9000 > 0 ? half - 9000 : 3000);

await browser.close();
proxy.kill();
await new Promise((r) => setTimeout(r, 300));

// ---- verdict --------------------------------------------------------------
const events = fs.readFileSync(path.join(OUT, 'events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const by = (k) => events.filter((e) => e.kind === k);
const chunks = fs.existsSync(path.join(OUT, 'video'))
  ? fs.readdirSync(path.join(OUT, 'video')).filter((f) => f.endsWith('.webm')) : [];
const chunkBytes = chunks.reduce((s, f) => s + fs.statSync(path.join(OUT, 'video', f)).size, 0);

const summary = {
  game: label, url: GAME,
  init: by('init').length > 0,
  clicks: by('click').length,
  keys: by('key').length,
  wheel: by('wheel').length,
  moves: by('move').length,
  dwells: by('dwell').length,
  ogdPosts: by('ogd').length,
  ogdSample: by('ogd').slice(0, 2).map((e) => e.url),
  playerCode: by('ogd').map((e) => e.playerCode).find(Boolean) ?? null,
  video: by('video')[0] ?? null,
  videoChunks: chunks.length, videoKB: Math.round(chunkBytes / 1024),
  assetFailures: assetFailures.slice(0, 6),
};
console.log('\n' + JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
