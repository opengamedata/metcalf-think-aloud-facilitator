# CONTRACTS v1

Frozen interfaces every task brief builds against. **Workers do not edit this
file.** If a brief can't be completed inside these contracts, write the problem
into the brief's notes section and stop; the architect amends the contract.

## 1. The clock

Every event `t` is **milliseconds since session start, on the participant's
monotonic clock** (`performance.now()` anchored at session start). The start
handshake records `serverStartedAt` (wall time) and the client offset in
`session.json`; nothing downstream ever mixes wall time into event `t`.

## 2. HTTP routes

### Participant

| route | does |
|---|---|
| `GET /c/:slug` | instructions + consent page for a campaign |
| `POST /api/session/start` | body `{slug, consent: true, playerCode?}` → `{sessionId}`; sets a session cookie |
| `GET /play/:sessionId` | the session page (game iframe + sidebar) |
| `ANY /g/:sessionId/*` | reverse proxy to the campaign's game URL; injects `recorder.js` into HTML responses |
| `POST /api/s/:sessionId/events` | body `{events: [...]}` — batched, append-only (schemas §4) |
| `POST /api/s/:sessionId/video?seq=N&t=ms` | raw webm chunk body |
| `POST /api/s/:sessionId/end` | closes session → `{durationMs, utterances, clicks, ogdLogs}` |

### Admin (cookie from login; `ADMIN_PASSWORD` env)

| route | does |
|---|---|
| `POST /api/admin/login` | `{password}` → HMAC cookie |
| `GET/POST /api/admin/campaigns`, `GET/PUT/DELETE /api/admin/campaigns/:slug` | CRUD |
| `GET /api/admin/campaigns/:slug/sessions` | table rows (§5 index fields) |
| `GET /api/admin/sessions/:sessionId/timeline` | merged, t-sorted event list + video URL for replay |
| `GET /api/admin/campaigns/:slug/package.zip` | streamed zip: `manifest.csv` + session dirs |
| `GET /admin`, `GET /admin/replay/:sessionId` | panel pages |
| `GET /healthz` | `200 {"ok":true}` — no auth |

## 3. Campaign config

```json
{
  "slug": "wake-spring26",
  "name": "Wake — spring 2026 pilot",
  "gameUrl": "https://fielddaylab.wisc.edu/play/wake/",
  "game": { "w": 1280, "h": 800 },
  "instructionsMd": "…",
  "consentMd": "…",
  "checklist": [ { "id": "reach-helm", "label": "Reach the helm screen" } ],
  "thankyouMd": "…",
  "options": {
    "captureMode": "canvas",        // "canvas" | "display" | "stills"
    "promptPlayerCode": false,
    "ogdUrlPattern": "fielddaylab|opengamedata"
  }
}
```

## 4. Session directory

```
DATA_DIR/sessions/<slug>/<sessionId>/
  session.json        {sessionId, campaign, url, game:{w,h}, scale, ua,
                       serverStartedAt, consentAt, playerCode?, endedAt?,
                       counts:{utterances,clicks,ogdLogs}}
  clicks.jsonl        {n, t, x, y, beforeAgeMs?}
  input.jsonl         {t, kind:"key"|"wheel"|"move"|"dwell", ...}
  transcript.jsonl    {t, text}
  ogd.jsonl           {t, url, bytes, playerCode?}
  checklist.jsonl     {t, item, checked}
  marks.jsonl         {t, kind:"start"|"begin"|"pause"|"resume"|"end"}
                      plus {t, kind:"scale", scale} geometry annotations
  video/chunk-00001.webm …   → session.webm (merged at end; ffmpeg)
  export/             ai-playtester format, generated on demand
```

Event batch items are `{lane, ...record}` where `lane` names the jsonl file
(`clicks`, `input`, `transcript`, `ogd`, `checklist`, `marks`); the server
appends the record (without `lane`) to that file. Append-only, crash-safe:
a partial session is a valid session.

Click coordinates are in the game's own `game.w × game.h` space (CSS scaling
of the iframe does not change them); the display scale is stored in
`session.json.scale` for replay overlay math.

## 5. Session index (SQLite, `DATA_DIR/app.db`)

`campaigns(slug PK, json, createdAt, updatedAt)`
`sessions(sessionId PK, slug, startedAt, endedAt, durationMs, playerCode,
utterances, clicks, ogdLogs, status)` — status: `live | ended | abandoned`.
The jsonl files are the record; the index exists for the table view and is
rebuildable from disk.

## 6. ai-playtester export

`export/` reproduces `runs/human/<label>-<stamp>/` exactly as read by
ai-playtester `evals/lib/human-session.mjs`: `session.json` (with
`game:{w,h}`), `clicks.jsonl` (`beforeAgeMs` required), `input.jsonl`,
`transcript.jsonl`, `frames/cNNN-before.jpg` / `cNNN-after.jpg` /
`tNNNN.jpg` extracted from `session.webm` by timestamp. Validation: that
loader ingests an exported fixture session unmodified.

## 7. Ports & hosting

The app binds `127.0.0.1:${PORT}` (default **7900**), plain HTTP. TLS and the
public hostname (`metcalf-think-aloud-facilitator.opengamedata.io`) come from
a Cloudflare tunnel owned outside this repo. Video chunks stay ≤ 5 s so each
upload is far under Cloudflare's ~100 MB request cap.
