# VISION — @nklisch/pi-subagents

A maintained MIT fork of the pi-subagents lineage (tintinweb → gotgenes)
whose reason to exist is one narrow, concrete seam: **ordered lifecycle
interception** (ADR 0005). Pi extensions can observe and shape subagent
prompts, results, and turn continuation in a deterministic registration
order — capability the observational lifecycle events cannot provide.

## Product shape

- A minimal core that owns configuration, model-runtime inheritance, sessions,
  tools, joined/detached delivery, queueing, concurrency,
  consumption-aware retention, workspaces, turn limits, runtime deadlines,
  cooperative stop/resume, and disposal.
- Extensions — including the fork's own interceptor seam — compose on that
  core rather than forking it (ADR 0002).
- Two public entrypoints only: the root service contract and `./settings`.
  The published type surface is a curated, rolled declaration bundle even
  though the package ships TypeScript source (ADR 0003).

## Consumers and compatibility

The root export is loaded by pi-plugins through a verified packaged loader;
its shape is a hard compatibility surface. The published package includes a
narrow built-in operator UI: the detached status widget, session navigator, and
settings command. Every subagent status surface identifies the exact effective
model, exact effective thinking level, active or final runtime, run id, delivery
mode, and terminal reason when one exists. Parent-only lifecycle tools are
centrally registered and removed from child tool definitions, preventing
recursive orchestration while preserving ordinary inherited extension tools.
The package excludes agent-definition editors, wizards, and a bespoke
conversation viewer; ADR 0004 defines the narrow operator UI contract.

## Fork posture

Track `gotgenes/pi-packages` and the original `tintinweb/pi-subagents` lineage
for releases and security reports; selectively port verified changes without
surrendering the fork's stronger contracts; contribute
the generic seam upstream when its contract is proven. Returning to
upstream must change package selection only, never lifecycle semantics or
consumer contracts. See `FORK-MAINTENANCE.md`.
