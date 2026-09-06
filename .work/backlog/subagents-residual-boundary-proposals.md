---
id: subagents-residual-boundary-proposals
tags: []
created: 2026-09-06
updated: 2026-09-06
---

# Reconsider residual subagent boundary proposals

## Supplied context

The former Phase 20 roadmap in `packages/pi-subagents/docs/architecture/architecture.md`
left five proposals without recorded completion. Preserve them as candidates, not
an implementation plan:

- Narrow terminal/theme render interfaces in `src/ui/agent-widget.ts` and
  `src/tools/agent-tool.ts` where broad SDK types obscure actual dependencies.
- Consider a shared numeric-settings flow in `src/ui/subagents-settings.ts` if
  repeated select/input/validate/apply branches still create maintenance cost.
- Separate notification line assembly from terminal integration in
  `src/observation/renderer.ts` if that boundary remains hard to test.
- Reconsider `SubagentStateInit` and `test/helpers/make-subagent.ts` together if
  fixtures still need mutation loops merely to seed metrics.
- Consolidate repeated test arrangement in spawn-config, manager, and session-config
  suites only where shared setup is clearer than local duplication.

Historical upstream issue references: [539](https://github.com/gotgenes/pi-packages/issues/539),
[540](https://github.com/gotgenes/pi-packages/issues/540),
[541](https://github.com/gotgenes/pi-packages/issues/541),
[542](https://github.com/gotgenes/pi-packages/issues/542), and
[543](https://github.com/gotgenes/pi-packages/issues/543).

## Limits

The findings and numerical complexity targets came from an older source tree and
have not been re-established. No implementation, readiness, priority, or sequencing
is approved. If revisited, first establish a concrete remaining maintenance cost;
do not revive generic abstractions, metric targets, or hide test actions to reduce
duplication. These personal-machine extensions have real npm consumers: preserve
public contracts and host stability while preferring existing Pi machinery.
