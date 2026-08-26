# metcalf-think-aloud-facilitator

A hosted think-aloud playtesting facilitator for [Open Game Data](https://opengamedata.io)
games. Researchers configure **campaigns**; participants open a campaign URL in
their own browser (target device: a stock Chromebook, zero installs), consent,
play the game while narrating, and finish on a summary screen. Sessions record
clicks, utterances (live speech-to-text — no audio files), checklist progress,
Open Game Data log traffic, and session video, all on one clock. Every session
is replayable with a time slider and downloadable as a campaign package.

Spun out of [ai-playtester](https://github.com/mrdavidgagnon)'s cowatch tool;
sessions export to ai-playtester's `runs/human/` format unchanged.

**Production:** https://metcalf-think-aloud-facilitator.opengamedata.io
(Cloudflare tunnel → fddatateam `127.0.0.1:7900`).

## Status

M0–M7 built and deployed: participant flow (`/c/<slug>` consent →
`/play/<id>` session → summary), proxied game recording (clicks, input, OGD
taps, canvas video), admin panel (`/admin`: campaigns, sessions table,
package.zip), synchronized replay (`/admin/replay/<id>`), and
`scripts/export-playtester.mjs` for ai-playtester's `runs/human/` format.
Spike results and open items: [tasks/decisions.md](tasks/decisions.md).
See [PLAN.md](PLAN.md) for architecture, [CONTRACTS.md](CONTRACTS.md) for
the frozen contracts. Deploy: `scripts/deploy.sh`.

## Development

Node ≥ 22.5 (built-in `node:sqlite`), no framework, no build step.

```bash
npm start        # serve on 127.0.0.1:7900 (PORT env to override)
npm test         # node --test
```

## Environment

| var | default | meaning |
|---|---|---|
| `PORT` | `7900` | listen port (loopback) |
| `DATA_DIR` | `./data` | campaigns db + session files |
| `ADMIN_PASSWORD` | — | required in production; gates `/admin` |
| `PUBLIC_ORIGIN` | `https://metcalf-think-aloud-facilitator.opengamedata.io` | absolute links |
