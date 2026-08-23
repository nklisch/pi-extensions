---
id: feature-extension-error-containment
kind: feature
status: active
tags: [reliability, refactor]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-23
updated: 2026-08-23
---

# Contain extension-originated failures

> Workbench version mismatch: stop and offer setup upgrade.

Every agent-callable tool and detached extension callback shipped by this repository contains its own operational failures instead of allowing an exception or rejection to terminate Pi. Failures are converted into the strongest recoverable signal available at that boundary: structured tool errors for agent calls, user-visible diagnostics for interactive callbacks, and durable/background status for asynchronous work.

The boundary includes all publishable extension packages under `packages/pi-*`, with the reported stale-context crash in `pi-background-tasks` as the required regression case. It includes shared containment abstractions where repeated boundary behavior warrants them and contract-level tests for synchronous throws, rejected promises, rendering/status failures, stale contexts, and process/event callbacks. It excludes changing product policy decisions, suppressing genuine process-level faults outside extension ownership, or masking successful results. The authorized finish line is publication of every changed package; because `pi-enhanced` bundles Background Tasks, its rebundled release is part of delivering the fix to the installation path that reproduced the crash.

Closure evidence:

- An inventory accounts for every registered tool, command/event handler, timer, process callback, and detached promise that can escape extension code into Pi or Node.
- Agent tool failures return or record actionable error details without throwing past the registered boundary whenever the host contract permits recovery.
- Background Tasks never reuses a stale Pi context after session replacement and never crashes Pi while surfacing completion or persistence failures.
- Package regressions and the authoritative `npm run check` gate pass.
- Independent review finds no uncontained extension-owned boundary in scope, and affected foundation assertions are reconciled.
- Changed packages are versioned, changelogged, packed, published through the repository's trusted-publishing workflow, and verified from the registry.

## Design readiness

The requested reliability rule is settled: extension-owned failures should degrade and remain observable rather than terminate the host. Repository contracts and existing host APIs determine the exact recovery channel per boundary. Audit findings may refine implementation placement but must not broaden the outcome into unrelated behavior changes.

## Boundary model

Pi owns and contains registered tool execution, slash commands, and awaited `pi.on` handlers. Tool throws remain tool errors because that is the agent-visible host contract. This feature adds containment only where control leaves that contract: timers, process and raw event-bus listeners, UI callbacks invoked later, detached promises, and multi-sink cleanup or reporting paths.

Session-bound objects are revocable capabilities. Detached work captures plain operation values and checks lifecycle ownership. Any reporting handle is lifecycle-owned. Shutdown revokes UI and Pi reporting access before it awaits resource cleanup. A late callback may settle plain state, but it cannot call the old context.

## Current evidence

- The Background Tasks regression now contains stale `appendEntry`, `sendMessage`, notification, status, child-process, and delayed-monitor failures. Its package suite passes 38 tests.
- The context footer contains detached timer and render failures and stops retrying after a presentation failure. Its package suite passes 17 tests.
- Clearance contains raw registration listeners, shutdown fan-out, native settings UI callbacks, hostile input snapshots, temp cleanup, transcript details, and native finalizers. Its focused tests and one repository `npm run check` pass.
- Plugin Host contains update startup, subagent disposal, process completion, manager timers and install phases, hook presentation, lifecycle cleanup, and failing diagnostic sinks. Its full suite passes 1,538 tests.
- MCP Adapter contains socket, callback-server, Apps watchdog, metadata listener, worker termination, delayed status, and secondary tool-failure paths. Its full Vitest suite passes 1,006 tests, and its OAuth/callback suite passes 114 tests.
- Model Modes, FFF compatibility, Legible, and Z.ai Research contain rejected messages, revoked finder initialization, stale rewrite status, and session cleanup. Their package suites pass 476, 6, 48, and 137 tests.
- Subagents contains detached session controls, timers, lifecycle and observer sinks, frontmatter, workspace, and child-session cleanup. An independent GLM 5.3 review found no contract drift or overbuilding; typecheck, declaration build, packed-consumer public types, and all 995 tests pass.
- Fresh-context GLM 5.3 reviews found no high- or medium-severity defects. Four low-severity observability and boundary-test findings in Plugin Host and FFF compatibility were fixed and requalified.
- The authoritative repository `npm run check` passes and packs all eleven release candidates at their intended versions.

## Execution approach

- **Boundary inventory and contract design** — map every extension entrypoint and escape-capable callback; classify each by recoverable reporting channel.
- **Background Tasks regression** — remove stale-context custody from detached completion and make persistence/notification failures non-throwing and observable.
- **Repository-wide containment** — harden remaining agent-callable tools and extension-owned asynchronous boundaries using cohesive package-local or shared helpers where justified.
- **Integration and qualification** — run package regressions, full repository qualification, independent review, foundation reconciliation, and Workbench closure.
