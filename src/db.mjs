// SQLite index (CONTRACTS.md §5). The jsonl files on disk are the record;
// these tables exist for the admin table view and are rebuildable from disk.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Columns added after v1 shipped. `CREATE TABLE IF NOT EXISTS` is a no-op on a
// deployed database, so every one of these must also be applied by ALTER on an
// existing table. Defaults must be constants — SQLite rejects non-constant
// defaults in ALTER TABLE ADD COLUMN.
export const SESSION_COLUMNS = {
  // lifecycle
  lastEventAt: 'TEXT',                          // ISO wall clock of last ingest
  closedReason: 'TEXT',                         // participant | idle-timeout | force
  closedAt: 'TEXT',                             // ISO wall clock of the close
  // researcher judgement — deliberately separate fields, never folded into
  // `status`: lifecycle and analysis validity are different dimensions.
  excluded: 'INTEGER NOT NULL DEFAULT 0',
  exclusionReason: 'TEXT',
  pilot: 'INTEGER NOT NULL DEFAULT 0',
  note: 'TEXT',
  tags: 'TEXT',                                 // JSON array of strings
  flaggedAt: 'TEXT',
  flaggedBy: 'TEXT',
};

// Idempotent on both paths: a fresh db (columns already in CREATE TABLE) and an
// old deployed db (columns missing). Guarded per-column by PRAGMA table_info,
// and the ALTER itself is wrapped because a concurrent process may have won.
export function migrateSessions(db) {
  const have = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  const added = [];
  for (const [name, decl] of Object.entries(SESSION_COLUMNS)) {
    if (have.has(name)) continue;
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${decl}`);
      added.push(name);
    } catch (e) {
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
  }
  // Backfill: rows written by the old schema have no lastEventAt, which would
  // make the reaper treat them as infinitely idle in an unprincipled way. Their
  // best available heartbeat is when they started.
  db.exec('UPDATE sessions SET lastEventAt = startedAt WHERE lastEventAt IS NULL');
  return added;
}

const COLS = Object.entries(SESSION_COLUMNS).map(([n, d]) => `${n} ${d}`).join(', ');

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      slug TEXT PRIMARY KEY, json TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sessionId TEXT PRIMARY KEY, slug TEXT NOT NULL,
      startedAt TEXT NOT NULL, endedAt TEXT,
      durationMs INTEGER, playerCode TEXT,
      utterances INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
      ogdLogs INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'live',
      ${COLS}
    );
    -- One codebook per campaign. codeKey is the lowercased, trimmed code and
    -- carries the uniqueness rule; code keeps the casing of its first use.
    CREATE TABLE IF NOT EXISTS codebook (
      slug TEXT NOT NULL, codeKey TEXT NOT NULL, code TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      positive_example TEXT NOT NULL DEFAULT '',
      negative_example TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      PRIMARY KEY (slug, codeKey)
    );
    -- A code applied to a point (tEnd NULL) or a region (tEnd >= tStart) of a
    -- session's replay timeline. tStart/tEnd are ms on the session clock
    -- (CONTRACTS.md §1), the same t every other timeline lane is drawn against.
    CREATE TABLE IF NOT EXISTS code_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL, sessionId TEXT NOT NULL,
      codeKey TEXT NOT NULL, code TEXT NOT NULL,
      tStart INTEGER NOT NULL, tEnd INTEGER,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS code_applications_session
      ON code_applications (sessionId, tStart, id);
  `);
  migrateSessions(db);

  const close = db.prepare(`UPDATE sessions SET endedAt = ?, closedAt = ?, durationMs = ?,
    playerCode = ?, utterances = ?, clicks = ?, ogdLogs = ?, status = ?, closedReason = ?
    WHERE sessionId = ? AND status = 'live'`);

  return {
    raw: db,
    getCampaign: (slug) => {
      const row = db.prepare('SELECT json FROM campaigns WHERE slug = ?').get(slug);
      return row ? JSON.parse(row.json) : null;
    },
    listCampaigns: () => db.prepare('SELECT json, createdAt, updatedAt FROM campaigns ORDER BY updatedAt DESC').all()
      .map((r) => ({ ...JSON.parse(r.json), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    putCampaign: (campaign) => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO campaigns (slug, json, createdAt, updatedAt) VALUES (?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt`)
        .run(campaign.slug, JSON.stringify(campaign), now, now);
    },
    deleteCampaign: (slug) => {
      db.prepare('DELETE FROM code_applications WHERE slug = ?').run(slug);
      db.prepare('DELETE FROM codebook WHERE slug = ?').run(slug);
      db.prepare('DELETE FROM campaigns WHERE slug = ?').run(slug);
    },
    // ---- codebook (src/codebook.mjs owns the reuse-on-first-use rule) ------
    listCodebook: (slug) => db.prepare('SELECT * FROM codebook WHERE slug = ? ORDER BY code COLLATE NOCASE').all(slug),
    getCode: (slug, codeKey) => db.prepare('SELECT * FROM codebook WHERE slug = ? AND codeKey = ?').get(slug, codeKey) ?? null,
    insertCode: (e) => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO codebook (slug, codeKey, code, description, positive_example,
        negative_example, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug, codeKey) DO NOTHING`)
        .run(e.slug, e.codeKey, e.code, e.description ?? '', e.positive_example ?? '',
          e.negative_example ?? '', now, now);
    },
    updateCode: (slug, codeKey, fields) => db.prepare(`UPDATE codebook SET description = ?,
      positive_example = ?, negative_example = ?, updatedAt = ? WHERE slug = ? AND codeKey = ?`)
      .run(fields.description ?? '', fields.positive_example ?? '',
        fields.negative_example ?? '', new Date().toISOString(), slug, codeKey),
    // ---- code applications (src/code-applications.mjs owns the rules) -----
    insertCodeApplication: (a) => Number(db.prepare(`INSERT INTO code_applications (slug, sessionId,
      codeKey, code, tStart, tEnd, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(a.slug, a.sessionId, a.codeKey, a.code, a.tStart, a.tEnd ?? null,
        new Date().toISOString()).lastInsertRowid),
    getCodeApplication: (id) => db.prepare('SELECT * FROM code_applications WHERE id = ?').get(id) ?? null,
    listCodeApplications: (sessionId) => db.prepare(
      'SELECT * FROM code_applications WHERE sessionId = ? ORDER BY tStart, id').all(sessionId),

    insertSession: (s) => db.prepare(
      `INSERT INTO sessions (sessionId, slug, startedAt, playerCode, status, lastEventAt)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .run(s.sessionId, s.slug, s.startedAt, s.playerCode ?? null, 'live', s.startedAt),
    getSession: (id) => db.prepare('SELECT * FROM sessions WHERE sessionId = ?').get(id) ?? null,

    // The single write that closes a session. `status` is 'ended' (participant
    // clicked the button) or 'abandoned' (reaped or force-closed). Guarded on
    // status='live' so a second call is a no-op rather than a recount.
    closeSession: (id, u) => close.run(u.endedAt, u.closedAt ?? u.endedAt, u.durationMs,
      u.playerCode ?? null, u.utterances, u.clicks, u.ogdLogs,
      u.status ?? 'ended', u.closedReason ?? null, id).changes,

    // Retained for callers that predate closeSession.
    endSession: (id, u) => close.run(u.endedAt, u.endedAt, u.durationMs, u.playerCode ?? null,
      u.utterances, u.clicks, u.ogdLogs, 'ended', 'participant', id).changes,

    touchSession: (id, at) => db.prepare(
      "UPDATE sessions SET lastEventAt = ? WHERE sessionId = ? AND status = 'live'").run(at, id).changes,

    // Live sessions whose last heartbeat is at or before `cutoffIso`.
    listStaleSessions: (cutoffIso, slug = null) => (slug
      ? db.prepare(`SELECT * FROM sessions WHERE status = 'live'
          AND COALESCE(lastEventAt, startedAt) <= ? AND slug = ? ORDER BY startedAt`).all(cutoffIso, slug)
      : db.prepare(`SELECT * FROM sessions WHERE status = 'live'
          AND COALESCE(lastEventAt, startedAt) <= ? ORDER BY startedAt`).all(cutoffIso)),

    // Researcher annotation. Never destructive: it only writes these columns and
    // never touches status, counts, or the jsonl on disk.
    setSessionFlags: (id, f, at, by) => {
      const sets = []; const args = [];
      const put = (col, val) => { sets.push(`${col} = ?`); args.push(val); };
      if (f.excluded !== undefined) put('excluded', f.excluded ? 1 : 0);
      if (f.exclusionReason !== undefined) put('exclusionReason', f.exclusionReason ?? null);
      if (f.pilot !== undefined) put('pilot', f.pilot ? 1 : 0);
      if (f.note !== undefined) put('note', f.note ?? null);
      if (f.tags !== undefined) put('tags', f.tags === null ? null : JSON.stringify(f.tags));
      if (!sets.length) return 0;
      put('flaggedAt', at);
      put('flaggedBy', by ?? 'admin');
      args.push(id);
      return db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE sessionId = ?`).run(...args).changes;
    },

    listSessions: (slug) => db.prepare('SELECT * FROM sessions WHERE slug = ? ORDER BY startedAt DESC').all(slug),
  };
}
