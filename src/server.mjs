// Entry point. Route order: API (campaigns/sessions/admin), then the M1
// spike routes (kept until S4 closes), then the base pages.

import http from 'node:http';
import { spikeRoutes } from './spike.mjs';
import { openDb } from './db.mjs';
import { createApi } from './api.mjs';
import { createParticipant } from './participant.mjs';
import { createAdminUi } from './adminui.mjs';

const PORT = Number(process.env.PORT ?? 7900);
const HOST = process.env.HOST ?? '127.0.0.1';

export function createServer({ dataDir = process.env.DATA_DIR ?? './data',
  adminPassword = process.env.ADMIN_PASSWORD } = {}) {
  const db = openDb(dataDir);
  const api = createApi({ db, dataDir, adminPassword });
  const participant = createParticipant({ db, dataDir });
  const adminUi = createAdminUi();

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      if (await api(req, res, u)) return;
      if (adminUi(req, res, u)) return;
      if (await participant(req, res, u)) return;
      if (await spikeRoutes(req, res, u)) return;
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
      return res.end();
    }
    if (u.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'metcalf-think-aloud-facilitator' }));
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>metcalf</title>' +
        '<body style="font:16px system-ui;padding:3rem"><h1>metcalf-think-aloud-facilitator</h1>' +
        '<p>Campaigns land here. <a href="/healthz">healthz</a></p>');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createServer().listen(PORT, HOST, () =>
    console.log(`metcalf listening on http://${HOST}:${PORT}`));
}
