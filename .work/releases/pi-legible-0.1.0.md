---
version: 0.1.0
package: "@nklisch/pi-legible"
date: 2026-07-28
items: [pi-legible]
---

# pi-legible 0.1.0

Initial release of `@nklisch/pi-legible`.

## Outcomes

- **pi-legible** — assistant prose is rewritten by a second, configurable
  model for legibility once each message finishes streaming. The human sees
  the rewrite; the agent keeps the original text in its context, including
  through compaction. Rewrite rules default to STE-flavored Simplified
  Technical English (prose-only; code, paths, and errors kept verbatim) and
  are overridable with a project or global `LEGIBLE.md`.

## User-facing surface

- `/legible` — status, `on|off`, `model <spec>|default`, `depth <0–20>`,
  `tools on|off`, `rules`, `reload`.
- Config: `~/.pi/agent/pi-legible.json`; trusted projects may override at
  `.pi/pi-legible.json` (untrusted projects: global config/rules only).

## Operational notes

- Each rewrite adds one model call per assistant text block; a 30s timeout
  bounds auth + rewrite so a hung rewriter cannot stall the agent loop.
- Rewrite failures fail safe to the original text (one warning per session).
- Known limit: original-text stash is in-memory; after a session restore
  from disk, older rewritten messages are what the agent sees.
- First publish was local (no provenance); GitHub trusted publishing is now
  configured (`npm trust`, publish.yml, nklisch/pi-extensions), so future
  releases publish via CI with provenance.

## Verification

- 47 package tests; full `npm run check` green at 66d1e64.
- Two cross-model review rounds (gpt-5.6-sol); all blocker/should-fix
  findings fixed and verified.
- Published to npm as `@nklisch/pi-legible@0.1.0` (dist-tag `latest`).
