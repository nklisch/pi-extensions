---
id: feature-host-hardening-followups
kind: feature
status: active
tags: [cleanup]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# Host hardening follow-ups from the lifecycle epic

> Workbench version mismatch: stop and offer setup upgrade.

## Outcome

Three small hardening items parked during the lifecycle epic land together:

1. **Reload broker ticket expiry**: a wall-clock expiry (~2 min) on broker
   tickets so a successor that never fires `resources_discover` cannot hang
   the predecessor's wait (today bounded only by the abort signal).
2. **Trust-continuity grant fold-in**: the automatic-update continuity
   grant moves into the update's single state commit (design §2.1), removing
   the second post-update commit.
3. **Public API pinning**: a slim (~50-line) positive test pinning the
   package's intentional export surface (the deleted 1,056-line test was an
   implementation mirror; pack inspection only pins what must NOT ship).

## Closure evidence

- A broker ticket outliving its expiry settles as failed without abort.
- Update commits include the continuity grant in one transaction (or the
  deviation is recorded with reasoning in the design).
- The export-surface test fails when a public export is added or removed
  unintentionally.
