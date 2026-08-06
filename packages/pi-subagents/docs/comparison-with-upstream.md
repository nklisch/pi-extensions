# Comparison with upstream

`@nklisch/pi-subagents` is a maintained fork of `@gotgenes/pi-subagents`, which began as a hard fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents). This page explains which ideas this fork preserves, adapts, or leaves upstream.

The source tree was reviewed against `@gotgenes/pi-subagents` 19.2.1 and `@tintinweb/pi-subagents` 0.14.3 plus its unreleased changelog. The local package version remains independently managed; see [Fork maintenance](./FORK-MAINTENANCE.md) for provenance and release rules.

## Shared core

All three implementations provide in-process foreground and background agents, custom agent definitions, concurrency control, steering, result retrieval, session resume, model selection, thinking control, and completion notifications.

The direct `gotgenes` lineage and this fork also share a focused-core architecture:

- typed cross-extension service access;
- child-session lifecycle events;
- workspace and permission integration through companion packages;
- native read-only session transcripts;
- no built-in scheduling, memory, worktrees, or event RPC.

## What this fork preserves beyond direct upstream

This fork retains several contracts that must survive selective upstream ports:

- ordered lifecycle interception for prompt, result, and continuation decisions;
- exact `provider/id` and elapsed or final runtime on every operator status surface;
- a typed service and deterministic child-session lifecycle;
- only `general-purpose` and `Explore` as built-in agents;
- model runtime inheritance for runtime-registered providers and authentication;
- inherited extension tools through a registration-open denylist, with recursive orchestration tools excluded;
- provider terminal failures reported as failures instead of successful empty or stale results.

A mechanical rebase is unsafe because direct upstream may change or remove these surfaces.

## Reliability changes adapted from direct upstream

This fork selectively carries the useful 18.1–19.2 reliability work:

- queued and resumed runs are awaitable through the current record promise;
- interrupting `get_subagent_result(wait: true)` ends only the wait;
- queued stops follow the terminal lifecycle and state that no work started;
- consumption-aware retention keeps terminal records for the parent session while releasing heavy live sessions on separate consumed and unconsumed windows;
- completion notifications wait for the parent `agent_settled` boundary and recheck consumption;
- parent ESC abort-all behavior is configurable;
- resumed turns emit `subagents:resumed`;
- contradictory inherited cwd footer text is removed for workspace-backed children;
- terminal glyphs and XML escaping are safe across common terminal and structured-message contexts.

These changes require `@earendil-works/pi-coding-agent >=0.80.5`.

## Ideas adapted from the original upstream

The original `tintinweb` project remains the broader product laboratory. This fork adapted a narrow subset that fits its focused-core direction:

- final assistant `stopReason` classification for provider errors and empty output-limit failures;
- modern parent `ModelRuntime` forwarding;
- the `max` thinking level in model-facing and human-facing descriptions;
- optional fail-closed unknown-agent resolution;
- `.agents/agents` as a read-only shared project discovery tier.

## Capabilities intentionally left upstream

| Capability | `@tintinweb/pi-subagents` | This fork |
| --- | --- | --- |
| Nested subagent delegation | Available or under active development | Excluded; recursion remains disabled |
| Scheduling | Cron, interval, and one-shot jobs | Separate extension concern |
| Persistent agent memory | Built in | Excluded |
| Worktree isolation | Built in | Companion workspace provider |
| Tool permission policy | Built-in selectors and denylist | Companion permission layer plus built-in denylist |
| Fleet/editor UI | Broad agent management UI | Narrow widget, settings, and native transcript viewer |
| Cross-extension RPC | Event RPC | Typed service contract |
| Transcript opt-out | Sidecar output control | Not adopted; this fork uses official persisted Pi sessions |

These are product choices, not missing parity work. Adopting one requires a new architectural decision and a concrete consumer need.

## Choosing an implementation

Use `@tintinweb/pi-subagents` when you want a batteries-included extension with scheduling, memory, nested delegation, worktrees, and its full management UI.

Use `@gotgenes/pi-subagents` when you want the direct focused-core lineage without this fork's lifecycle interception and status-display guarantees.

Use `@nklisch/pi-subagents` when companion extensions need deterministic lifecycle decisions, inherited runtime and extension tooling, exact model/runtime visibility, and the selective reliability contracts described above.

Tool names and configuration are not drop-in portable across all three projects. Review agent definitions and orchestration prompts before switching packages.
