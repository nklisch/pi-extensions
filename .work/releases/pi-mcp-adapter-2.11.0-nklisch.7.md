---
version: pi-mcp-adapter-2.11.0-nklisch.7
date: 2026-08-02
items: [integer-format-normalization, mcp-gateway-agent-ergonomics]
---

# pi-mcp-adapter 2.11.0-nklisch.7

The programmatic MCP gateway (`mcp`/`mcp_sources` tool) is now pleasant for
agents to drive. Servers answer to the name the status output shows, and tool
results no longer flood the session with unbounded payloads.

## What changed

- **Servers answer to their display name.** Status output shows
  `krometrail · mcp-server-v1:c7d3…`, but previously only the opaque key
  resolved, so calling by name failed with an unhelpful "isn't registered".
  Resolution is phased: an exact key match wins globally, a key-shaped token
  never falls back to names (a stale key still matches nothing), and
  otherwise a unique display-name match resolves. The `server` parameter
  description and failure text name the accepted tokens.
- **Call results pass through the output guard.** The gateway `call` action
  stringified the entire tool result — base64 screenshots included — into one
  unbounded text block. Text output is now capped with a temp-file spill,
  image blocks arrive as native image content, tool errors read as
  `Error: …` text, and result details stay bounded. This matches the proxy
  and direct-tool paths.
- **Earlier work bound to this release:** integer-format normalization
  (completed 2026-07-26, shipped in nklisch.5/.6) had no release summary.
  Schemars-style `int32`/`uint64` annotations are range-checked instead of
  flooding stderr with Ajv warnings or passing through silently.

## Compatibility and operations

- Programmatic gateway `call` result details change shape in place
  (project-owned surface): the raw result moves from `details` to
  `details.mcpResult`, matching the proxy/direct-tool contract. pi-plugins'
  integration helper was updated in the same change.
- Output guard defaults apply in programmatic mode (50 KiB / 2000 lines,
  16 KiB details budget); the `MCP_OUTPUT_GUARD` env kill switch still works.

## Verification

- `npm run check` green after the bump, including the pi-plugins provenance
  sync-invariant test (receipt version, dependency pin, and workspace version
  moved together to 2.11.0-nklisch.7).
- One independent cross-model review (GPT-5.6) of the gateway changes; both
  findings (exact-key/native-key capture, prototype-property shadowing) were
  fixed and pinned by regression tests.
