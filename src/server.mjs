// Minimal M0 server: proves the deploy path (tunnel -> 127.0.0.1:7900) and
// gives CI something real to test. Routes grow per CONTRACTS.md; this file
// stays the single entry point.

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 7900);
const HOST = process.env.HOST ?? '127.0.0.1';

export function createServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'metcalf-think-aloud-facilitator' }));
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>metcalf</title>' +
        '<body style="font:16px system-ui;padding:3rem"><h1>metcalf-think-aloud-facilitator</h1>' +
        '<p>M0 scaffold — campaigns land here. <a href="/healthz">healthz</a></p>');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createServer().listen(PORT, HOST, () =>
    console.log(`metcalf listening on http://${HOST}:${PORT}`));
}
