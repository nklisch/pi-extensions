---
release: prepared-packages-2026-08-18
date: 2026-08-18
packages:
  - "@nklisch/pi-clearance@0.2.4"
  - "@nklisch/pi-plugins@0.3.8"
  - "@nklisch/pi-enhanced@0.1.10"
items:
  - fix-restarted-session-subagent-tools
  - remove-windows-arm-clearance-target
---

# Prepared package release — 2026-08-18

## Pi Clearance 0.2.4

Clearance releases no longer allocate the Windows ARM runner or ship a Windows ARM64 native engine. Linux x64/ARM64, macOS x64/ARM64, and Windows x64 remain prebuilt and supported.

## Pi plugins 0.3.8

The bundled subagent extension now loads when Pi's peer modules live in the external host installation rather than beside pi-plugins. The Jiti bridge includes the public `@earendil-works/pi-ai/compat` subpath used by pi-subagents, preserving `subagent`, `get_subagent_result`, and `steer_subagent` across process restart.

## Pi enhanced 0.1.10

The aggregate package rebundles pi-plugins 0.3.8. Existing installations can refresh the one enhanced package rather than installing or coordinating pi-subagents separately.

## Compatibility and operations

- No subagent tool schema or service contract changes.
- pi-subagents and pi-mcp-adapter versions remain unchanged.
- Windows ARM64 hosts no longer receive a Clearance native engine; the extension reports the missing prebuild instead of attempting an install-time build.
- A packed-harness regression keeps Pi outside the candidate package tree, kills the first process, resumes the same persisted session, and verifies that all three subagent tools are registered and active in both processes.

## Verification

- `npm run check` passed for the package versions and loader fix before the release-only native-target adjustment.
- `npm run validate` passed after removing Windows ARM64 from the package manifest and CI/publish matrices.
- Packed pi-enhanced process-replacement regression
- Workbench validation
- Knowledge-index validation

Publishing uses the repository's trusted-publishing GitHub Actions workflow with five native targets. After publication, refresh the local `npm:@nklisch/pi-enhanced` installation and verify the active tool set.
