import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.mjs';
import { md } from '../src/participant.mjs';

const PW = 'test-secret';
const admin = { authorization: `Bearer ${PW}`, 'content-type': 'application/json' };

// A stub upstream game: HTML page, a cacheable asset, everything else 404.
const stubGame = () => new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>stub</title></head><body><canvas width="1280" height="800"></canvas><script src="game.js"></script></body></html>');
    } else if (req.url === '/game.js' || req.url === '/escaped.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('// stub asset\n');
    } else { res.writeHead(404); res.end(); }
  });
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});

const withApp = async (fn) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-'));
  const upstream = await stubGame();
  const server = createServer({ dataDir, adminPassword: PW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gameUrl = `http://127.0.0.1:${upstream.address().port}/`;
  try { await fn(base, gameUrl, dataDir); }
  finally { server.close(); upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
};

const makeCampaign = async (base, gameUrl) => {
  await fetch(`${base}/api/admin/campaigns`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({
      slug: 'stub-camp', name: 'Stub campaign', gameUrl,
      instructionsMd: 'Find the **treasure**.', consentMd: 'We record clicks.',
      thankyouMd: 'Thank you!', checklist: [{ id: 'open-map', label: 'Open the map' }],
    }) });
  const { sessionId } = await (await fetch(`${base}/api/session/start`, {
    method: 'POST', body: JSON.stringify({ slug: 'stub-camp', consent: true }) })).json();
  return sessionId;
};

test('md renders paragraphs, bold, lists, and escapes html', () => {
  const out = md('## Hi\n\nFind the **thing** <script>x</script>\n\n- one\n- two');
  assert.match(out, /<h2>Hi<\/h2>/);
  assert.match(out, /<strong>thing<\/strong>/);
  assert.match(out, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.doesNotMatch(out, /<script>/);
});

test('consent page renders campaign text; unknown slug 404s', () => withApp(async (base, gameUrl) => {
  await makeCampaign(base, gameUrl);
  const page = await (await fetch(`${base}/c/stub-camp`)).text();
  assert.match(page, /Find the <strong>treasure<\/strong>/);
  assert.match(page, /We record clicks/);
  assert.match(page, /I have read the above/);
  assert.equal((await fetch(`${base}/c/none-such`)).status, 404);
}));

test('session page embeds the proxied game and the checklist', () => withApp(async (base, gameUrl) => {
  const sessionId = await makeCampaign(base, gameUrl);
  const page = await (await fetch(`${base}/play/${sessionId}`)).text();
  assert.match(page, new RegExp(`/g/${sessionId}/`));
  assert.match(page, /Open the map/);
  assert.match(page, /End session/);
}));

test('game proxy injects the recorder and caches assets', () => withApp(async (base, gameUrl) => {
  const sessionId = await makeCampaign(base, gameUrl);

  const html = await (await fetch(`${base}/g/${sessionId}/`)).text();
  assert.match(html, new RegExp(`__METCALF_SESSION=${JSON.stringify(sessionId)}`));
  assert.match(html, /\/assets\/recorder\.js/);
  assert.match(html, /<canvas/);

  const first = await fetch(`${base}/g/${sessionId}/game.js`);
  assert.equal(first.status, 200);
  assert.notEqual(first.headers.get('x-metcalf-cache'), 'hit');
  const second = await fetch(`${base}/g/${sessionId}/game.js`);
  assert.equal(second.headers.get('x-metcalf-cache'), 'hit');
  assert.match(await second.text(), /stub asset/);

  const escaped = await fetch(`${base}/escaped.js`, { headers: { referer: `${base}/g/${sessionId}/` } });
  assert.equal(escaped.status, 200);
  assert.match(await escaped.text(), /stub asset/);

  const recorder = await fetch(`${base}/assets/recorder.js`);
  assert.match(await recorder.text(), /__metcalfRecorder/);
}));
