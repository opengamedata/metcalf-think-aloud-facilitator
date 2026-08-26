# Task briefs

One brief = one branch = one worker session. A brief is complete when its
**acceptance test passes**, not when the diff exists. Workers read
[CONTRACTS.md](../CONTRACTS.md) first and never edit it — a contract problem
goes in the brief's Notes section and the work stops there.

Brief format: Context → Files (≤ 3 without architect pre-split) → Acceptance →
Notes. Spike briefs (01–04) end in a written go/fallback decision instead of
code, recorded in `tasks/decisions.md`.
