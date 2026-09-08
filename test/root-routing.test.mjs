import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

const PW = 'root-routing-test-secret';
const campaign = {
  slug: 'root-route-campaign',
  name: 'Root route campaign',
  gameUrl: 'https://example.com/game/',
  instructionsMd: 'Play.',
  consentMd: 'OK?',
  thankyouMd: 'Thanks!',
  checklist: [],
};

const withApp = async (fn) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metcalf-root-routing-'));
  const server = createServer({ dataDir, adminPassword: PW });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
};

test('logged-out root renders the application login instead of the placeholder', () => withApp(async (base) => {
  const response = await fetch(`${base}/`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(body, /id="login"/);
  assert.match(body, /Researcher password/);
  assert.match(body, /id="app"/);
  assert.doesNotMatch(body, /Campaigns land here/);
}));

test('authenticated root flow reaches campaign landing data', () => withApp(async (base) => {
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    body: JSON.stringify({ password: PW }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const root = await fetch(`${base}/`, { headers: { cookie } });
  const body = await root.text();
  assert.equal(root.status, 200);
  assert.match(body, /<h2>Campaigns<\/h2>/);

  const campaigns = await fetch(`${base}/api/admin/campaigns`, { headers: { cookie } });
  assert.equal(campaigns.status, 200);
}));

test('direct admin and campaign slug routes remain available', () => withApp(async (base) => {
  const admin = await fetch(`${base}/admin`);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /id="login"/);

  const created = await fetch(`${base}/api/admin/campaigns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${PW}`, 'content-type': 'application/json' },
    body: JSON.stringify(campaign),
  });
  assert.equal(created.status, 200);

  const participant = await fetch(`${base}/c/${campaign.slug}`);
  assert.equal(participant.status, 200);
  assert.match(await participant.text(), /Root route campaign/);
}));
