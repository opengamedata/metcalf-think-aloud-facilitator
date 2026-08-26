# metcalf-think-aloud-facilitator

Spin the think-aloud tool (`tools/cowatch.mjs`) out of ai-playtester into a
standalone, hosted research instrument. Researchers configure **campaigns**;
participants open a campaign URL in **their own browser**, consent, play the
game while narrating, and end with a summary screen. Every session is
replayable in an admin panel with a time slider synchronizing video, clicks,
utterances, checklist events, and Open Game Data (OGD) log traffic — and
downloadable as a package. ai-playtester consumes its sessions unchanged
through the existing `runs/human/` format.

End state: a new GitHub repo `metcalf-think-aloud-facilitator` and a Docker
image on fddatateam, published as
**https://metcalf-think-aloud-facilitator.opengamedata.io** through a
Cloudflare tunnel. The service binds **127.0.0.1:7900** (checked free on
fddatateam 2026-08-26; busy there: 8000, 8090–8097, 8765, 9443, 11434,
18xxx); cloudflared is owned by the researcher, outside this repo. The
tunnel terminates TLS at Cloudflare, so the app itself speaks plain HTTP on
localhost and no inbound firewall ports are needed at all.

## 1. The architectural shift that defines everything

cowatch works because Playwright owns the browser: `addInitScript` reaches
into the cross-origin game iframe, and a CDP screencast supplies frames. A
hosted tool has neither. The participant brings an ordinary Chrome, and the
game iframe is cross-origin, which means the parent page can see *nothing*
that happens inside it. Three capture problems, three answers:

### 1a. Input + OGD capture → same-origin reverse proxy with script injection

The server proxies the game: `/g/<sessionId>/...` streams the upstream game
(Field Day games are static hosting, so this is byte streaming plus a
rewritten base URL), and **injects a recorder script into HTML responses**.
Because the iframe is now same-origin, the recorder is a direct port of two
things we already have:

- the cowatch init script (pointerdown, keydown, wheel, sampled pointermove,
  350 ms dwell detection) — `tools/cowatch.mjs:242-266`
- the telemetry tap (monkey-patch `fetch`, `XMLHttpRequest`, `sendBeacon`
  before any page script runs) — `spike/telemetry.mjs` — which is how we
  count OGD log posts and sniff the **player code** from log payloads
  (`user_id`/`player_id` against the fielddaylab/opengamedata endpoints).

Events batch-post to the server every ~2 s and on `visibilitychange`.

**Risk:** a game whose loader fights the proxy (absolute URLs, integrity
hashes, service workers). Mitigation is the M1 spike against three real
Field Day games. Fallback for a hostile game: run the iframe direct and lose
click coordinates — the session still gets transcript, checklist, OGD counts
(via a `postMessage` hook the game team can add later), and video.

### 1b. Session video → `canvas.captureStream()` from the injected recorder

Same-origin means the recorder can find the game's `<canvas>` and call
`captureStream(10)` → `MediaRecorder` (video only — sound is *heard* but
never recorded, per spec) → 5 s chunks uploaded as they close, so a crash
costs seconds. Chunks are concatenated to `session.webm` at session end
(ffmpeg in the container). Fallback if captureStream misbehaves for a given
engine: `getDisplayMedia({preferCurrentTab})` — one extra permission prompt
in the consent flow, otherwise identical plumbing.

### 1c. Utterances → Web Speech API in the sidebar, exactly as cowatch does it

`webkitSpeechRecognition`, continuous + interim, finals posted with session
timestamps (`tools/cowatch.mjs:145-160` ports nearly verbatim). No audio
file is recorded. Hard constraints this imposes: **HTTPS is mandatory**
(secure context for mic — satisfied by the Cloudflare tunnel) and
**Chrome/Edge only** for participants — the consent page must detect and
say so plainly.

### Target participant device: a crappy Chromebook, zero installs

The design goal is stock Chrome on a low-end (possibly district-managed)
Chromebook. Everything above is in-browser APIs, so "no installs" holds by
construction; the open risks are CPU headroom (Unity WebGL + VP8 encoding
at once) and managed-device policy (mic blocked or hostname not
allowlisted by a district admin). Posture: measure in M1 on real hardware
and degrade gracefully — capture fps/resolution step-down, then a
periodic-JPEG-stills mode as the floor — rather than raising the device
bar.

## 2. Product surfaces

### Participant flow — `/c/<campaign-slug>`

1. **Instructions** — researcher-authored markdown.
2. **Consent** — researcher-authored text + a checkbox that gates the Start
   button; consent timestamp stored in `session.json`.
3. **Permission step** — mic prompt, status dots (mic / recorder / game),
   Chrome-only notice when needed.
4. **Session** — game left in a scaled iframe (audio allowed through
   `allow="autoplay"`; scale factor recorded like cowatch's
   `geometry.json`); sidebar right: live transcript with interim line,
   researcher-defined **checklist** (checks are timeline events), **Pause**
   (veils the game, suspends recognition + recorder, logs a mark), **End
   session** with confirm.
5. **Summary** — session length, utterance count, OGD logs sent, then the
   researcher's thank-you text.

### Admin panel — `/admin` (single researcher role, env-var password → HMAC cookie)

- **Campaign editor**: name, slug, game URL, instruction text, consent text,
  checklist items, thank-you text, options (video mode, prompt-for-player-code).
- **Sessions table** per campaign: player code, start date-time, duration,
  utterances, clicks, OGD logs, status; row click → replay.
- **Replay**: `session.webm` left with a time slider; right lanes for
  transcript / clicks / checklist / OGD marks that highlight in sync; click
  markers overlaid on the video at their recorded coordinates (scaled by the
  stored geometry).
- **Package download**: streamed zip of the whole campaign —
  `manifest.csv` + every session directory.

## 3. Stack and data

Node 22 (built-in `node:sqlite`, built-in fetch for the proxy), **no
framework, no build step** — same culture as the parent repo. Vanilla JS
front end; sidebar look ported from cowatch's token sheet. Playwright moves
from runtime dependency to **test harness**.

```
data/
  app.db                      # campaigns, session index, auth
  sessions/<slug>/<sessionId>/
    session.json              # campaign, url, game:{w,h}, scale, ua, consent, playerCode
    clicks.jsonl              # {n,t,x,y,beforeAgeMs?}   — parent-format compatible
    input.jsonl               # {t,kind:key|wheel|move|dwell,...}
    transcript.jsonl          # {t,text}
    ogd.jsonl                 # {t,url,bytes,playerCode?}
    checklist.jsonl           # {t,item,checked}
    marks.jsonl               # {t,kind:pause|resume|start|end}
    video/chunk-*.webm  ->  session.webm
    export/                   # playtester-format, generated on demand
```

One clock rule, frozen in CONTRACTS.md: all event `t` are ms since session
start on the client's monotonic clock; the start handshake stores the
server/client offset.

### ai-playtester integration

The contract is **data, not code**. `export --playtester` renders a session
into the exact `runs/human/<label>-<stamp>/` layout
(`evals/lib/human-session.mjs` is the reference reader): `session.json`
with `game:{w,h}`, `clicks.jsonl` with `beforeAgeMs`, `transcript.jsonl`,
`input.jsonl`, and `frames/cNNN-before.jpg`, `cNNN-after.jpg`, `tNNNN.jpg`
pulled from `session.webm` by timestamp with ffmpeg. Validation gate: the
parent's loader ingests an exported fixture session without modification.
The repo is then added as a submodule at `tools/metcalf` for convenience.

## 4. Development model — lesser models as workers

Three roles:

- **Architect** (frontier model, low volume): owns CONTRACTS.md, writes and
  splits task briefs, runs the M1 spikes' go/no-go, reviews every branch,
  merges. Nothing merges without an architect pass.
- **Workers** (mid-tier, e.g. Sonnet): one brief per session per branch.
  A brief is a self-contained `tasks/NN-name.md`: context, exact files,
  acceptance criteria, and the test command that must pass.
- **Helpers** (small, e.g. Haiku): fixtures, docs, CSS polish against the
  token sheet, test scaffolds, lint.

Rules that make mid-tier work reliable, learned from this repo:

1. **Contracts are frozen before workers start.** Schemas, routes, file
   formats live in CONTRACTS.md; a worker who needs a change files a note,
   never edits the contract.
2. **Every brief ships with an executable acceptance test** (`node --test`
   or a Playwright script). "Done" is the test passing, not the diff
   existing.
3. **A brief touches ≤ 3 files**; anything bigger the architect splits first.
4. **A golden fixture game** lives in `fixtures/game/` — a tiny static
   canvas game that emits fake OGD posts — so proxy, injection, capture,
   and replay are all CI-testable with zero external dependencies.
5. One branch per brief; CI runs unit + headless Playwright smoke of the
   full participant flow against the fixture game.

## 5. Milestones

**M0 — Scaffold + contracts** (architect, ~½ day)
Repo created (`gh repo create` — org TBD, see open questions), license, CI
workflow, CONTRACTS.md v1, token sheet, fixture-game brief. PLAN.md is this
document, moved.

**M1 — De-risk spikes** (architect + 1 worker, 1–2 days) — *gates everything*
- S1 proxy + injection against Wake and two other Field Day games: game
  plays cleanly, clicks + OGD taps captured.
- S2 `canvas.captureStream` → chunk upload → ffmpeg merge: replayable webm
  with accurate timestamps.
- S3 Web Speech on a plain HTTPS page (no Playwright in the loop).
- S4 the full trio (proxied game + captureStream + Web Speech) on a
  low-end Chromebook, ideally one with a managed school profile: measure
  CPU/frame health, pick the degradation ladder (fps → resolution →
  stills mode).
Each spike ends in a written go/fallback decision.

**M2 — Core server** (workers, parallel after contracts, ~5 briefs)
SQLite schema + migrations; campaign CRUD; session lifecycle
(start/end/summary); event ingest (batched jsonl append); chunk upload +
merge worker.

**M3 — Participant flow** (workers, ~4 briefs)
Instructions/consent/permission pages; session page (cowatch layout port);
checklist + pause/end; summary screen.

**M4 — Admin panel** (workers, ~4 briefs; parallel with M3)
Auth; campaign editor; sessions table; zip package + manifest.csv.

**M5 — Replay** (architect specs timeline model first, then ~3 briefs)
Merged-timeline data endpoint; replay page: video + slider + synced lanes +
coordinate-true click overlay.

**M6 — Deploy** (architect, ~½ day)
Dockerfile (node:22-slim + ffmpeg), compose publishing `127.0.0.1:7900`,
`data/` volume, deploy script, smoke test on fddatateam through
https://metcalf-think-aloud-facilitator.opengamedata.io, backup note. TLS
and the public hostname come from the researcher-managed Cloudflare
tunnel; no reverse proxy in this stack. (Cloudflare's ~100 MB per-request
cap is fine for 5 s video chunks; large Unity assets flow download-ward,
uncapped.)

**M7 — Parent integration** (worker, ~2 briefs)
`export --playtester` + ffmpeg frame extraction; validation against
`evals/lib/human-session.mjs`; submodule added to ai-playtester; README.

Estimate: ~2 calendar weeks with worker parallelism after M1.

## 6. Open questions (blocking only where marked)

1. ~~GitHub org~~ **Resolved 2026-08-26**: `opengamedata` org, public, MIT
   — matching org convention.
2. ~~DNS + firewall~~ **Resolved 2026-08-26**: Cloudflare tunnel →
   `metcalf-think-aloud-facilitator.opengamedata.io`, service on
   `127.0.0.1:7900`; researcher opens the tunnel.
3. ~~Chrome-only participants acceptable?~~ **Resolved 2026-08-26**:
   target is stock Chrome on low-end Chromebooks with zero installs;
   M1-S4 measures what works and sets the degradation ladder.
4. **Pause semantics** — clock keeps running and the interval is annotated
   (recommended; simpler and honest), or clock stops.
5. **IRB posture** — consent text is researcher-supplied; confirm storing
   UA string and player code is acceptable, and whether sessions need a
   researcher-facing delete.
