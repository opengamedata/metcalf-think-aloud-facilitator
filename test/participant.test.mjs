import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.mjs';
import { md, micState, MIC_STATES, SILENT_MS, layout, durationHint } from '../src/participant.mjs';

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

// ------------------------------------------------------- participant safety

test('micState maps every state to a dot class and human copy', () => {
  assert.deepEqual(micState('idle'), { cls: 'dot', level: 'idle', text: 'mic idle' });
  assert.equal(micState('listening').cls, 'dot on');
  assert.equal(micState('silent').cls, 'dot warn');
  assert.match(micState('silent').text, /no sound detected/);
  assert.equal(micState('silent').level, 'warn');
  assert.equal(micState('denied').cls, 'dot err');
  assert.equal(micState('unsupported').level, 'err');
  assert.match(micState('error', 'network').text, /network/);
  assert.equal(micState('nonsense-state').text, 'mic idle');   // unknown -> idle
  assert.ok(SILENT_MS >= 15000 && SILENT_MS <= 30000);
});

test('layout keeps the side panel usable on a 1366x768 Chromebook', () => {
  const cb = layout(1366, 768, 1280, 800);
  assert.equal(cb.compact, true);
  assert.ok(cb.side >= 300, 'panel must not be squeezed below 300px');
  assert.ok(cb.scale < 1 && cb.scale > 0, 'game scales down to fit');
  assert.ok(1280 * cb.scale + cb.side <= 1366, 'game + panel fit the viewport');
  assert.ok(800 * cb.scale <= 768, 'game fits vertically');

  const big = layout(2560, 1440, 1280, 800);
  assert.equal(big.compact, false);
  assert.equal(big.scale, 1, 'large viewports keep 1:1');

  const tiny = layout(800, 600, 1280, 800);
  assert.ok(tiny.scale > 0 && tiny.scale < 1);
});

test('durationHint uses a campaign field when present, stays honest otherwise', () => {
  assert.match(durationHint({ durationMin: 20 }), /about 20 minutes/);
  assert.match(durationHint({ options: { durationMin: 15 } }), /about 15 minutes/);
  assert.match(durationHint({ estimatedMinutes: 30 }), /about 30 minutes/);
  assert.match(durationHint({}), /no fixed length/);
  assert.match(durationHint({ durationMin: 'soon' }), /no fixed length/);
  assert.match(durationHint(null), /no fixed length/);
});

test('consent page explains why Start is disabled, ARIA-associated', () => withApp(async (base, gameUrl) => {
  await makeCampaign(base, gameUrl);
  const page = await (await fetch(`${base}/c/stub-camp`)).text();
  assert.match(page, /id="consentHint"/);
  assert.match(page, /Tick the consent box/);
  assert.match(page, /aria-describedby="consentHint"/);
  assert.match(page, /aria-disabled="true"/);
  assert.match(page, /id="gate"/);                       // browser-support reason stays separate
  assert.match(page, /\$\('#consentHint'\)\.style\.display=ticked\?'none':'block'/);
}));

test('play page has a mic level meter and a silence warning', () => withApp(async (base, gameUrl) => {
  const sessionId = await makeCampaign(base, gameUrl);
  const page = await (await fetch(`${base}/play/${sessionId}`)).text();
  assert.match(page, /id="meter"/);
  assert.match(page, /id="meterFill"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /getUserMedia\(\{audio:true\}\)/);
  assert.match(page, /createAnalyser\(\)/);
  assert.match(page, /no sound detected/);
  assert.match(page, /SILENT_MS/);
  // warning/error transitions land on the marks lane for the replay timeline
  assert.match(page, /lane\('marks',\{kind:'mic'/);
  assert.match(page, /dot warn/);
}));

test('play page offers a working exit before the session begins', () => withApp(async (base, gameUrl) => {
  const sessionId = await makeCampaign(base, gameUrl);
  const page = await (await fetch(`${base}/play/${sessionId}`)).text();
  assert.match(page, /id="leave"/);
  assert.match(page, /Leave without participating/);
  assert.match(page, /id="left"/);
  assert.match(page, /That's completely fine/);
  assert.match(page, /kind:'withdraw'/);
  // the exit must not need the microphone
  const leave = page.slice(page.indexOf("$('#leave').onclick"));
  assert.doesNotMatch(leave.slice(0, 400), /startMic|getUserMedia/);
}));

test('pre-begin veil says how long it takes and that stopping is allowed', () => withApp(async (base, gameUrl) => {
  const sessionId = await makeCampaign(base, gameUrl);
  const page = await (await fetch(`${base}/play/${sessionId}`)).text();
  assert.match(page, /id="howlong"/);
  assert.match(page, /no fixed length/);
  assert.match(page, /stop whenever you want/);
}));

test('checklist is a labelled group and the layout goes compact', () => withApp(async (base, gameUrl) => {
  const sessionId = await makeCampaign(base, gameUrl);
  const page = await (await fetch(`${base}/play/${sessionId}`)).text();
  assert.match(page, /role="group"/);
  assert.match(page, /aria-labelledby="tasks-h"/);
  assert.match(page, /<h2 id="tasks-h">Tasks<\/h2>/);
  assert.match(page, /type="checkbox"/);                 // native checkboxes, no custom widget
  assert.doesNotMatch(page, /role="checkbox"/);
  assert.match(page, /body\.compact/);
  assert.match(page, /classList\.toggle\('compact'/);
}));
