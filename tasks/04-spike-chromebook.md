# 04 · Spike: the full trio on a low-end Chromebook

**Question to answer:** does proxied-game + captureStream + Web Speech run
acceptably on a cheap (ideally district-managed) Chromebook, and what is the
degradation ladder when it doesn't?

## Context
Target participant device is a stock Chromebook with zero installs
(PLAN.md §1c). Known risks: CPU (Unity WebGL + VP8 encode simultaneously)
and managed-device policy (mic blocked, hostname not allowlisted).

## Do
Run the combined 01+02+03 spike pages through the production tunnel on real
hardware. Measure: game frame feel (subjective + `requestAnimationFrame`
delta log), dropped video chunks, recognition latency. Then step down:
captureStream at 5 fps → half resolution → stills mode (periodic
`drawImage`+`toBlob` JPEG at 0.5 fps).

## Acceptance
A filled-in table in `tasks/decisions.md`: device model/specs × capture mode
× (game playable? video usable? speech working?), plus the chosen default
ladder and the policy blockers observed on a managed profile, if one was
available.

## Notes
(worker findings here)
