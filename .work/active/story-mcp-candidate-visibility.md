---
id: story-mcp-candidate-visibility
kind: story
status: active
tags: [mcp, ux]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# Surface MCP candidate-attach failure instead of silent undefined

> Workbench version mismatch: stop and offer setup upgrade.

## Outcome

When the isolated MCP runtime candidate fails to attach (probe unavailable,
package drift, import failure), the failure is visible: a structured
outcome replaces the silent `undefined`, threaded through runtime
qualification into host status (degraded) and a doctor finding with the
reason and a remediation hint. Successor to the fixed
`backlog-mcp-programmatic-peer-resolution` (adapter import crash itself
was fixed in `1669e1f`).

## Closure evidence

- Simulated attach failure (e.g. receipt version mismatch) produces a
  doctor finding and degraded host status naming the reason; a healthy
  attach reports ready.
