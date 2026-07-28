---
id: pi-legible
kind: feature
status: completed
tags: [feature, extension]
created: 2026-07-28
completed: 2026-07-28
---

New package @nklisch/pi-legible: rewrites finalized assistant prose through
a second model (message_end replacement) using STE-flavored default rules
(adapted from ASD-STE100 via tqbf's ste-writing skill), overridable per
project with LEGIBLE.md. The agent keeps full fidelity: originals are
stashed and restored via the context hook and spliced as clones into
compaction preparation. `/legible` command: on/off, model, depth (0-20),
tools on/off, rules, reload; config in ~/.pi/agent/pi-legible.json with
trusted-project override at .pi/pi-legible.json (untrusted projects:
global only). Safety: 30s timeout bounding auth + rewrite, fail-safe on
unresolvable configured model, textSignature stripped from displayed
rewrites, guarded restoration (exact-text match), 2000-entry stash.
47 tests; npm run check green. Two review rounds (gpt-5.6-sol), all
blocker/should-fix findings adjudicated and fixed.
