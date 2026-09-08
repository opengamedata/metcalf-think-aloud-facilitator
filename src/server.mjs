// Entry point. Route order: API (campaigns/sessions/admin), then the M1
// spike routes (kept until S4 closes), then the base pages.

import http from 'node:http';
import crypto from 'node:crypto';
import { spikeRoutes } from './spike.mjs';
import { openDb } from './db.mjs';
import { createApi } from './api.mjs';
import { createParticipant } from './participant.mjs';
import { createAdminUi } from './adminui.mjs';
import { sendError } from './errors.mjs';

const PORT = Number(process.env.PORT ?? 7900);
const HOST = process.env.HOST ?? '127.0.0.1';

export function createServer({ dataDir = process.env.DATA_DIR ?? './data',
  adminPassword = process.env.ADMIN_PASSWORD } = {}) {
  const db = openDb(dataDir);
  const api = createApi({ db, dataDir, adminPassword });
  const participant = createParticipant({ db, dataDir });
  const adminUi = createAdminUi();

  // Same cookie/bearer scheme api.mjs mints; recomputed here so the replay
  // page can be gated before adminui.mjs renders its logged-out placeholder.
  const cookieToken = adminPassword
    ? crypto.createHmac('sha256', adminPassword).update('metcalf-admin').digest('hex')
    : null;
  const isAdmin = (req) => !!adminPassword && (
    (req.headers.authorization ?? '') === `Bearer ${adminPassword}`
    || (req.headers.cookie ?? '').includes(`metcalf_admin=${cookieToken}`));

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      // A researcher who followed a replay link with an expired session gets a
      // page with a real link, not adminui's bare "Log in at /admin first."
      if (/^\/admin\/replay\//.test(u.pathname) && !isAdmin(req)) {
        return void sendError(req, res, u, { status: 401, kind: 'login' });
      }
      if (await api(req, res, u)) return;
      if (adminUi(req, res, u)) return;
      if (await participant(req, res, u)) return;
      if (await spikeRoutes(req, res, u)) return;
    } catch (e) {
      return void sendError(req, res, u, { status: 500, error: e });
    }
    if (u.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'metcalf-think-aloud-facilitator' }));
    }
    // /c/<slug> that matched nothing is a participant with a stale or mistyped
    // study link — the one 404 that needs its own words.
    const kind = /^\/c\//.test(u.pathname) ? 'campaign' : 'notFound';
    sendError(req, res, u, { status: 404, kind });
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createServer().listen(PORT, HOST, () =>
    console.log(`metcalf listening on http://${HOST}:${PORT}`));
}
