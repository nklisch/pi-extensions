---
id: backlog-recovery-owner-observability
kind: story
status: active
tags: [recovery, ux]
parent: null
blocked_by: []
related_to: [feature-staged-update-ownership-release]
research_refs: []
mock_refs: []
created: 2026-08-16
updated: 2026-08-16
---

# Surface why a pending transition is fenced (live owner identity) in Updates/Health

> Workbench version mismatch: stop and offer setup upgrade.

When startup recovery defers a pending transition because its journal owner is
live (`RECOVERY_OWNER_LIVE` / `OWNER_UNKNOWN`), the user-visible text says
"needs recovery; restart pi to finish it" with no hint that a *specific other
Pi session* holds the fence. After the staged-ownership release fix this only
affects immediate-path rows (seconds) and rows staged by pre-0.3.6 versions
(released only when their stager exits), so it is no longer a loop — but the
message still cannot explain a persistent case.

Smallest useful shape: thread the owning `pid`/start-time from
`ownerStatus` into the recovery result / inspection finding so the Health
screen can name the session. Evidence pointers:
`src/application/recovery-service.ts` (OWNER_LIVE deferral),
`src/application/ports/lifecycle-transition-store.ts` (`ownerStatus` returns
only a status string today), `src/application/native-automatic-run-presenter.ts`
("restart pi to finish it" line).

Also noted in the same review, one line each:

- npm carries `@nklisch/pi-plugins@0.3.5` with no repo version-bump commit or
  CHANGELOG entry (published ahead of the 0.3.4 tag, likely from the MCP
  runtime staging commit `a184947`); consider a backfill stub.
- Two concurrent fresh sessions adopting one released row can produce a
  transient `RECOVERY_CONFLICT` report in the losing session (pre-existing for
  owner-dead rows; journal stays correct). Cosmetic only.
