---
release: subagent-orchestration-2026-09-01
date: 2026-09-01
packages:
  - "@nklisch/pi-subagents@18.2.0-nklisch.0"
  - "@nklisch/pi-plugins@0.8.0"
  - "@nklisch/pi-enhanced@0.3.0"
items:
  - epic-subagent-orchestration-controls
  - feature-subagent-execution-control
  - feature-subagent-session-query
---

# Controllable and inspectable subagent orchestration

## Pi Subagents 18.2.0-nklisch.0

Subagent launch and resume now use explicit `joined` or `detached` delivery, with detached as the default. Both modes share FIFO concurrency admission and per-run active-runtime deadlines. Joined sibling calls continue to compose through Pi's native parallel tool execution.

Stopping is cooperative and truthful. Queued work settles immediately, while running work remains active until child execution, lifecycle callbacks, workspace teardown, output capture, and observers finish. Bounded stop calls report `stop_pending` rather than claiming process-level termination when child code has not cooperated.

Parents gain dedicated resume, stop, list, bounded result, and transcript-query tools. Terminal reasons distinguish normal completion, explicit stop, parent cancellation, timeout, turn limits, lifecycle abort, provider failure, execution failure, and teardown failure. One authoritative registry excludes parent orchestration tools from child sessions.

The native `/subagents:sessions` overlay now supports literal search, all/tool filtering, forward and reverse match navigation, stable selection during live updates, and retained-file fallback after a live child session is released. Parent transcript queries use the same stateless projection and JSONL parser, correlate tool results with their originating calls, and stay below Pi's byte and line output limits.

## Pi Plugins 0.8.0 and Pi Enhanced 0.3.0

Pi Plugins bundles the new Pi Subagents release and registers the complete parent orchestration surface through its production extension. Pi Enhanced rebundles Pi Plugins so bundled installations receive the redesign.

## Compatibility and migration

This is an intentional clean break. Tool calls and custom-agent frontmatter must replace `run_in_background: true` with `mode: detached` and `run_in_background: false` with `mode: joined`. Foreground/background public vocabulary, queue bypass, indefinite `get_subagent_result` waiting, and full-conversation result dumps are removed.

## Verification

- `@nklisch/pi-subagents`: 949 tests across 82 files, typecheck, declaration build, and packed public-type verification passed.
- The Pi Plugins production consumer contract passed against the compiled package.
- Repository `npm run check` passed after synchronized versioning.
- Fresh GLM-5.3 implementation review found no unresolved material issue after byte/line bounding and operator-navigation coverage corrections.
- The accepted transcript-search walkthrough and captured states are retained under `.mockups/screens/feature-subagent-session-query/`.
