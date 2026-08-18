---
release: prepared-packages-2026-08-17
date: 2026-08-17
packages:
  - "@nklisch/pi-enhanced@0.1.9"
  - "@nklisch/pi-mcp-adapter@2.20.1-nklisch.1"
  - "@nklisch/pi-plugins@0.3.7"
  - "@nklisch/pi-subagents@18.1.0-nklisch.1"
items:
  - epic-subagent-status-performance
  - feature-show-subagent-thinking-level
  - feature-subagent-long-session-responsiveness
  - feature-clearance-native-platform-coverage
  - feature-defang-filesystem-gate-class
  - feature-fix-clearance-postinstall-runtime
  - feature-staged-update-ownership-release
  - feature-investigate-antigravity-plugin-support
  - fix-background-wake-custom-message
  - mcp-gateway-discovery-redesign
---

# Prepared package release — 2026-08-17

## Pi subagents 18.1.0-nklisch.1

Every operator-facing subagent status pairs the exact effective thinking level with the exact model. Explicit, inherited, clamped, deferred-model, and `off` values remain consistent across foreground and background output, widgets, notifications, result and steering reports, and session navigation.

Long parent sessions no longer pay widget work proportional to all retained subagent history. The widget uses a lifecycle-fed read model bounded to active and briefly lingering records, refreshes at 500 ms instead of 80 ms, and stops animation when only static completion state remains. Pi core's full component-tree rendering remains a residual cost for extremely large parent transcripts.

## Pi plugins 0.3.7 and Pi MCP adapter 2.20.1-nklisch.1

Pi plugins bundles the synchronized subagent release and updates its exact package receipt. The MCP adapter receives a synchronized maintained-fork revision with no runtime behavior change, preserving the repository's three-package release invariant.

Previously completed Plugin Host outcomes consolidated into this release record include the 0.3.4 filesystem-gate correction and the 0.3.6 staged-update ownership handoff. The former removes operational fail-closed behavior on legitimate macOS and other hosts; the latter lets the next Pi session finish a deferred update without waiting for the staging process to exit. The earlier MCP gateway discovery redesign remains published in the adapter and bundled Plugin Host line.

## Pi enhanced 0.1.9

The aggregate package rebundles Pi plugins 0.3.7 and aligns its direct MCP adapter dependency with 2.20.1-nklisch.1, making the updated subagent status and responsiveness behavior available through the standard enhanced installation.

## Consolidated completed outcomes

This summary also closes the retained completion records for Clearance's source-based install behavior and six common native targets, background-task wake attribution, and the evidence-backed Antigravity plugin-support investigation. These outcomes were already delivered or were research-only; they do not add unpublished package versions to this workflow.

Compatibility notes:

- Subagent text and TUI status now include `thinking: <level>` wherever model identity appears.
- The Pi subagents service contract remains compatible; thinking-level state is internal to the operator presentation path.
- The MCP adapter synchronized revision contains no runtime or public-contract changes.
- Pi core's render complexity is unchanged.

## Verification

- `npm run check`
- Pi subagents: 66 test files, 977 tests
- Package typechecks, native build, workspace builds, tarball inspection, Workbench validation, and knowledge-index validation
- Standard cross-model review: no material findings

Publishing is performed separately through the repository's trusted-publishing GitHub Actions workflow. Add the workflow and registry receipts after publication succeeds.
