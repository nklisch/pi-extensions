---
id: feature-degraded-runtime-repair
kind: feature
status: completed
parent: epic-plugin-lifecycle-simplification
created: 2026-08-22
completed: 2026-08-22
---

# Degraded-state semantics and repair UX (completed)

A plugin whose selected revision fails to load is visibly degraded with
mandatory session-local fallback to the previous revision (the state pointer
never moves); repair (re-materialize, no state transaction) and rollback
(pointer flip preserving roll-forward) are wired through doctor, the manager
Health surface, and `/plugins repair|rollback` commands. Lifecycle results
are applied / live-next-start / degraded / current / rejected / stale;
`staged`, `rolled-back`, and `recovery-required` vocabulary is structurally
absent outside the migration's legacy decode. glm-5.3 final review
pass-with-revisions; both material findings fixed (startup MCP degradation
visibility, SPEC.md uninstall sentence). Delivered in U3 (`246d7c3`), U4
(`b5cd095`), U5 (`c85fdc7`), final fixes (`dad4e70`).
