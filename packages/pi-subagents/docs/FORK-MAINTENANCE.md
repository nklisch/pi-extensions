# Maintained-fork policy

`@nklisch/pi-subagents` is a published MIT fork of `@gotgenes/pi-subagents`,
most recently cut as `18.0.4-nklisch.0` on the upstream 18.0.4 release
(upstream base commit `c76a294a777a990950da23fc06cb0caf51da7ac6` line).
Since 2026-07 its home is the `nklisch/pi-extensions` monorepo
(`packages/pi-subagents`); earlier history lives in the `nklisch/pi-packages`
fork.

The fork retains upstream history, copyright notices, license, exports, Pi
extension behavior, peer ranges, and package layout. Its intentional delta is
the documented ordered lifecycle-interceptor provider seam (ADR 0005) and its
tests.

## Release policy

Each fork release must:

1. rebase the narrow generic commits onto a current verified upstream release;
2. choose a `-nklisch.N` suffix on the upstream version it tracks;
3. capture registry integrity and tag/commit provenance;
4. run the package and consumer qualification suites (pi-plugins' bundled
   consumer is the primary downstream) on Node 24;
5. publish only through the monorepo's trusted-publishing workflow.

## Upstream relationship

Fork maintainers monitor `gotgenes/pi-packages` for subagent releases and
security reports. Contribute the generic interceptor seam upstream when the
proven contract is ready. Returning to upstream must change package selection
only, not lifecycle semantics or consumer contracts.

## Scope guard

The published package excludes the experimental UI layer that existed
mid-refactor on the import branch (agent editors, wizards, conversation
viewers). Reviving any UI direction is a new decision, not a restoration —
see ADR 0004 for the history.
