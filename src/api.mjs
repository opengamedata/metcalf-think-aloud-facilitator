// HTTP API per CONTRACTS.md §2. Returns true when a route was handled.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSession, appendEvents, writeChunk, mergeVideo, summarize,
  sessionDir, readLane, LANES } from './store.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;
const SID = /^[a-f0-9]{16}$/;

export function createApi({ db, dataDir, adminPassword }) {
  const cookieToken = adminPassword
    ? crypto.createHmac('sha256', adminPassword).update('metcalf-admin').digest('hex')
    : null;

  const isAdmin = (req) => {
    if (!adminPassword) return false;
    const auth = req.headers.authorization ?? '';
    if (auth === `Bearer ${adminPassword}`) return true;
    return (req.headers.cookie ?? '').includes(`metcalf_admin=${cookieToken}`);
  };

  const json = (res, status, obj, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };
  const body = (req, limit = 1 << 20) => new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
  const jsonBody = async (req) => { try { return JSON.parse((await body(req)).toString('utf8')); } catch { return null; } };

  return async function apiRoutes(req, res, u) {
    const seg = u.pathname.split('/').filter(Boolean);

    // ---- participant ------------------------------------------------------
    if (req.method === 'POST' && u.pathname === '/api/session/start') {
      const b = await jsonBody(req);
      if (!b || b.consent !== true) return json(res, 400, { error: 'consent required' }), true;
      const campaign = SLUG.test(b.slug ?? '') ? db.getCampaign(b.slug) : null;
      if (!campaign) return json(res, 404, { error: 'unknown campaign' }), true;
      const sessionId = crypto.randomBytes(8).toString('hex');
      const startedAt = new Date().toISOString();
      createSession(dataDir, campaign.slug, sessionId, {
        sessionId, campaign: campaign.slug, url: campaign.gameUrl,
        game: campaign.game ?? { w: 1280, h: 800 },
        ua: req.headers['user-agent'] ?? null,
        serverStartedAt: startedAt, consentAt: startedAt,
        playerCode: b.playerCode ?? null,
      });
      db.insertSession({ sessionId, slug: campaign.slug, startedAt, playerCode: b.playerCode });
      return json(res, 200, { sessionId }), true;
    }

    if (seg[0] === 'api' && seg[1] === 's' && SID.test(seg[2] ?? '')) {
      const row = db.getSession(seg[2]);
      if (!row) return json(res, 404, { error: 'unknown session' }), true;
      const dir = sessionDir(dataDir, row.slug, row.sessionId);

      if (req.method === 'POST' && seg[3] === 'events') {
        const b = await jsonBody(req);
        if (!b || !Array.isArray(b.events)) return json(res, 400, { error: 'events array required' }), true;
        return json(res, 200, { accepted: appendEvents(dir, b.events) }), true;
      }
      if (req.method === 'POST' && seg[3] === 'video') {
        if (row.status !== 'live') return json(res, 409, { error: 'session ended' }), true;
        const buf = await body(req, 64 << 20);
        writeChunk(dir, Number(u.searchParams.get('seq') ?? 0), buf);
        return json(res, 200, { ok: true }), true;
      }
      if (req.method === 'POST' && seg[3] === 'end') {
        if (row.status === 'live') {
          const sum = summarize(dir);
          appendEvents(dir, [{ lane: 'marks', t: sum.durationMs, kind: 'end' }]);
          mergeVideo(dir);
          const endedAt = new Date().toISOString();
          db.endSession(row.sessionId, { endedAt, ...sum, playerCode: sum.playerCode ?? row.playerCode });
          const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
          fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
            ...meta, endedAt, playerCode: sum.playerCode ?? meta.playerCode,
            counts: { utterances: sum.utterances, clicks: sum.clicks, ogdLogs: sum.ogdLogs },
          }, null, 2));
        }
        const fresh = db.getSession(row.sessionId);
        return json(res, 200, {
          durationMs: fresh.durationMs, utterances: fresh.utterances,
          clicks: fresh.clicks, ogdLogs: fresh.ogdLogs,
        }), true;
      }
      return json(res, 404, { error: 'not found' }), true;
    }

    // ---- admin ------------------------------------------------------------
    if (req.method === 'POST' && u.pathname === '/api/admin/login') {
      const b = await jsonBody(req);
      if (!adminPassword) return json(res, 503, { error: 'ADMIN_PASSWORD not configured' }), true;
      if (b?.password !== adminPassword) return json(res, 401, { error: 'bad password' }), true;
      return json(res, 200, { ok: true }, {
        'set-cookie': `metcalf_admin=${cookieToken}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`,
      }), true;
    }

    if (seg[0] === 'api' && seg[1] === 'admin') {
      if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' }), true;

      if (seg[2] === 'campaigns' && !seg[3]) {
        if (req.method === 'GET') return json(res, 200, db.listCampaigns()), true;
        if (req.method === 'POST') {
          const c = await jsonBody(req);
          if (!c || !SLUG.test(c.slug ?? '') || !/^https?:\/\//.test(c.gameUrl ?? ''))
            return json(res, 400, { error: 'slug ([a-z0-9-], 3-40) and http(s) gameUrl required' }), true;
          db.putCampaign(c);
          return json(res, 200, { ok: true, url: `/c/${c.slug}` }), true;
        }
      }
      if (seg[2] === 'campaigns' && SLUG.test(seg[3] ?? '')) {
        const slug = seg[3];
        if (req.method === 'GET' && !seg[4]) {
          const c = db.getCampaign(slug);
          return json(res, c ? 200 : 404, c ?? { error: 'not found' }), true;
        }
        if (req.method === 'PUT' && !seg[4]) {
          const c = await jsonBody(req);
          if (!c) return json(res, 400, { error: 'body required' }), true;
          db.putCampaign({ ...c, slug });
          return json(res, 200, { ok: true }), true;
        }
        if (req.method === 'DELETE' && !seg[4]) {
          db.deleteCampaign(slug);
          return json(res, 200, { ok: true }), true;
        }
        if (req.method === 'GET' && seg[4] === 'sessions') {
          return json(res, 200, db.listSessions(slug)), true;
        }
      }
      if (seg[2] === 'sessions' && SID.test(seg[3] ?? '')) {
        const row = db.getSession(seg[3]);
        if (!row) return json(res, 404, { error: 'not found' }), true;
        const dir = sessionDir(dataDir, row.slug, row.sessionId);
        if (req.method === 'GET' && seg[4] === 'timeline') {
          const events = LANES.flatMap((lane) => readLane(dir, lane).map((e) => ({ lane, ...e })))
            .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
          const hasVideo = fs.existsSync(path.join(dir, 'session.webm'));
          return json(res, 200, {
            session: row, events,
            video: hasVideo ? `/api/admin/sessions/${row.sessionId}/video` : null,
          }), true;
        }
        if (req.method === 'GET' && seg[4] === 'video') {
          const p = path.join(dir, 'session.webm');
          if (!fs.existsSync(p)) return json(res, 404, { error: 'no video' }), true;
          res.writeHead(200, { 'content-type': 'video/webm', 'content-length': fs.statSync(p).size });
          fs.createReadStream(p).pipe(res);
          return true;
        }
      }
      return json(res, 404, { error: 'not found' }), true;
    }

    return false;
  };
}
