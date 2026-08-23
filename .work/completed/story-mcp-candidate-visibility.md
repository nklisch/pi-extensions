---
id: story-mcp-candidate-visibility
kind: story
status: completed
parent: null
created: 2026-08-22
completed: 2026-08-22
---

# Surface MCP candidate-attach failure instead of silent undefined (completed)

> Workbench version mismatch: stop and offer setup upgrade.

The isolated MCP candidate factory returns a structured outcome
(`verified` | `unavailable` with `PACKAGE_MISSING` / `PACKAGE_DRIFT` /
`PACKAGE_IMPORT_FAILED`, safe explanation, internal cause) instead of
swallowing every failure into `undefined`. The reason threads through
qualification into host status (`MCP_RUNTIME_UNAVAILABLE` degraded entry
when enabled plugins declare MCP servers; quiet when none do) and a doctor
finding with a sibling-update remediation hint. Contract tests cover
mismatch, import failure, healthy attach, and quiet no-MCP sessions.
Commit `23ff446`; root check green (1,522 tests).
