# Maintained-fork policy

`@nklisch/pi-subagents` is a published MIT fork of `@gotgenes/pi-subagents`,
initially cut as `18.0.4-nklisch.0` from upstream base commit
`c76a294a777a990950da23fc06cb0caf51da7ac6`, whose package version is 18.0.3.
The fork version did not correspond to an upstream 18.0.4 release.
Since 2026-07 its home is the `nklisch/pi-extensions` monorepo
(`packages/pi-subagents`); earlier history lives in the `nklisch/pi-packages`
fork.

The fork retains upstream history, copyright notices, license, exports, and
package layout. Its intentional delta includes the documented ordered
lifecycle-interceptor provider seam (ADR 0005), exact model/runtime visibility,
and selected post-base reliability adaptations. It requires Pi coding-agent
`>=0.80.5` so completion nudges can synchronize on `agent_settled`.

## Release policy

Each fork release must:

1. selectively rebase or port current verified upstream changes, preserving the fork's lifecycle-interceptor and exact model/runtime contracts;
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

The published package keeps the narrow built-in background widget, session
navigator, and settings command accepted by ADR 0004. These status surfaces
show each subagent's exact effective model, exact effective thinking level, and elapsed or final runtime. The
package excludes the retired agent editors, wizards, and bespoke conversation
viewer from the import branch. Reviving those surfaces is a new decision, not
a restoration. Children inherit extension tools through a registration-open
denylist policy; scheduling, memory, nested delegation, worktrees, and RPC stay
outside the core.
