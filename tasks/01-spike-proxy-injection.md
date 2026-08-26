# 01 · Spike: same-origin proxy with recorder injection

**Question to answer:** can we proxy a Field Day game through this server,
inject a recorder script into its HTML, and capture clicks + OGD log posts —
with the game playing cleanly?

## Context
The whole architecture rests on this (PLAN.md §1a). The recorder ports two
proven pieces from ai-playtester: the input-capture init script
(`tools/cowatch.mjs:242-266`) and the fetch/XHR/sendBeacon tap
(`spike/telemetry.mjs`, top ~30 lines).

## Do
- `spike/proxy.mjs`: standalone server; `/g/*` streams
  `GAME_URL + path` (built-in fetch, stream body, drop hop-by-hop headers,
  strip CSP response headers), and for `text/html` responses injects
  `<script src="/recorder.js">` before `</head>`.
- `spike/recorder.js`: pointerdown/keydown/wheel capture + fetch/XHR/beacon
  tap matching `options.ogdUrlPattern`; events POST to `/spike-events`,
  printed to stdout.
- Test against three games: Wake
  (`https://fielddaylab.wisc.edu/play/wake/`), plus two more Field Day
  titles of different vintage.

## Acceptance
For each game, a hand-played minute produces: game visually/audibly normal;
≥ 5 clicks with sane coordinates; ≥ 1 OGD post logged with URL + byte size;
player code sniffed if the game emits one. Record per-game pass/fail and any
rewriting the proxy needed in `tasks/decisions.md`.

## Notes
(worker findings here)
