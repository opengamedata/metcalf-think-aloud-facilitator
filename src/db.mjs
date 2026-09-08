// SQLite index (CONTRACTS.md §5). The jsonl files on disk are the record;
// these tables exist for the admin table view and are rebuildable from disk.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

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
      ogdLogs INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'live'
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
  return {
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
      'INSERT INTO sessions (sessionId, slug, startedAt, playerCode, status) VALUES (?, ?, ?, ?, ?)')
      .run(s.sessionId, s.slug, s.startedAt, s.playerCode ?? null, 'live'),
    getSession: (id) => db.prepare('SELECT * FROM sessions WHERE sessionId = ?').get(id) ?? null,
    endSession: (id, u) => db.prepare(`UPDATE sessions SET endedAt = ?, durationMs = ?, playerCode = ?,
      utterances = ?, clicks = ?, ogdLogs = ?, status = 'ended' WHERE sessionId = ?`)
      .run(u.endedAt, u.durationMs, u.playerCode ?? null, u.utterances, u.clicks, u.ogdLogs, id),
    listSessions: (slug) => db.prepare('SELECT * FROM sessions WHERE slug = ? ORDER BY startedAt DESC').all(slug),
  };
}
