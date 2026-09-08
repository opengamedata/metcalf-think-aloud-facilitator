# E2ZXWJKa — Replay: horizontal event lanes on the timeline

## What changed

### `src/replay-lanes.mjs` (new)
Pure, dependency-free module holding the single source of truth for the lane strip.

- `LANE_CONFIG` — one array literal, one entry per lane, in top-to-bottom order:
  `clicks`, `keys`, `wheel`, `dwell`, `ogd`. Each entry carries `{id, label, shape, color, from}`
  plus optional `durKey` (field holding a duration in ms), `burstGapMs` (coalesce a run of point
  events into one bar) and `needsTime` (drop records without a usable numeric `t`).
  Adding a future lane (e.g. `scroll`) is one entry here and nothing else.
- `laneFor(event)` — lane id for an event, or `null` when it is not drawn. `input`/`move` is
  excluded (no entry matches it); `ogd` records without a finite `t` return `null` rather than
  being drawn at 0.
- `posPct(t, dur)` — marker position as a percentage, clamped to 0..100, 0 for bad input.
- `laneConfigSource()` — serializes `LANE_CONFIG` (arrow predicates included, via
  `Function.prototype.toString`) into a source literal that gets inlined into the replay page, so
  the browser and the server share one definition without a build step or a new route.

### `src/adminui.mjs`
- Imports `LANE_CONFIG` / `laneConfigSource` and now **exports `replayPage`** so it is testable.
- Page relaid out to `body{flex-direction:column}`: a `#main` row holding the existing `#left`
  (video + `#bar` + `#scrub`) and `#right` (transcript / event pane), and a new `#strip` pinned
  full width across the bottom.
- `#strip` skeleton is server-rendered from `LANE_CONFIG`: one `.lane` row per entry with a
  left-aligned lowercase `.lanelabel` and an empty `.track` (`id="track-<id>"`, lane colour set
  once via inline `color` so markers can use `background:currentColor`). Plus a `#ph` playhead.
- `buildStrip()` fills the tracks: one pass over `data.events` bucketing by `laneFor`, then
  **one `innerHTML` write per lane** from a joined string — five DOM writes total, no per-marker
  element creation and no layout reads in the loop.
- Markers: `shape:'dot'` (clicks, ogd) and `shape:'tick'` (keys) are point markers positioned by
  `posPct(e.t, dur)`. `shape:'bar'` (dwell, wheel) also gets a width from `posPct(e[durKey], dur)`,
  floored at `dur/600` so a short burst stays visible and clipped at the right edge.
- Wheel bursts: `burst()` coalesces wheel events closer together than `burstGapMs` (400 ms) into a
  single bar spanning first→last. Generic — driven by the config field, not by the lane id.
- Sync: a shared `seek(t)` is used by the `#scrub` `input` handler and by a new click handler on
  `#strip` (maps click x against the first `.track` rect → timestamp → video seek). `render(t)`,
  already called every rAF from `tick()`, now also moves `#ph` via
  `left: calc(64px + (100% - 64px) * p)` — so video `timeupdate`/playback, scrubbing and lane
  clicks all drive the same playhead.
- Untouched: the right-hand transcript/event pane, the `.mark` click overlay on the video, the
  `input`/`move` skip, auth, `src/recorder.js` event shapes, storage formats.

### `test/replay-timeline.test.mjs` (new, 8 tests)
Server-observable assertions on the rendered string plus unit tests for the pure helpers:
lane strip container + labels in vertical order, per-lane track elements + playhead, config-driven
(not branch-driven) layout, percentage positioning and one-write-per-lane build, scrub/strip-click
seek wiring, regression on `<video id="v">` / `#scrub` / transcript pane / `.mark` / move-skip, and
`laneFor` / `posPct` unit coverage including the `ogd`-without-`t` and `move` exclusions.

## Test output

`node --test` (package.json's `npm test`) — all green, no existing test weakened or deleted:

```
✔ session lifecycle: start -> events -> video -> end summary (52.638032ms)
✔ admin sessions table and merged timeline (41.771011ms)
✔ login sets a cookie that authorizes admin routes (18.088061ms)
warning: ffmpeg not found — jsonl exported, frames skipped
✔ export-playtester emits the parent repo layout (38.553688ms)
✔ md renders paragraphs, bold, lists, and escapes html (0.980311ms)
✔ consent page renders campaign text; unknown slug 404s (68.708795ms)
✔ session page embeds the proxied game and the checklist (35.700293ms)
✔ game proxy injects the recorder and caches assets (41.980376ms)
✔ replay page renders the lane strip with labels in order (1.872514ms)
✔ each lane has its own track element and a playhead (0.147518ms)
✔ lanes come from one config array, not a per-lane branch chain (0.663092ms)
✔ markers are positioned by percentage and built in one write per lane (0.118895ms)
✔ scrubbing and lane clicks both seek (0.137689ms)
✔ existing replay affordances survive (0.135676ms)
✔ laneFor maps events to lanes (0.239883ms)
✔ posPct clamps to 0..100 (0.128212ms)
✔ healthz answers ok (47.650208ms)
✔ unknown routes 404 as json (6.672744ms)
✔ crc32 matches known vector (0.663763ms)
✔ buildZip output round-trips through system unzip (5.471868ms)
✔ campaign package.zip contains manifest and session files (73.329816ms)
ℹ tests 22
ℹ suites 0
ℹ pass 22
ℹ fail 0
```

`node --test test/*.test.mjs` gives the same 22 pass / 0 fail.

## Decisions and caveats

1. **`node --test test/` does not work on this machine** — it fails with
   `Cannot find module '.../test'` before loading any test file. This is environmental, not a
   regression: the same command fails identically in a scratch project containing one trivial
   passing test, under Node v25.8.1 (Node no longer expands a bare directory argument this way).
   `node --test` and `node --test test/*.test.mjs` both discover and pass all 22 tests. Nothing in
   this change affects it.

2. **The "no `if (lane === 'keys')` chain" assertion had to be scoped.** Asserting the literal
   absence of `if (…lane === '<id>')` across the whole page fails on *pre-existing* code the card
   explicitly requires me to keep: `if(e.lane==='clicks'){…}` builds the `.mark` click overlay on
   the video (requirement 3). So the test asserts two narrower, stronger things instead: the
   `buildStrip()` source contains **no lane-id string literal at all** (it only walks the config),
   and no `if (…lane === 'keys'|'wheel'|'dwell'|'ogd')` chain exists anywhere in the page or the
   module. That keeps the intent — layout is data-driven — without forcing the removal of the
   overlay branch.

3. **Config is inlined into the page, not imported by the browser.** Serving
   `src/replay-lanes.mjs` as a static module and `import`ing it client-side would avoid the
   `toString()` serialization, but it means a new public route and shipping server source to the
   browser. Inlining via `laneConfigSource()` keeps one definition, no build step, no new route.
   The client keeps a 2-line `laneFor` mirror over the shared config literal.

4. **Wheel bursts** are not in the recorded data as durations — `recorder.js` pushes one point
   event per wheel tick. Rather than change the recorder (out of scope), the strip coalesces runs
   closer than 400 ms into one bar. The threshold is a config field, so it is tunable per lane.

5. **`ogd` colour** is the green already used for OGD rows in the right-hand pane (`--ok`), for
   continuity between the two views.

6. Bars have a minimum drawn width of `dur/600` (≈0.17% of the strip) so a 300 ms dwell in a
   40-minute session is still visible.

7. Could not visually verify in a real browser: `playwright` is listed as a devDependency but is
   not installed in this worktree, and installing it would add a dependency step the card forbids.
   The generated client script is syntax-checked (`node --check` on the extracted `<script>` body)
   and the markup/CSS is asserted from the server-rendered string.

## ekPz0OiJ — Editable codebook table per campaign (2026-09-08)

Added an inline campaign codebook table for code, description, positive example,
negative example, and application usage count. Rows save independently, show errors
without discarding drafts, and distinguish `0 · unused` entries. Codes still originate
through the existing replay apply/reuse flow.

Authenticated PATCH/DELETE operations use the existing codebook model. Renames update
both keys and labels on all campaign timeline applications in one transaction; duplicate
labels are rejected. Deletion deliberately blocks applied codes (409) to preserve timeline
annotations, while unused codes can be deleted. Query parameters preserve freeform labels,
including slashes, Unicode, and dot segments.

Committed failing acceptance tests first in `6840af3` (86 pass, 5 fail). Final validation:
`npm test` — **93 tests, 93 pass, 0 fail, 0 skipped**. Coverage includes restart persistence,
rename propagation/reuse, usage counts, deletion protection, validation/auth/campaign scope,
and execution of the shipped table controls with a DOM adapter against real HTTP.
`git diff --check` passed. No merge or deployment performed.
