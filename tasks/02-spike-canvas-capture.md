# 02 · Spike: canvas captureStream → chunked upload → merged webm

**Question to answer:** does `canvas.captureStream(10)` on a Unity WebGL
canvas (reached same-origin via the 01 proxy) yield a replayable video
through 5 s MediaRecorder chunks, and does ffmpeg concat give accurate
timestamps?

## Do
- Extend `spike/recorder.js`: find the game canvas, `captureStream(10)` →
  `MediaRecorder` (`video/webm`, video only), `start(5000)`, POST each chunk
  to `/spike-video?seq=N`.
- `spike/merge.sh`: concat chunks with ffmpeg; verify duration within 2% of
  wall time and that a frame near a known click time shows the clicked
  screen.
- Also try the fallback once: `getDisplayMedia({preferCurrentTab})`.

## Acceptance
A 3-minute Wake session yields `session.webm` that plays end-to-end, correct
duration, no black frames after scene changes. Chunk sizes and CPU
observations recorded in `tasks/decisions.md`, with a canvas-vs-display
recommendation.

## Notes
(worker findings here)
