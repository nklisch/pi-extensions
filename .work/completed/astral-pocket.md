---
id: astral-pocket
kind: feature
completed: 2026-09-04
---

# pi-astral-pocket: dedicated note-taking pocket for gpt-6-astra

Delivered `@nklisch/pi-astral-pocket` (packages/pi-astral-pocket): a
model-gated extension active only for `openai-codex/gpt-6-astra`, providing a
persistent pocket store at `~/.pi/agent/astral-pocket/` with a `pocket_note`
write tool, a `pocket_recall` tool (notes + past astra sessions, summarized by
default), Codex-adapted usage guidance injected into the system prompt, a
bounded activation-time distiller pass (configurable cheap model, mechanical
floor on failure), and a `/pocket on|off|status` toggle command. 32 vitest
tests; repo `npm run check` green; inline light review pass completed with all
findings fixed (distiller/registry write race, unbounded note-body scan,
inactive-tool error signaling). pi-enhanced bundling intentionally left out of
scope.
