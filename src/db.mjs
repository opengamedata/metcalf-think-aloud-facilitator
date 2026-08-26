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
    deleteCampaign: (slug) => db.prepare('DELETE FROM campaigns WHERE slug = ?').run(slug),
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
