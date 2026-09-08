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
