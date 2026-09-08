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
