---
release: prepared-packages-2026-08-18
date: 2026-08-18
packages:
  - "@nklisch/pi-plugins@0.3.8"
  - "@nklisch/pi-enhanced@0.1.10"
items:
  - fix-restarted-session-subagent-tools
---

# Prepared package release — 2026-08-18

## Pi plugins 0.3.8

The bundled subagent extension now loads when Pi's peer modules live in the external host installation rather than beside pi-plugins. The Jiti bridge includes the public `@earendil-works/pi-ai/compat` subpath used by pi-subagents, preserving `subagent`, `get_subagent_result`, and `steer_subagent` across process restart.

## Pi enhanced 0.1.10

The aggregate package rebundles pi-plugins 0.3.8. Existing installations can refresh the one enhanced package rather than installing or coordinating pi-subagents separately.

## Compatibility and operations

- No subagent tool schema or service contract changes.
- pi-subagents and pi-mcp-adapter versions remain unchanged.
- A packed-harness regression keeps Pi outside the candidate package tree, kills the first process, resumes the same persisted session, and verifies that all three subagent tools are registered and active in both processes.

## Verification

- `npm run check`
- Packed pi-enhanced process-replacement regression
- Workbench validation
- Knowledge-index validation

Publishing uses the repository's trusted-publishing GitHub Actions workflow. After publication, refresh the local `npm:@nklisch/pi-enhanced` installation and verify the active tool set.
