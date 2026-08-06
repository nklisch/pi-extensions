---
id: feature-mcp-apps-modernization
kind: feature
status: blocked
tags: [mcp, ui, security]
parent: epic-independent-mcp-modernization
blocked_by: [feature-mcp-core-modernization]
related_to: [feature-mcp-agent-surface]
research_refs: [.research/briefs/independent-mcp-modernization.md]
mock_refs: []
created: 2026-08-06
updated: 2026-08-06
---

# Modernize MCP Apps

The standalone adapter adopts the complete modern MCP Apps trust and interaction boundary: sandboxed provider documents, restrictive default content policy, separate resource and session authority, validated frame messages and context updates, model/app tool visibility, bounded context handoff, and usable local, remote-terminal, and narrow-viewer journeys.

The UI server remains loopback-only and starts only for an explicit UI-bearing tool call. No listener opens during extension or session startup. Programmatic Plugin Host calls remain UI-disabled until the programmatic-parity feature can preserve source identity and lifecycle ownership. This feature excludes a visual redesign beyond the upstream interaction improvements and excludes broadening network exposure.

Closure requires browser-inspected success, loading, error, completion, context-submission, narrow-viewer, and remote-opening journeys; authority-isolation and no-startup-listener tests; UI visibility policy; package checks; and standard-weight independent review. The upstream `app-bridge.bundle.js` is imported with its source and package provenance intact and verified through packed-artifact inspection.

## Implementation evidence

The integrated Apps boundary uses sandboxed provider documents, restrictive default content policy, separate resource/session tokens, host and frame validation, app/model tool visibility, bounded context handoff, remote-terminal guidance, and loopback-only per-call hosting. Compiled package assets now include the app bridge.

All UI and session tests pass. A live generated host shell was inspected in managed Chromium at desktop and responsive-small viewports; the sandbox badge, controls, provider iframe, narrow header flow, and touch-sized controls rendered correctly.

## Sequencing

- `feature-mcp-core-modernization`: Its manager, metadata, protocol, and runtime-ownership changes are prerequisites for safe UI session integration.
