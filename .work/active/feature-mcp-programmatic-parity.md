---
id: feature-mcp-programmatic-parity
kind: feature
status: blocked
tags: [mcp, integration]
parent: epic-independent-mcp-modernization
blocked_by: [feature-mcp-agent-surface, feature-mcp-apps-modernization]
related_to: []
research_refs: [.research/briefs/independent-mcp-modernization.md]
mock_refs: []
created: 2026-08-06
updated: 2026-08-06
---

# Extend useful MCP surfaces to programmatic sources

Programmatic Plugin Host sources gain the useful modern agent and MCP Apps capabilities that can preserve exact source ownership, late launch-value custody, cancellation, runtime leases, approval and output bounds, redaction, and atomic replace/remove cleanup.

This feature evaluates each standalone surface rather than assuming parity. Static file discovery remains disabled. OAuth remains unavailable unless source-qualified credential custody and removal can be proven. Scripting remains unavailable unless it has an explicit source-qualified opt-in and complete call attribution. MCP Apps remain unavailable unless UI metadata, loopback hosting, session authority, and teardown can be qualified to the exact source.

Closure requires capability reporting to match actual behavior, no eager launch or UI listener, source-isolated cache/status/tool/UI identity, exact cleanup across replacement and removal, downstream Plugin Host conformance, packed-consumer acceptance, and standard-weight independent review. Surfaces that cannot meet those contracts remain honestly unavailable.

## Implementation evidence

Programmatic sources retain the compact cache-warmed prompt inventory and gain ranked paginated search plus server instructions. Exact schemas remain batched and schema-on-error remains concise in the transcript. Stale Streamable HTTP sessions reconnect once through fresh late launch values. Unsafe regexes are rejected.

Capability reporting remains honest: OAuth registrations are rejected before connection or credential access, and scripting and MCP Apps remain absent from programmatic composition. The packed Plugin Host contract and targeted runtime qualification pass.

## Sequencing

- `feature-mcp-agent-surface`: Its final discovery, approval, prompt, and scripting contracts determine which agent surfaces can safely cross the programmatic boundary.
- `feature-mcp-apps-modernization`: Its final UI hosting and authority model must be stable before source-qualified UI ownership can be designed.
