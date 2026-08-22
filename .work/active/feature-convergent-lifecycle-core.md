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

> Workbench version mismatch: stop and offer setup upgrade.

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

## Implementation review adjudication (2026-08-22, kimi k3, standard weight)

Verdict: pass-with-revisions. Core mechanism verified faithful to the design
(CAS window synchronous, consumers moved, migration trap avoided, deletions
complete, 1,498-test gate reproduced in a clean worktree). Five material
findings accepted, to be fixed in a follow-up unit before feature closure:

1. Convergence revision-prune must build the pruned list from the plan's
   fresh snapshot, not the sweep's pre-read (stale-content write under a
   fresh generation = the forbidden last-writer-wins).
2. Pending-delete replay must resolve scopes through inventory discovery;
   unknown/unreadable scope evidence means retain, never "plugin absent".
3. Artifact-GC referenced set must cover every discovered scope, not only
   the swept two; incomplete discovery retains the category.
4. BUSY exhaustion must surface as a typed `BUSY` rejection code, not
   `MALFORMED`.
5. Migration legacy-cleanup failures must be contained per-file into the
   report (deferred), never abort startup; same containment for sweep().

Minor notes accepted into the same unit: discard prepared candidates on
early returns, quiet age-gated marker retains (not failures), remove dead
`confirmed-uninstall-cleanup` export, collect projection `.staging` orphans,
add artifact-GC rule contract tests and the deferred-migration-scope test.
Stale `recovery` vocabulary in host-status/composition is U4's job.
Non-blocking follow-ups parked: fs-capability magic-number gate (third
fail-closed variant, pre-existing), trust-continuity grant fold-in, broker
ticket expiry, public-api surface pinning decision.
