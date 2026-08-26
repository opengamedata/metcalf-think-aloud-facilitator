# Spike decisions

## S1 · proxy + injection — **GO** (2026-08-26)

Tested against Wake, astrogame (Project Hercules), and Bloom, driven headless
by Playwright as the stand-in participant. All three boot and play through
the proxy; every asset failure observed was reproduced identically against
upstream (two genuinely missing `.ogg` files), i.e. zero proxy-caused
breakage.

Implementation facts the M2 proxy must keep:

- Mount the game at the session's root. Its relative asset URLs arrive as
  absolute paths, so **join request paths under the game's base directory**
  (`/Build/x` → `<gameBase>/Build/x`), with an origin-root retry on 404 for
  references that really meant the site root. Getting this wrong serves the
  host site's fallback page as JavaScript and the game never boots.
- Strip on the way back: `content-security-policy(-report-only)`,
  `x-frame-options`, `content-encoding`/`content-length` (fetch already
  decompressed), hop-by-hop headers.
- Inject the recorder as the **first script in `<head>`** so the fetch/XHR/
  beacon patch precedes every game script.

OGD findings:

- Live endpoint: `https://fieldday-web.wcer.wisc.edu/wsgi-bin/opengamedata.wsgi/…`
  — plain main-frame `fetch`, tapped successfully, **no CORS trouble** from
  the changed page origin.
- The match pattern must be host-strict
  (`opengamedata|ogdlogger|fieldday-web|log\.fielddaylab`) with an asset/
  analytics blocklist — a naive `/log/` matches "…-logo.png" and Google
  Analytics.
- **Player code arrives in the RESPONSE** of `GET …/player/`, not in a
  request body → the production recorder must also parse OGD responses
  (clone + JSON) to sniff it.
- Caveat: headless blind clicks only sometimes reach the screen that starts
  logging; a human minute through the tunnel is the final confirmation —
  folded into the S3 manual pass.

## S2 · canvas video — **GO** (2026-08-26)

- `canvas.captureStream(10)` + `MediaRecorder('video/webm')`, 5 s chunks:
  ~50–100 KB/s at 1280×800 across all three games. Fallback
  (`getDisplayMedia`) not needed on desktop Chrome.
- **Select the LARGEST canvas, and only once width ≥ 600** — helper scripts
  create decoy canvases (Wake: 300×150 from html2canvas) that a naive
  `querySelector('canvas')` grabs first.
- Merge = plain byte concat of chunks, **then `ffmpeg -c copy` remux**:
  streamed webm has no duration/cues, and the replay slider needs both.
  Verified in the deployed container: remux yields correct duration
  (146.4 s for a 150 s session) and `-ss` frame extraction produces crisp
  gameplay frames — which also validates the ai-playtester export path.

## S3 · Web Speech — **GO on desktop Chrome** (2026-08-26, researcher manual test)

- MacBook, outdoors, background noise: 9/9 utterances coherent and
  timestamped over ~65 s; background noise (roofers) correctly rejected;
  one macOS mic permission prompt.
- No punctuation in finals — expected from raw Web Speech; add an optional
  punctuation/cleanup pass at export time, not live.
- `onend` auto-restart works; the recognizer reports `aborted` when the
  page closes, which session teardown should treat as normal.
- Chromebook confirmation still pending (S4).

Two findings from the same manual pass, via /spike/play visits:

- **Same-origin false positive (fixed):** hosting on `opengamedata.io`
  made every same-origin asset request match the OGD pattern. The tap now
  ignores non-absolute URLs and anything on `location.origin` — only
  cross-origin traffic can be OGD.
- **Safari half-works, silently:** MediaRecorder claims `recording` but
  delivers zero webm chunks. The consent page's Chrome/Edge gate is
  load-bearing for video, not just speech — enforce it, don't just warn.

## S4 · Chromebook — provisional GO (2026-08-26); low-end device still pending

- Researcher played /spike/play through the production tunnel: "games feels
  great" on their hardware; a video chunk arrived through the tunnel from
  the live device (upload path proven outside localhost).
- Remaining: repeat /spike/speech + /spike/play on a low-end,
  district-managed Chromebook and pick the degradation ladder if needed.
- Spike-infrastructure lesson: /spike/status is in-memory and a redeploy
  mid-test wipes it — real sessions write to disk precisely so this class
  of loss cannot happen.
