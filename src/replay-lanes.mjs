// Lane definitions for the replay timeline strip, plus the pure helpers the
// replay page needs (duration resolution, transcript sync, key handling).
// One entry per horizontal lane, in top-to-bottom order. Adding a lane is one
// entry here — nothing else in the replay page branches on lane identity.
//
//   id          track element id + css hook
//   label       left-aligned lowercase label drawn in the strip
//   shape       'dot' (point event) | 'tick' | 'bar' (has a duration)
//   color       marker colour for the whole lane
//   from        predicate over a raw timeline event
//   durKey      field carrying the marker's duration in ms (bars only)
//   burstGapMs  coalesce runs of events closer than this into one bar
//   needsTime   drop the event unless it carries a usable numeric t
//   shapeFor    per-event shape override, when one lane holds both kinds
//   titleFor    per-event hover text

export const LANE_CONFIG = [
  { id: 'speech', label: 'speech', shape: 'tick', color: '#e6d27a', needsTime: true, from: (e) => e.lane === 'transcript' && e.typed !== true },
  { id: 'typed', label: 'typed', shape: 'tick', color: '#c58fd6', needsTime: true, from: (e) => e.lane === 'transcript' && e.typed === true },
  { id: 'clicks', label: 'clicks', shape: 'dot', color: '#e8a34a', from: (e) => e.lane === 'clicks' },
  { id: 'keys', label: 'keys', shape: 'tick', color: '#4fb3c0', from: (e) => e.lane === 'input' && e.kind === 'key' },
  { id: 'wheel', label: 'wheel', shape: 'bar', color: '#9a86e6', durKey: 'ms', burstGapMs: 400, from: (e) => e.lane === 'input' && e.kind === 'wheel' },
  { id: 'dwell', label: 'dwell', shape: 'bar', color: '#93a0ab', durKey: 'ms', from: (e) => e.lane === 'input' && e.kind === 'dwell' },
  { id: 'ogd', label: 'ogd', shape: 'dot', color: '#6eb891', needsTime: true, from: (e) => e.lane === 'ogd' },
  { id: 'checks', label: 'checklist', shape: 'dot', color: '#e4735c', needsTime: true, from: (e) => e.lane === 'checklist' },
  // Researcher-applied codes: one lane holding both point and region
  // applications, so a code reads at a glance as an instant or a span.
  { id: 'codes', label: 'codes', shape: 'bar', color: '#e07a9f', durKey: 'ms', needsTime: true,
    shapeFor: (e) => (Number(e.ms) > 0 ? 'bar' : 'dot'), titleFor: (e) => e.code,
    from: (e) => e.lane === 'codes' },
];

// Which lane an event belongs to, or null when it is not shown in the strip
// (input/move is deliberately excluded — far too dense to draw).
export function laneFor(event) {
  if (!event) return null;
  for (const lane of LANE_CONFIG) {
    if (!lane.from(event)) continue;
    if (lane.needsTime && !Number.isFinite(event.t)) return null;
    return lane.id;
  }
  return null;
}

// Horizontal position of a marker as a percentage of the strip, clamped.
export function posPct(t, dur) {
  if (!Number.isFinite(t) || !Number.isFinite(dur) || dur <= 0) return 0;
  return Math.min(100, Math.max(0, (t / dur) * 100));
}

// --- transcript -------------------------------------------------------------
// Typed-not-spoken entries carry typed:true. The distinction is analytically
// meaningful (a typed note is not narration) and is never flattened away.
export function isTypedUtterance(event) {
  return !!(event && event.lane === 'transcript' && event.typed === true);
}

// Normalized, time-sorted utterance list: [{t, text, typed}].
export function transcriptEntries(events) {
  const out = [];
  for (const e of events ?? []) {
    if (!e || e.lane !== 'transcript') continue;
    if (!Number.isFinite(e.t)) continue;
    const text = typeof e.text === 'string' ? e.text : '';
    if (!text.trim()) continue;
    out.push({ t: e.t, text, typed: e.typed === true });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Index of the utterance the playhead is currently in (the last one at or
// before t), or -1 before the first utterance. Entries must be time-sorted.
export function activeUtteranceIndex(entries, t) {
  if (!Array.isArray(entries) || !entries.length || !Number.isFinite(t)) return -1;
  let found = -1;
  for (let i = 0; i < entries.length; i++) {
    if (Number.isFinite(entries[i].t) && entries[i].t <= t) found = i;
    else if (Number.isFinite(entries[i].t)) break;
  }
  return found;
}

// --- duration ---------------------------------------------------------------
// durationMs is null for abandoned sessions, and can lag the events we can
// actually see. Never trust it alone: take the largest defensible span of the
// stored value, the event stream (including bar durations) and the media.
export function effectiveDurationMs(opts) {
  const o = opts ?? {};
  const stored = Number(o.storedMs);
  const media = Number(o.mediaMs);
  const offset = Number.isFinite(Number(o.offsetMs)) ? Number(o.offsetMs) : 0;
  const pad = Number.isFinite(Number(o.padMs)) ? Number(o.padMs) : 1000;
  let best = 1;
  if (Number.isFinite(stored) && stored > 0) best = Math.max(best, stored);
  let last = 0;
  for (const e of o.events ?? []) {
    if (!e || !Number.isFinite(e.t)) continue;
    const span = Number.isFinite(e.ms) && e.ms > 0 ? e.ms : 0;
    last = Math.max(last, e.t + span);
  }
  if (last > 0) best = Math.max(best, last + pad);
  if (Number.isFinite(media) && media > 0) best = Math.max(best, offset + media);
  return Math.max(1, Math.round(best));
}

// --- analyst controls -------------------------------------------------------
// Keyboard shortcuts are rendered as a legend so they are discoverable.
export const SHORTCUTS = [
  { keys: 'space', label: 'play / pause' },
  { keys: '← →', label: 'step 5s' },
  { keys: 'J L', label: 'step 10s' },
  { keys: '[ ]', label: 'prev / next event' },
  { keys: '- +', label: 'speed' },
];

export const SPEEDS = [0.5, 1, 1.5, 2, 4];

// Shortcuts must never hijack typing. Range/checkbox inputs keep their own
// native key behaviour and are not text entry. This matters doubly now that
// the codes applicator puts a text input on the replay page.
export function isTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = String(el.type ?? 'text').toLowerCase();
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
}

// Jump-to-event navigation: the next/previous distinct event time relative to
// t, or null at the ends. epsilonMs stops repeated presses sticking in place.
export function nextEventTime(times, t, dir, epsilonMs) {
  const eps = Number.isFinite(Number(epsilonMs)) ? Number(epsilonMs) : 250;
  const list = (times ?? []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const now = Number.isFinite(t) ? t : 0;
  if (dir >= 0) {
    for (const x of list) if (x > now + eps) return x;
    return null;
  }
  let prev = null;
  for (const x of list) { if (x < now - eps) prev = x; else break; }
  return prev;
}

// Serialize LANE_CONFIG (predicates included) as a source literal the browser
// can evaluate, so the client and the server share one definition.
export function laneConfigSource() {
  const field = (k, v) => (typeof v === 'function' ? `${k}:${v.toString()}` : `${k}:${JSON.stringify(v)}`);
  return `[${LANE_CONFIG.map((l) => `{${Object.entries(l).map(([k, v]) => field(k, v)).join(',')}}`).join(',')}]`;
}

// Same trick for the pure helpers: one definition, evaluated in the browser.
export function replayHelpersSource() {
  const fns = [isTypedUtterance, transcriptEntries, activeUtteranceIndex, effectiveDurationMs, isTextEntry, nextEventTime];
  return fns.map((f) => `const ${f.name}=${f.toString()};`).join('\n')
    + `\nconst SHORTCUTS=${JSON.stringify(SHORTCUTS)};const SPEEDS=${JSON.stringify(SPEEDS)};`;
}
