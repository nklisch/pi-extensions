---
id: epic-plugin-lifecycle-simplification
kind: epic
status: active
tags: [refactor, recovery]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# Replace the transactional plugin lifecycle with files-and-pointer convergence

## Outcome

pi-plugins lifecycle mutations (install, enable, disable, update, uninstall)
become ordinary short sqlite transactions over immutable, content-addressed
revision directories, with state as the sole authority and idempotent startup
convergence replacing the recovery journal, transition reconciler, owner
fencing, and activation-observation settlement proofs. "Recovery" stops being
a user-facing concept: there is no `prepared`/`staged`/`recovery-required`
status, no pending-transition marker, and no operation that can wedge a plugin
behind a live-but-hung session.

## Why (settled diagnosis, 2026-08-22)

- Pending transitions loop `recovery-required` forever when activation
  observation evidence is missing, even though reconstruction already runs the
  committed candidate (journal: workbench 12/12 completed, prose-craft 0/10,
  krometrail 0/4 — plugin evidence-gate luck, not health).
- A transition owned by a live-but-hung session wedges its plugin for days
  (`OWNER_LIVE` deferral, no override, no force-settle); krometrail was stuck
  this way behind pid 941165 since 2026-08-18.
- `RevisionCollectionService` is composed but never invoked
  (`create-packaged-plugin-host.ts:370`); one deferred sweep disables
  host-wide staging cleanup (`recovery-service.ts` gates on `!deferred`).
- The transaction model was a deliberate design that has failed three
  distinct ways; per `docs/PRINCIPLES.md`, after two rounds of the same
  breakage, remove the category, not the instance.

## Settled requirements and behavior deltas (accepted by user)

Target model:

1. Revision dirs immutable and content-addressed; staging dir → atomic rename.
2. One sqlite state authority; mutations are short `BEGIN IMMEDIATE`
   transactions with an expected-generation check between begin and commit
   (exact-conflict semantics preserved; explicitly NOT last-writer-wins).
3. State is authority; runtime reconstruction (already exists) activates
   whatever state points to. Startup convergence replaces recovery: orphan
   revision/staging dirs get time-graced GC (grace measured in days, longer
   than any realistic session lifetime, replacing live-session lease pinning);
   a pointer to missing/corrupt files is re-materialized or marked degraded.
4. Broken updates: mandatory local selection rule — if the selected revision
   fails to load, fall back to the previous revision for that session —
   replacing automatic rollback. Degraded plugins are visible and repairable
   (doctor + manager UI), not silently reverted.
5. One-time migration: harvest pending-data-delete records from the journal
   before dropping it (they exist nowhere else), clear `pendingTransition`
   markers through the digest-verified state codec, drop journal/lease/
   retention DBs. `pendingTransition` leaves `InstalledPluginRecordSchema`
   entirely — project-owned schema, no compat shims.

Named behavior deltas:

- **No session can block another session's lifecycle operations** (key user
  requirement, 2026-08-22). No journal fences, owner locks, durable leases, or
  pending markers may gate an install, update, enable, disable, or uninstall
  issued from any session. The only permitted cross-session coupling is the
  short sqlite write transaction itself (bounded by busy budget and released
  by the OS on process death) and transient CAS `stale` retries. Any design
  element that can durably block a foreign session's operation is a defect.
- No automatic rollback; a bad update is degraded-and-visible with the
  fall-back rule preserving self-healing across restarts.
- `recovery-required` / `staged` / "needs recovery; restart pi" states and
  messages disappear; replaced by degraded/blocked plugin states and repair
  actions.
- Interrupted operations complete forward or vanish (orphan-GC'd), never
  roll back.
- Uninstall persistent-data deletion becomes immediate-with-grace instead of
  journal-deferred.

## Boundary

In scope: pi-plugins lifecycle, state store, startup convergence, revision
GC, degraded-state semantics across skills/hooks/MCP/subagents runtimes,
doctor + manager UI + update-notice result plumbing, migration, tests, and
foundation docs (`packages/pi-plugins/docs/ARCHITECTURE.md`, `SPEC.md`,
CHANGELOG). Out of scope: trust verification and trust continuity (survives
untouched), marketplace catalog/refresh, MCP adapter internals, sibling
packages (no cross-package consumers of the deleted machinery — verified).

## Closure evidence

- Multi-session non-blocking: with one session mid-operation (or hung), a
  second session's install/update/enable/disable/uninstall completes within
  the busy/retry budget or returns a transient `stale`/`busy` rejection —
  never a durable block. Verified by an e2e that races two host processes
  and by structural absence of fences.
- `npm run check` green (validation, builds, typecheck, tests, pack
  inspection) with the recovery/journal test suites removed or rewritten.
- krometrail-class wedge is structurally impossible: no pending-transition
  marker exists to fence operations.
- Migration verified against a copy of a real pre-change plugin-host state
  directory (with stuck journal rows) landing in the converged model.
- Foundation docs reconciled; `backlog-recovery-owner-observability` closed
  as superseded.

## Execution

Design: dedicated fresh-context design agent (kimi k3), reviewed cross-model
(glm-5.3), per user direction 2026-08-22. Implementation: gpt-5.6 Luna xhigh.
Implementation review: kimi k3 / glm-5.3 fresh-context.
