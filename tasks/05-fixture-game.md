# 05 · Fixture game for CI

**Goal:** a tiny static game in `fixtures/game/` so proxy, injection,
capture, and replay are CI-testable with zero external dependencies.

## Do
- `fixtures/game/index.html` + one JS file: a canvas "game" (~100 lines) with
  three clickable screens (menu → play → done), a moving element so video
  frames differ, and a fake OGD logger that POSTs
  `{app_id:"FIXTURE", user_id:"TESTCODE", events:[…]}` to a configurable
  endpoint every few seconds and on click.
- Deterministic given a seed in the query string.
- `test/fixture-game.test.mjs`: serve the fixture statically, assert the
  page loads and emits a log POST (plain fetch + a stub endpoint — no
  browser needed for this level; Playwright smoke comes with M2+).

## Acceptance
`npm test` green with the new test; the fixture plays by hand in a browser;
its OGD posts match `options.ogdUrlPattern` defaults in CONTRACTS.md §3.

## Notes
(worker findings here)
