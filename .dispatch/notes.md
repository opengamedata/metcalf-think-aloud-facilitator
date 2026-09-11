## yWCcMmz2 — Codebook data model + reuse-on-first-use [1 of 3]

Branch: `card-yWCcMmz2-codebook-data-model` (based on main faa94b5)

Persists a codebook per campaign so that using a code makes it reusable. The
codebook is built up by use, not pre-declared: applying a string that is not
already in the campaign's codebook mints the entry with blank
description/positive_example/negative_example; applying one that exists reuses
it. Uniqueness is per campaign, case-insensitive, on the trimmed string; the
stored `code` keeps the casing of its first use. Blank/whitespace-only (and
non-string) codes throw `INVALID_CODE` and store nothing.

Files touched:
- `src/codebook.mjs` (new) — `normalizeCode`, `codeKey`, `applyCode`
  (returns `{entry, created}`), `applyCodes`, `invalidCodeError`. Owns the
  reuse-on-first-use rule; no persistence details.
- `src/db.mjs` — new `codebook(slug, codeKey, code, description,
  positive_example, negative_example, createdAt, updatedAt)` table keyed
  `PRIMARY KEY (slug, codeKey)`; accessors `listCodebook`, `getCode`,
  `insertCode` (ON CONFLICT DO NOTHING), `updateCode`. `deleteCampaign` now
  cascades to that campaign's codebook rows so a reused slug starts empty.
- `test/codebook.test.mjs` (new) — 9 tests.

Out of scope by the card, deliberately not done: no HTTP routes, no timeline
UI (card 2), no editable table UI (card 3). Card 3 can wire `updateCode` and
`listCodebook` to routes; the reuse call site for card 2 is `applyCode`.

Tests: `npm test` → 39 pass / 0 fail (30 baseline on main + 9 new).

---

## N0Abs2n8 — Apply timecoded codes on the replay timeline [2 of 3]

Branch: `card-N0Abs2n8-timeline-codes` (based on `card-yWCcMmz2-codebook-data-model`)

A researcher can now attach a code to a point or a region of a session's replay
timeline. Card 1's `applyCode` is the reuse-on-first-use path — nothing about the
codebook rule was reimplemented here; typing a new code inline and picking an
existing one are literally the same request, and the response's `created` flag is
the only difference.

Files touched:
- `src/code-applications.mjs` (new) — `normalizeApplication` (validate/coerce;
  `INVALID_CODE` via card 1, `INVALID_TIME` for a non-numeric/negative `tStart`
  or a `tEnd` before it), `isRegion`, `applyCodeAt` (calls card 1's `applyCode`,
  then records the application, storing the codebook's label so casing of first
  use wins), `toTimelineEvent`.
- `src/db.mjs` — new `code_applications(id, slug, sessionId, codeKey, code,
  tStart, tEnd, createdAt)` table + index on `(sessionId, tStart, id)`; accessors
  `insertCodeApplication`, `getCodeApplication`, `listCodeApplications`.
  `tEnd IS NULL` is the point case. `deleteCampaign` cascades to it.
- `src/api.mjs` — `GET /api/admin/campaigns/:slug/codebook` (feeds the picker),
  `GET|POST /api/admin/sessions/:sessionId/codes`. The campaign is taken from the
  session row, never the body, so a code cannot land in another campaign's
  codebook. `GET .../timeline` now merges applications into the t-sorted `events`
  list as `lane:'codes'` events carrying `t` and `ms`.
- `src/replay-lanes.mjs` — one new `LANE_CONFIG` entry (`codes`, last), plus two
  optional generic config fields: `shapeFor` (per-event shape, so one lane holds
  both point dots and region bars) and `titleFor` (hover text). `buildStrip` stays
  config-driven and still never names a lane.
- `src/adminui.mjs` — `#codebar` in the strip: an `<input list=codelist>` backed by
  a `<datalist>` of the campaign's codebook (pick-or-type in one widget), `+ point`
  (applies at the playhead) and `+ region` (toggles to `end region`, applies
  min..max of the two marks). On success the application is appended to
  `data.events` and the list + strip rebuild in place; a newly created code
  refreshes the datalist. The event list build was extracted into `buildList()` so
  it can be rebuilt; the video click-overlay build stays one-time in `boot()`. The
  `#strip` scrub handler now ignores clicks inside `#codebar`.

Verified in a real browser (headless chromium, throwaway script, not committed):
picking from the datalist, typing an unseen code, `+ point` and `+ region` all
round-trip to SQLite; the codes lane draws beside clicks/keys/ogd; no page errors.

Out of scope by the card, deliberately not done: no edit or delete of an applied
code (apply only); no note/annotation field on an application; codes live in
SQLite only — they are NOT written to the session jsonl lanes and so are NOT in
`package.zip` or the ai-playtester export; no codebook management UI (card 3).
`CONTRACTS.md` was not edited; §2's route table does not yet list the two new
admin routes.

Tests: `npm test` → 56 pass / 0 fail (39 baseline + 9 in
`test/code-applications.test.mjs` + 8 in `test/timeline-codes.test.mjs`).
No existing assertion was weakened or removed.

---

## ybcxJgOz — Ability to delete a prior recording [tests]

Branch: `card-ybcxJgOz-ability-to-delete-a-prior-recording` (based on 3daf592).

Tests-only phase. No production code touched. `.dispatch/plan.md` records the
implementation plan (db `deleteSession`, `DELETE /api/admin/sessions/:id`,
per-row delete affordance + confirm dialog in the admin sessions table and the
replay page).

"A recording" = a session: a SQLite row (`src/db.mjs`) + its on-disk media
(`src/store.mjs` `sessionDir` — jsonl lanes + `session.webm`). List view is the
admin per-campaign sessions table (`src/adminui.mjs` `loadSessions`); playback
view is `replayPage`. No `deleteSession` and no `DELETE /api/admin/sessions/:id`
existed — verified the current `DELETE` returns 404 and leaves the recording in
place.

New file `test/session-delete.test.mjs` — 7 tests. All 7 FAIL on the baseline
(the DELETE route and the UI affordance/dialog do not exist yet):
1. `DELETE /api/admin/sessions/:id requires admin auth` — 401 unauth, recording
   untouched, AND an authenticated delete succeeds + 404s after (proves the gate
   is a real route, not a missing one). FAILS: authed delete currently 404.
2. `deleting a recording removes the row and its stored media, and it is gone
   after a refresh` — delete → row gone from the campaign list, fresh GET 404,
   on-disk session dir + `session.webm` removed, `db.getSession` null. FAILS:
   route missing.
3. `deleting is idempotent-safe and reports success on the first call` — first
   delete 200, second delete 404 (no corruption). FAILS: route missing.
4. `deleting the last remaining recording leaves an empty list` — list → `[]`
   (empty state). FAILS: route missing.
5. `a recording you cannot address is rejected and nothing changes` — owner
   delete succeeds (route exists); a foreign/unknown id → 404, real recording +
   its media untouched, list length unchanged. FAILS: owner delete currently 404.
6. `the sessions list ships a delete affordance and a confirm dialog` — `/admin`
   page has a per-row accessible `Delete recording` control + the "Delete this
   recording? … can't be undone." confirm dialog. FAILS: UI not built.
7. `the replay page exposes a delete control for the recording being played` —
   `replayPage` ships the same delete control + confirm dialog. FAILS: UI not built.

Baseline on this branch before the new file: **104 pass / 0 fail**.
After adding the file: full suite **111 tests, 104
pass / 7 fail** (all 7 failures are the new tests; zero existing assertions
weakened or removed).

## ybcxJgOz implementation (2026-09-11)
- `src/db.mjs`: added `db.deleteSession(id)` — deletes the session's
  `code_applications` rows then the `sessions` row (mirrors `deleteCampaign`).
- `src/api.mjs`: added `DELETE /api/admin/sessions/:id` inside the existing
  admin-gated block (401 unauthenticated via the shared `isAdmin` gate).
  404 for unknown id with no data change; otherwise `fs.rmSync` the session
  dir (lanes + session.webm), then `db.deleteSession`, returns
  `{ ok: true, sessionId }`. Second delete is 404 (row already gone).
  Read/create/force-end/flags/timeline/video routes untouched.
- `src/adminui.mjs`:
  - sessions table: per-row `🗑` button with `aria-label="Delete recording"`
    in the action cell next to the replay link; rows carry `data-sid`.
    New `#delDialog` (role=dialog, "Delete this recording? This can't be
    undone." + Cancel / destructive Delete). On confirm: DELETE, on success
    remove row optimistically, re-render "no sessions yet" empty state when
    none remain, toast "Recording deleted"; on failure keep row + error.
  - replay page: `#delRec` delete control (same aria-label) in the codebar
    right edge + identical `#delDialog`. On confirm: pause + clear the video
    (stopPlayback) first, then DELETE; on success navigate to /admin, on
    failure show the error.
- Full suite: **111 tests, 111 pass / 0 fail** (was 104/7; all 7 committed
  failing tests now green, no existing test touched).
