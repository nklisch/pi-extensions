---
id: feature-convergent-lifecycle-core
kind: feature
status: completed
parent: epic-plugin-lifecycle-simplification
created: 2026-08-22
completed: 2026-08-22
---

# Convergent lifecycle core and state migration (completed)

The two-phase lifecycle machinery (transition journal, reconciler, recovery
service, owner fencing, activation-observation settlement, mutation
coordinator, scheduler, scope locks) was deleted and replaced by single
`BEGIN IMMEDIATE` CAS commits via `runScopedMutation`, an idempotent startup
convergence sweep, and a one-time in-place state migration. ~17.9k lines
deleted. Migration verified against a real pre-change snapshot containing
five stuck transition markers (stripped, one generation bump, idempotent
rerun). kimi k3 review pass-with-revisions; all five material findings fixed
and re-verified. Delivered in branch commits U1 (`b985a79`), U2 (`9f9529c`),
hardening (`3d3c863`), final fixes (`dad4e70`).
