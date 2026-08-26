# 03 · Spike: Web Speech on a plain hosted page

**Question to answer:** does continuous `webkitSpeechRecognition` behave on a
plain HTTPS page (no Playwright launching the browser) the way it does in
ai-playtester's cowatch — auto-restart on `onend`, interim results, usable
final segments?

## Do
- `spike/speech.html`: mic permission flow, continuous recognition with
  interim display, finals timestamped against `performance.now()`, status
  dots for mic/recognition state. Port from `tools/cowatch.mjs:145-160`.
- Serve through the tunnel (`127.0.0.1:7900` → production hostname) and
  test in desktop Chrome: 5 minutes of narration with deliberate silences.

## Acceptance
Recognition survives silence gaps and auto-restarts; ≥ 90% of spoken
sentences appear as finals; timestamps line up with a stopwatch within ~1 s.
Denied-mic and unsupported-browser paths show clear guidance. Findings in
`tasks/decisions.md`.

## Notes
(worker findings here)
