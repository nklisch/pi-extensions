---
id: feature-convergent-lifecycle-core
kind: feature
status: active
tags: [refactor, recovery]
parent: epic-plugin-lifecycle-simplification
blocked_by: []
related_to: [feature-degraded-runtime-repair]
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# Convergent lifecycle core and state migration

## Outcome

The two-phase lifecycle machinery — transition journal DB, pending-transition
markers, reconciler, recovery service, owner fencing, activation-observation
settlement, generation mutation coordinator — is deleted and replaced by
single-transaction state mutations over immutable revision dirs plus an
idempotent startup convergence pass. Existing installs migrate forward in
place.

## Boundary

Includes: `plugin-lifecycle-service.ts` rewrite around short sqlite
transactions with expected-generation checks; deletion of
`recovery-service.ts`, `lifecycle-transition-reconciler.ts`,
`recovery-contract.ts`, `lifecycle-transition-store.ts`,
`sqlite-transition-journal.ts`, recovery adapters, process-identity fencing,
`reconcileLocal`; startup convergence (orphan GC with day-scale grace,
re-materialize-or-degrade on missing files); wiring the revision collection
service (or folding its job into convergence); one-time migration harvesting
pending-data-delete records, clearing `pendingTransition` markers via the
digest-verified codec, dropping journal/lease/retention DBs; corresponding
test deletion/rewrite.

Excludes: degraded-state semantics and repair UX (sibling feature); trust
verification; marketplace refresh policy.

## Closure evidence

- Lifecycle operations work end to end (install/enable/disable/update/
  uninstall, foreground and background automatic) with no journal writes.
- Kill-9 mid-operation leaves a convergent state (orphan GC or forward
  completion), never a wedge.
- Migration lands a real pre-change state directory (stuck journal rows
  included) into the new model with no `pendingTransition` remnants.
