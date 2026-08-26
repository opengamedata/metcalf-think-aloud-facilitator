// Network-level truth for the OGD question: what requests does the game make
// through the proxy, does any hit the opengamedata endpoint, and does CORS
// block it now that the page origin is ours instead of fielddaylab's?
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const GAME = process.argv[2] ?? 'https://fielddaylab.wisc.edu/play/astrogame/ci/production/';
const proxy = spawn('node', ['spike/proxy.mjs', GAME, '--port', '7901', '--out', 'spike/out/dbg'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const INTERESTING = /wcer|opengamedata|ogd|player|logger|\/log/i;
page.on('request', (r) => {
  if (!INTERESTING.test(r.url())) return;
  console.log('REQ ', r.method(), r.resourceType(), 'frame=' + (r.frame()?.url() ?? '?').slice(0, 60),
    'sw=' + !!r.serviceWorker(), r.url().slice(0, 140));
});
page.on('requestfailed', (r) => { if (INTERESTING.test(r.url())) console.log('FAIL', r.url().slice(0, 120), r.failure()?.errorText); });
page.on('response', (r) => { if (INTERESTING.test(r.url())) console.log('RESP', r.status(), r.url().slice(0, 160)); });
page.on('console', (m) => { const t = m.text(); if (/cors|blocked|access-control|refused/i.test(t)) console.log('CONSOLE', t.slice(0, 200)); });

await page.goto('http://127.0.0.1:7901/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(45000);
// poke the center a few times in case logging starts with the first real click
for (let i = 0; i < 3; i++) { await page.mouse.click(640, 420); await page.waitForTimeout(4000); }
await page.waitForTimeout(20000);
await browser.close(); proxy.kill();
