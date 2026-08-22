---
id: feature-degraded-runtime-repair
kind: feature
status: blocked
tags: [refactor, ux]
parent: epic-plugin-lifecycle-simplification
blocked_by: [feature-convergent-lifecycle-core]
related_to: [feature-convergent-lifecycle-core]
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# Degraded-state semantics and repair UX

## Outcome

A plugin whose selected revision fails to load is visibly degraded — with the
fall-back-to-previous-revision selection rule applied for that session — and
repairable through doctor and the manager UI. Every surface that today
presents `recovery-required` / `staged` / "needs recovery; restart pi" is
re-plumbed to the degraded/repair vocabulary.

## Boundary

Includes: uniform "fails to load" definition across skill/hook projection,
MCP launch, and subagent registration; mandatory fall-back selection rule;
degraded/blocked presentation in doctor, manager UI, update notices, and
result contracts (`native-lifecycle-operation*`, mutation dispatch, failure
presenter, trusted-install flow, project sync, automatic-update coordinator);
repair action (flip pointer back / re-materialize); tests.

Excludes: the core lifecycle rewrite and migration (parent sibling feature);
trust prompts.

## Sequencing

- `feature-convergent-lifecycle-core`: The core rewrite removes the
  statuses and result kinds this feature re-plumbs; doing it first prevents
  re-plumbing surfaces that are about to be deleted.

## Closure evidence

- A deliberately broken revision (e.g. corrupt skill file, failing MCP
  launch) shows degraded in doctor and the manager, falls back to the
  previous revision in-session, and offers a working repair path.
- No user-facing string or result kind references recovery, staged updates,
  or restart-to-finish.
