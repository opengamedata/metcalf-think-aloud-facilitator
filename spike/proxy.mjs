// Spike 01: same-origin reverse proxy with recorder injection.
//
// Mounts one upstream game at this server's root and injects /recorder.js
// into every HTML response, before any game script runs. Everything the
// architecture rests on is testable here: does the game play through the
// proxy, do clicks surface, do OGD log posts get counted?
//
//   node spike/proxy.mjs <gameUrl> [--port 7901] [--out spike/out/<label>]
//
// Routes: /recorder.js (local), POST /spike-events (jsonl sink),
// POST /spike-video?seq=N (webm chunk sink), everything else -> upstream.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const GAME = new URL(process.argv[2] ?? 'https://fielddaylab.org/play/wake/ci/production/');
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = Number(flag('port', 7901));
const OUT = flag('out', path.join('spike', 'out', GAME.pathname.split('/').filter(Boolean)[1] ?? 'game'));
fs.mkdirSync(path.join(OUT, 'video'), { recursive: true });

const RECORDER = fs.readFileSync(new URL('./recorder.js', import.meta.url), 'utf8');
const eventsPath = path.join(OUT, 'events.jsonl');
fs.writeFileSync(eventsPath, '');

// Hop-by-hop / integrity-breaking headers we must not forward back.
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'content-security-policy',
  'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security']);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/recorder.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(RECORDER);
  }
  if (req.method === 'POST' && u.pathname === '/spike-events') {
    let body = '';
    req.on('data', (d) => (body += d));
    return req.on('end', () => {
      try {
        for (const ev of JSON.parse(body)) {
          fs.appendFileSync(eventsPath, JSON.stringify(ev) + '\n');
          console.log(`  ${ev.kind}  ${JSON.stringify(ev).slice(0, 140)}`);
        }
      } catch {}
      res.writeHead(204); res.end();
    });
  }
  if (req.method === 'POST' && u.pathname === '/spike-video') {
    const seq = String(u.searchParams.get('seq') ?? 0).padStart(5, '0');
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    return req.on('end', () => {
      fs.writeFileSync(path.join(OUT, 'video', `chunk-${seq}.webm`), Buffer.concat(chunks));
      res.writeHead(204); res.end();
    });
  }

  // Everything else is the game. Request paths are joined under the GAME's
  // own directory ('/Build/x' -> <gameBase>/Build/x) because the game page is
  // mounted at our root, so its relative asset URLs arrive as absolute paths.
  // A reference that really meant the upstream origin root gets a second
  // chance when the joined path 404s.
  const hdrs = { 'user-agent': req.headers['user-agent'] ?? 'metcalf-spike' };
  let r;
  try {
    r = await fetch(new URL('.' + u.pathname + u.search, GAME), { headers: hdrs });
    if (r.status === 404 && u.pathname !== '/') {
      r = await fetch(new URL(u.pathname + u.search, GAME.origin), { headers: hdrs });
    }
  } catch (e) {
    res.writeHead(502); return res.end(String(e));
  }
  const ct = r.headers.get('content-type') ?? '';
  const headers = {};
  for (const [k, v] of r.headers) if (!DROP.has(k.toLowerCase())) headers[k] = v;

  if (ct.includes('text/html')) {
    let html = await r.text();
    const tag = '<script src="/recorder.js"></script>';
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + tag)
      : tag + html;
    res.writeHead(r.status, { ...headers, 'content-type': ct });
    return res.end(html);
  }
  res.writeHead(r.status, headers);
  if (!r.body) return res.end();
  for await (const chunk of r.body) res.write(chunk);
  res.end();
});

server.listen(PORT, () => {
  console.log(`spike proxy  http://127.0.0.1:${PORT}/  ->  ${GAME.href}`);
  console.log(`  events -> ${eventsPath}`);
});
