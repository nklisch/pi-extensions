---
id: backlog-mcp-programmatic-peer-resolution
kind: story
status: active
tags: [mcp, bug]
parent: null
blocked_by: []
related_to: [epic-plugin-lifecycle-simplification]
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# MCP gateway tool missing: programmatic adapter import fails outside jiti

> Workbench version mismatch: stop and offer setup upgrade.

## Symptom

No `mcp` tool in any pi session, so plugin-provided MCP servers (e.g.
krometrail) are unreachable even when the plugin is installed and enabled.

## Root cause (verified 2026-08-22)

pi-plugins' isolated MCP candidate
(`src/runtime/mcp/pi-mcp-adapter-package.ts`) probes the published
`@nklisch/pi-mcp-adapter` (shape check passes: installed 2.20.1-nklisch.1
matches the receipt) and then loads `dist/programmatic.js` with a **native**
`import()`. The programmatic entry's transitive graph reaches
`server-manager.ts` → `sampling-handler.ts`, which value-imports
`@earendil-works/pi-ai/compat`. pi resolves `@earendil-works/*` for extensions
through jiti aliases (`pi-coding-agent/dist/core/extensions/loader.js`
`getAliases()`); native ESM has no such alias and nothing resolvable under
`~/.pi/agent/npm/node_modules/@earendil-works/` (empty). The import throws,
`createVerifiedPiMcpRuntimeCandidate` swallows it and returns `undefined`, and
the session silently gets no MCP runtime — an invisible degrade with no
doctor/host-status signal.

Repo tests pass because pi-ai resolves from workspace node_modules there;
only the production install hits this.

## Status (2026-08-22)

FIXED in `pi-mcp-adapter` (commit 1669e1f, lazy dynamic import of pi-ai/compat
inside `handleSamplingRequest` + host-peer-cleanliness contract test; reviewed
glm-5.3, pass). Sessions need the fixed adapter published and installed.
Remaining: pi-plugins should surface candidate-attach failure as degraded host
status instead of silent `undefined` (option 3) — folded into
`epic-plugin-lifecycle-simplification` U4.

## Candidate fixes (choose at design time)

1. Make the programmatic entry host-peer-clean: defer `sampling-handler`
   loading behind the sampling code path or inject the host completion
   function via adapter options, so `dist/programmatic.js` never imports
   `@earendil-works/*` at module load.
2. Load the programmatic entry through pi's jiti (same alias table) instead
   of native `import()`.
3. Regardless: surface candidate-attach failure as a degraded host status /
   doctor finding instead of `undefined`-silence (same invisible-degrade
   class the lifecycle epic removes).

## Workaround in place

Symlinked pi's bundled `@earendil-works/{pi-ai,pi-tui,pi-agent-core,
pi-coding-agent}` into `~/.pi/agent/npm/node_modules/@earendil-works/`
(2026-08-22). Verified: probe verifies and `createMcpAdapter` imports. Fragile
— a pi npm reinstall may wipe the links; delete this paragraph when the real
fix ships.
