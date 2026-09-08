import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { errorPage, wantsJson, incidentId, sendError } from '../src/errors.mjs';

const BROWSER = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

// Minimal ServerResponse stand-in, enough for sendError.
const fakeRes = () => ({
  status: 0, headers: {}, body: '', headersSent: false,
  writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; this.headersSent = true; },
  end(chunk = '') { this.body += chunk; },
});

const withApp = async (fn, opts = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-errors-'));
  const server = createServer({ dataDir, adminPassword: 'errors-test-secret', ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, server);
  } finally {
    await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
};

test('errorPage renders the accessible landmarks a screen reader needs', () => {
  const html = errorPage({ status: 404, title: 'That study link does not work', message: 'Ask your teacher.' });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<main[ >]/);
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1);
  assert.match(html, /That study link does not work/);
});

test('errorPage escapes anything interpolated into it', () => {
  const html = errorPage({ status: 404, title: 'Nope', message: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('errorPage back link is a real anchor', () => {
  const html = errorPage({ status: 401, title: 'Please log in', message: 'x', backLink: { href: '/admin', label: 'Go to the researcher login' } });
  assert.match(html, /<a[^>]+href="\/admin"[^>]*>Go to the researcher login<\/a>/);
});

test('wantsJson keeps /api/ on JSON and gives humans HTML', () => {
  const u = (p) => new URL(p, 'http://localhost');
  assert.equal(wantsJson({ headers: BROWSER }, u('/api/admin/campaigns')), true);
  assert.equal(wantsJson({ headers: {} }, u('/api/session/start')), true);
  assert.equal(wantsJson({ headers: BROWSER }, u('/c/whatever')), false);
  assert.equal(wantsJson({ headers: { accept: 'application/json' } }, u('/c/whatever')), true);
});

test('incidentId is short, opaque and unique', () => {
  const a = incidentId(); const b = incidentId();
  assert.match(a, /^[A-Z0-9]{6,10}$/);
  assert.notEqual(a, b);
});

test('a mistyped campaign link gets a human HTML page, not JSON', () => withApp(async (base) => {
  const res = await fetch(`${base}/c/no-such-campaign-xyz`, { headers: BROWSER });
  const body = await res.text();
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.doesNotMatch(body, /\{"error"/);
  assert.match(body, /<main[ >]/);
  assert.match(body, /link/i);
  assert.match(body, /teacher|researcher/i);
}));

test('the 404 page never echoes the slug the participant typed', () => withApp(async (base) => {
  const body = await (await fetch(`${base}/c/no-such-campaign-xyz`, { headers: BROWSER })).text();
  assert.doesNotMatch(body, /no-such-campaign-xyz/);
}));

test('unknown /api/ routes still answer with the old JSON shape', () => withApp(async (base) => {
  const res = await fetch(`${base}/api/definitely-not-a-route`, { headers: BROWSER });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { error: 'not found' });
}));

test('healthz JSON shape is untouched', () => withApp(async (base) => {
  const res = await fetch(`${base}/healthz`, { headers: BROWSER });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { ok: true, service: 'metcalf-think-aloud-facilitator' });
}));

test('the 500 path apologises without leaking the exception text', () => {
  const res = fakeRes();
  const logged = [];
  const id = sendError(
    { headers: BROWSER }, res, new URL('/play/abc', 'http://localhost'),
    { status: 500, error: new Error('kaboom-secret-internal-detail'), log: (...a) => logged.push(a.join(' ')) },
  );
  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.doesNotMatch(res.body, /kaboom-secret-internal-detail/);
  assert.doesNotMatch(res.body, /at .*\.mjs/);
  assert.match(res.body, /researcher/i);
  // the real error still reaches the server log, tied to the id shown to the user
  assert.match(logged.join(' '), /kaboom-secret-internal-detail/);
  assert.match(logged.join(' '), new RegExp(id));
  assert.match(res.body, new RegExp(id));
});

test('an /api/ 500 stays JSON and still hides the exception text', () => {
  const res = fakeRes();
  sendError({ headers: BROWSER }, res, new URL('/api/whatever', 'http://localhost'),
    { status: 500, error: new Error('kaboom-secret-internal-detail'), log: () => {} });
  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.doesNotMatch(res.body, /kaboom-secret-internal-detail/);
  assert.equal(typeof JSON.parse(res.body).error, 'string');
});

test('a logged-out replay link is a page with a login link, not a bare sentence', () => withApp(async (base) => {
  const res = await fetch(`${base}/admin/replay/${'a'.repeat(16)}`, { headers: BROWSER });
  const body = await res.text();
  assert.equal(res.status, 401);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(body, /<a[^>]+href="\/admin"/);
  assert.match(body, /<main[ >]/);
}));

test('a logged-in replay link still renders the replay page', () => withApp(async (base) => {
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', body: JSON.stringify({ password: 'errors-test-secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/admin/replay/${'a'.repeat(16)}`, { headers: { ...BROWSER, cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<video|id="v"/);
}));
