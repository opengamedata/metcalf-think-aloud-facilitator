// Applying a code to a point or a region of a session's replay timeline
// (Trello N0Abs2n8). The code string itself goes through the campaign
// codebook's reuse-on-first-use path (src/codebook.mjs), so here too "pick an
// existing code" and "type a new one inline" are the same call: the only
// difference is whether `created` comes back true.
//
// A point code has tEnd === null; a region carries tEnd >= tStart. Both are
// milliseconds on the session clock (CONTRACTS.md §1) — the same t every other
// lane of the replay timeline is drawn against.

import { applyCode, normalizeCode, invalidCodeError } from './codebook.mjs';

export function invalidTimeError(message) {
  const err = new Error(message);
  err.code = 'INVALID_TIME';
  return err;
}

// Integer milliseconds on the session clock, or null when unusable. Strings
// are not coerced: a timestamp arriving as text means the caller lost the
// number somewhere, and silently parsing it hides that.
function ms(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

// Validate and coerce {code, tStart, tEnd} into exactly what gets stored.
// Throws INVALID_CODE / INVALID_TIME; the HTTP layer turns those into 400s.
export function normalizeApplication({ code, tStart, tEnd } = {}) {
  const label = normalizeCode(code);
  if (label === null) throw invalidCodeError(code);

  const start = ms(tStart);
  if (start === null) throw invalidTimeError('tStart must be a number of milliseconds.');
  if (start < 0) throw invalidTimeError('tStart must not be negative.');

  // Absent tEnd is the point case, and the only way to get one.
  if (tEnd === undefined || tEnd === null) return { code: label, tStart: start, tEnd: null };

  const end = ms(tEnd);
  if (end === null) throw invalidTimeError('tEnd must be a number of milliseconds, or null for a point code.');
  if (end < start) throw invalidTimeError('tEnd must not be before tStart.');
  return { code: label, tStart: start, tEnd: end };
}

// True when the application covers a span rather than an instant.
export const isRegion = (app) => app != null && app.tEnd !== null && app.tEnd !== undefined;

// Apply a code at a point or over a region. Minting the codebook entry and
// recording the application are one call: a string the campaign has never seen
// is added to its codebook (created: true) and applied in the same breath.
// The stored label is the codebook's — i.e. the casing of the code's first use.
export function applyCodeAt(db, { slug, sessionId, code, tStart, tEnd }) {
  const app = normalizeApplication({ code, tStart, tEnd });
  const { entry, created } = applyCode(db, slug, app.code);
  const id = db.insertCodeApplication({
    slug, sessionId, codeKey: entry.codeKey, code: entry.code,
    tStart: app.tStart, tEnd: app.tEnd,
  });
  return { application: db.getCodeApplication(id), entry, created };
}

// A code application as the replay timeline consumes it: a `codes` lane event
// carrying `t` and a duration `ms`, so it flows through the same laneFor /
// posPct path as clicks, keys and ogd instead of a parallel one.
export function toTimelineEvent(app) {
  return { ...app, lane: 'codes', t: app.tStart, ms: app.tEnd == null ? 0 : app.tEnd - app.tStart };
}
