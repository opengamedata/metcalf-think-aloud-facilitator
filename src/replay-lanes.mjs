// Lane definitions for the replay timeline strip.
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

export const LANE_CONFIG = [
  { id: 'clicks', label: 'clicks', shape: 'dot', color: '#e8a34a', from: (e) => e.lane === 'clicks' },
  { id: 'keys', label: 'keys', shape: 'tick', color: '#4fb3c0', from: (e) => e.lane === 'input' && e.kind === 'key' },
  { id: 'wheel', label: 'wheel', shape: 'bar', color: '#9a86e6', durKey: 'ms', burstGapMs: 400, from: (e) => e.lane === 'input' && e.kind === 'wheel' },
  { id: 'dwell', label: 'dwell', shape: 'bar', color: '#93a0ab', durKey: 'ms', from: (e) => e.lane === 'input' && e.kind === 'dwell' },
  { id: 'ogd', label: 'ogd', shape: 'dot', color: '#6eb891', needsTime: true, from: (e) => e.lane === 'ogd' },
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

// Serialize LANE_CONFIG (predicates included) as a source literal the browser
// can evaluate, so the client and the server share one definition.
export function laneConfigSource() {
  const field = (k, v) => (typeof v === 'function' ? `${k}:${v.toString()}` : `${k}:${JSON.stringify(v)}`);
  return `[${LANE_CONFIG.map((l) => `{${Object.entries(l).map(([k, v]) => field(k, v)).join(',')}}`).join(',')}]`;
}
