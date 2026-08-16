---
id: feature-staged-update-ownership-release
kind: feature
status: completed
tags: [defect, recovery]
parent: null
blocked_by: []
related_to: [backlog-recovery-owner-observability]
research_refs: []
mock_refs: []
created: 2026-08-16
updated: 2026-08-16
---

# Staged updates finalize on the next Pi start in any session

Automatic/sync-now updates staged with deferred activation kept
`owner_pid` = the staging process in the recovery journal, and startup
recovery in every other session defers on a live owner — so with concurrent
Pi sessions the update sat in "needs recovery; restart pi to finish it" until
the staging session exited (27+ hours in the reported incident), contradicting
SPEC.md's "activates on the next Pi start or reload".

## Outcome

The lifecycle service now releases journal ownership at both staged return
points (deferred activation; activation-unavailable). `ownerStatus` treats an
ownerless prepared row as adoptable ("released"), and `releaseOwnership`
only ever clears the releasing process's own rows, so immediate (mid-flight)
operations keep their owner fence. The next start of any session finalizes
the staged revision; rows staged by pre-0.3.6 versions still unlock only when
their stager exits. ARCHITECTURE.md's staged-updates paragraph records the
handoff; CHANGELOG v0.3.6 entry added; package bumped 0.3.4 → 0.3.6.

## Closure evidence

- `npm run check` (authoritative repo gate) green; pi-plugins suite
  347 files / 1804 tests green, typecheck and dependency boundaries clean.
- New regression tests at three seams: journal (`releaseOwnership`
  released/retained/missing/idempotent + foreign-owner fence), lifecycle
  service (release at both staged returns, none on immediate ops), and an
  integration reproduction (live stager → OWNER_LIVE deferral → deliberate
  handoff → fresh session finalizes and settles the journal `completed`).
- Fresh-context cross-model review (Kimi K3): no blockers or material
  findings; follow-ups parked in
  `backlog-recovery-owner-observability`.
