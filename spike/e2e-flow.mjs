// Full participant flow against the real server + real Wake, driven headless.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PW = 'e2e-secret';
fs.rmSync('spike/out/e2e-data', { recursive: true, force: true });
const srv = spawn('node', ['src/server.mjs'], {
  env: { ...process.env, PORT: '7906', DATA_DIR: 'spike/out/e2e-data', ADMIN_PASSWORD: PW }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const base = 'http://127.0.0.1:7906';
const admin = { authorization: `Bearer ${PW}`, 'content-type': 'application/json' };

await fetch(`${base}/api/admin/campaigns`, { method: 'POST', headers: admin, body: JSON.stringify({
  slug: 'wake-e2e', name: 'Wake e2e', gameUrl: 'https://fielddaylab.org/play/wake/ci/production/',
  instructionsMd: 'Explore the ship.', consentMd: 'This records your play and voice transcript.',
  thankyouMd: 'Thanks for playing!', checklist: [{ id: 'title', label: 'Get past the title screen' }],
}) });

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1720, height: 820 } });
await page.goto(`${base}/c/wake-e2e`, { waitUntil: 'domcontentloaded' });
await page.check('#consent');
await page.click('#start');
await page.waitForURL('**/play/**', { timeout: 10000 });
const sessionId = page.url().split('/').pop();
console.log('session', sessionId);
await page.click('#begin');
await page.waitForTimeout(50000);                       // let Unity boot + video start
for (const [x, y] of [[640, 400], [640, 500], [200, 300]]) {
  await page.mouse.move(x - 30, y - 10);
  await page.mouse.click(x, y);
  await page.waitForTimeout(2500);
}
await page.fill('#say', 'the gear icon looks clickable');
await page.click('#send');
await page.check('.task input');
await page.click('#pause'); await page.waitForTimeout(1500); await page.click('#pause');
await page.waitForTimeout(12000);                       // more video chunks
page.on('dialog', d => d.accept());
await page.click('#endbtn');
await page.waitForSelector('#summary', { state: 'visible', timeout: 15000 });
const summary = await page.evaluate(() => ({
  dur: document.querySelector('#s-dur').textContent,
  utt: document.querySelector('#s-utt').textContent,
  ogd: document.querySelector('#s-ogd').textContent,
  thanks: document.querySelector('#thanks').textContent.trim(),
}));
await browser.close();

const tl = await (await fetch(`${base}/api/admin/sessions/${sessionId}/timeline`, { headers: admin })).json();
const lanes = tl.events.reduce((a, e) => (a[e.lane] = (a[e.lane] ?? 0) + 1, a), {});
const dir = `spike/out/e2e-data/sessions/wake-e2e/${sessionId}`;
console.log(JSON.stringify({
  summary, lanes, video: tl.video,
  webm: fs.existsSync(`${dir}/session.webm`) ? fs.statSync(`${dir}/session.webm`).size : 0,
  marks: tl.events.filter(e => e.lane === 'marks').map(e => e.kind),
  status: tl.session.status,
}, null, 1));
srv.kill();
