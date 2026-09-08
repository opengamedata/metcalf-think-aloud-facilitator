// HTTP API per CONTRACTS.md §2. Returns true when a route was handled.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSession, appendEvents, writeChunk, mergeVideo, summarize,
  sessionDir, readLane, LANES } from './store.mjs';
import { buildZip } from './zip.mjs';
import { editCode, deleteCode } from './codebook.mjs';
import { slugify } from './slugify.mjs';
import { applyCodeAt, toTimelineEvent } from './code-applications.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;
const SID = /^[a-f0-9]{16}$/;

// A live session with no ingest for this long is presumed abandoned (tab
// closed, wifi dropped, Chromebook asleep, class period over).
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
// How often the background sweep runs. 0 disables it entirely.
export const DEFAULT_REAP_INTERVAL_MS = 60 * 1000;

const num = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));

export function createApi({ db, dataDir, adminPassword,
  now = () => Date.now(),
  idleMs = num(process.env.SESSION_IDLE_MS, DEFAULT_IDLE_MS),
  reapIntervalMs = num(process.env.SESSION_REAP_INTERVAL_MS, DEFAULT_REAP_INTERVAL_MS) } = {}) {
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

  const nowIso = () => new Date(now()).toISOString();

  // ---- session lifecycle ---------------------------------------------------
  // ONE code path closes a session: the participant's [End session], the idle
  // reaper and the researcher's force-end all land here. `status` is 'ended'
  // (clean finish) or 'abandoned' (never closed itself); `closedReason` records
  // which of the three did it. Idempotent: a second call is a no-op because
  // db.closeSession only updates rows still in 'live'.
  const closeSession = (sessionId, { status = 'ended', closedReason = 'participant' } = {}) => {
    const row = db.getSession(sessionId);
    if (!row) return null;
    if (row.status !== 'live') return row;
    const dir = sessionDir(dataDir, row.slug, row.sessionId);
    const sum = summarize(dir);
    // summarize() is the authority on duration: max event t across all lanes,
    // on the participant clock (CONTRACTS §1). A session with no events at all
    // still has its t=0 'start' mark, so this is 0 — never null and never NaN.
    const durationMs = Number.isFinite(sum.durationMs) ? sum.durationMs : 0;
    const at = nowIso();
    appendEvents(dir, [{ lane: 'marks', t: durationMs, kind: 'end', reason: closedReason }]);
    mergeVideo(dir);
    db.closeSession(row.sessionId, {
      ...sum, durationMs, endedAt: at, closedAt: at, status, closedReason,
      playerCode: sum.playerCode ?? row.playerCode,
    });
    try {
      const p = path.join(dir, 'session.json');
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      fs.writeFileSync(p, JSON.stringify({
        ...meta, endedAt: at, status, closedReason,
        playerCode: sum.playerCode ?? meta.playerCode,
        counts: { utterances: sum.utterances, clicks: sum.clicks, ogdLogs: sum.ogdLogs },
      }, null, 2));
    } catch { /* jsonl on disk is the record; the meta rewrite is best-effort */ }
    return db.getSession(row.sessionId);
  };

  // Deterministic, clock-injected sweep. Never sleeps, never spawns anything.
  const reap = (slug = null) => {
    const cutoff = new Date(now() - idleMs).toISOString();
    const stale = db.listStaleSessions(cutoff, slug);
    const reaped = [];
    for (const row of stale) {
      closeSession(row.sessionId, { status: 'abandoned', closedReason: 'idle-timeout' });
      reaped.push(row.sessionId);
    }
    return { reaped, cutoff, idleMs };
  };

  // Interval sweep for the no-scheduler case. unref'd so it never holds a test
  // process open, and disabled outright with reapIntervalMs = 0.
  let timer = null;
  if (reapIntervalMs > 0) {
    timer = setInterval(() => { try { reap(); } catch { /* best effort */ } }, reapIntervalMs);
    timer.unref?.();
  }

  // Row shape a UI consumes: SQLite ints become booleans, tags become an array,
  // and a still-live row gets a usable duration so the replay scrub bar has a
  // length instead of rendering 0:00.
  const view = (row) => {
    if (!row) return row;
    let durationMs = row.durationMs;
    if (durationMs === null || durationMs === undefined) {
      try { durationMs = summarize(sessionDir(dataDir, row.slug, row.sessionId)).durationMs; }
      catch { durationMs = 0; }
      if (!Number.isFinite(durationMs)) durationMs = 0;
    }
    let tags = [];
    try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
    return {
      ...row, durationMs, tags,
      excluded: !!row.excluded,
      pilot: !!row.pilot,
      note: row.note ?? null,
      exclusionReason: row.exclusionReason ?? null,
      closedReason: row.closedReason ?? null,
    };
  };

  const apiRoutes = async function apiRoutes(req, res, u) {
    const seg = u.pathname.split('/').filter(Boolean);

    // ---- participant ------------------------------------------------------
    if (req.method === 'POST' && u.pathname === '/api/session/start') {
      const b = await jsonBody(req);
      if (!b || b.consent !== true) return json(res, 400, { error: 'consent required' }), true;
      const campaign = SLUG.test(b.slug ?? '') ? db.getCampaign(b.slug) : null;
      if (!campaign) return json(res, 404, { error: 'unknown campaign' }), true;
      const sessionId = crypto.randomBytes(8).toString('hex');
      const startedAt = nowIso();
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
        const accepted = appendEvents(dir, b.events);
        if (accepted) db.touchSession(row.sessionId, nowIso());   // heartbeat for the reaper
        return json(res, 200, { accepted }), true;
      }
      if (req.method === 'POST' && seg[3] === 'video') {
        if (row.status !== 'live') return json(res, 409, { error: 'session ended' }), true;
        const buf = await body(req, 64 << 20);
        writeChunk(dir, Number(u.searchParams.get('seq') ?? 0), buf);
        db.touchSession(row.sessionId, nowIso());
        return json(res, 200, { ok: true }), true;
      }
      if (req.method === 'POST' && seg[3] === 'end') {
        const fresh = closeSession(row.sessionId, { status: 'ended', closedReason: 'participant' });
        return json(res, 200, {
          durationMs: fresh.durationMs, utterances: fresh.utterances,
          clicks: fresh.clicks, ogdLogs: fresh.ogdLogs,
          status: fresh.status, closedReason: fresh.closedReason,
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
          if (!c) return json(res, 400, { error: 'body required' }), true;
          // Normalize instead of nitpicking: anything slugify can fix, it fixes.
          const rawSlug = String(c.slug ?? '');
          c.slug = slugify(rawSlug);
          if (!SLUG.test(c.slug))
            return json(res, 400, { error: `Slug "${rawSlug}" is invalid — 3-40 characters, lowercase letters, digits, and dashes only (it becomes the participant URL /c/<slug>).` }), true;
          if (!/^https?:\/\//.test(c.gameUrl ?? ''))
            return json(res, 400, { error: 'Game URL must start with http:// or https://' }), true;
          db.putCampaign(c);
          return json(res, 200, { ok: true, slug: c.slug, url: `/c/${c.slug}` }), true;
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
          reap(slug);                       // lazy sweep on read
          return json(res, 200, db.listSessions(slug).map(view)), true;
        }
        // Shared by the campaign table and replay picker. A query parameter
        // preserves every freeform label, including URL dot segments like "..".
        if (seg[4] === 'codebook') {
          if (!db.getCampaign(slug)) return json(res, 404, { error: 'Campaign not found.' }), true;
          if (req.method === 'GET' && seg.length === 5)
            return json(res, 200, db.listCodebook(slug)), true;
          if (seg.length === 5 && ['PATCH', 'DELETE'].includes(req.method)) {
            const key = u.searchParams.get('code');
            if (key === null) return json(res, 400, { error: 'Code is required.' }), true;
            const fields = req.method === 'PATCH' ? await jsonBody(req) : null;
            try {
              const result = req.method === 'PATCH'
                ? editCode(db, slug, key, fields) : deleteCode(db, slug, key);
              return json(res, 200, result), true;
            } catch (err) {
              if (!err.status) throw err;
              return json(res, err.status, { error: err.message }), true;
            }
          }
        }
        if (req.method === 'GET' && seg[4] === 'package.zip') {
          reap(slug);
          const rows = db.listSessions(slug).map(view);
          const cols = ['sessionId', 'playerCode', 'startedAt', 'endedAt', 'durationMs',
            'utterances', 'clicks', 'ogdLogs', 'status', 'closedReason',
            'excluded', 'exclusionReason', 'pilot', 'note', 'tags'];
          const manifest = [cols.join(','), ...rows.map((r) =>
            cols.map((c) => JSON.stringify(
              Array.isArray(r[c]) ? r[c].join('|') : (r[c] ?? ''))).join(','))].join('\n') + '\n';
          const entries = [{ name: `${slug}/manifest.csv`, data: Buffer.from(manifest) }];
          for (const r of rows) {
            const dir = sessionDir(dataDir, slug, r.sessionId);
            if (!fs.existsSync(dir)) continue;
            for (const f of fs.readdirSync(dir)) {
              const p = path.join(dir, f);
              if (fs.statSync(p).isFile()) {
                entries.push({ name: `${slug}/${r.sessionId}/${f}`, data: fs.readFileSync(p) });
              }
            }
          }
          const zip = buildZip(entries);
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-length': zip.length,
            'content-disposition': `attachment; filename="${slug}-package.zip"`,
          });
          res.end(zip);
          return true;
        }
      }
      // Sweep every live session that has gone idle, on demand.
      if (req.method === 'POST' && seg[2] === 'sessions' && seg[3] === 'reap' && !seg[4]) {
        return json(res, 200, reap()), true;
      }
      if (seg[2] === 'sessions' && SID.test(seg[3] ?? '')) {
        const row = db.getSession(seg[3]);
        if (!row) return json(res, 404, { error: 'not found' }), true;
        const dir = sessionDir(dataDir, row.slug, row.sessionId);

        if (req.method === 'GET' && !seg[4]) return json(res, 200, view(row)), true;

        // Teacher's "reset the lab for the next class". Same close path as the
        // reaper; safe to call twice.
        if (req.method === 'POST' && seg[4] === 'force-end') {
          const b = await jsonBody(req);
          const wasLive = row.status === 'live';
          const fresh = closeSession(row.sessionId, {
            status: b?.status === 'ended' ? 'ended' : 'abandoned',
            closedReason: 'force',
          });
          return json(res, 200, { ok: true, alreadyClosed: !wasLive, session: view(fresh) }), true;
        }

        // Researcher judgement. Never destructive — the jsonl on disk is
        // untouched; excluding is not deleting.
        if ((req.method === 'POST' || req.method === 'PUT') && seg[4] === 'flags') {
          const b = await jsonBody(req);
          if (!b || typeof b !== 'object') return json(res, 400, { error: 'body required' }), true;
          const f = {};
          if ('excluded' in b) f.excluded = !!b.excluded;
          if ('exclusionReason' in b) f.exclusionReason = b.exclusionReason == null ? null : String(b.exclusionReason);
          if ('pilot' in b) f.pilot = !!b.pilot;
          if ('note' in b) f.note = b.note == null ? null : String(b.note);
          if ('tags' in b) {
            if (b.tags == null) f.tags = [];
            else if (Array.isArray(b.tags)) f.tags = b.tags.map(String).filter(Boolean);
            else return json(res, 400, { error: 'tags must be an array of strings' }), true;
          }
          if (!Object.keys(f).length)
            return json(res, 400, { error: 'no known flag fields; expected excluded, exclusionReason, pilot, note, tags' }), true;
          db.setSessionFlags(row.sessionId, f, nowIso(), 'admin');
          return json(res, 200, { ok: true, session: view(db.getSession(row.sessionId)) }), true;
        }

        if (req.method === 'GET' && seg[4] === 'timeline') {
          // Recorded events and researcher-applied codes merge into one
          // t-sorted list, so the codes lane needs no separate client path.
          const events = [
            ...LANES.flatMap((lane) => readLane(dir, lane).map((e) => ({ lane, ...e }))),
            ...db.listCodeApplications(row.sessionId).map(toTimelineEvent),
          ].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
          const hasVideo = fs.existsSync(path.join(dir, 'session.webm'));
          return json(res, 200, {
            session: view(row), events,
            video: hasVideo ? `/api/admin/sessions/${row.sessionId}/video` : null,
          }), true;
        }
        if (seg[4] === 'codes') {
          if (req.method === 'GET') return json(res, 200, db.listCodeApplications(row.sessionId)), true;
          if (req.method === 'POST') {
            const b = await jsonBody(req);
            if (!b) return json(res, 400, { error: 'body required' }), true;
            try {
              // The campaign comes from the session, never from the body, so a
              // code can only ever land in its own campaign's codebook.
              return json(res, 200, applyCodeAt(db, {
                slug: row.slug, sessionId: row.sessionId,
                code: b.code, tStart: b.tStart, tEnd: b.tEnd,
              })), true;
            } catch (err) {
              if (err.code === 'INVALID_CODE' || err.code === 'INVALID_TIME')
                return json(res, 400, { error: err.message }), true;
              throw err;
            }
          }
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

  // Exposed for tests and for any future caller that needs the lifecycle
  // without going through HTTP.
  apiRoutes.reap = reap;
  apiRoutes.closeSession = closeSession;
  apiRoutes.stopReaper = () => { if (timer) clearInterval(timer); timer = null; };
  return apiRoutes;
}
