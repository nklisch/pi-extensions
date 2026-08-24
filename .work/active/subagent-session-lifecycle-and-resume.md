---
owner: workbench
status: active
created: 2026-08-24
package: packages/pi-subagents
---

# Close child sessions cleanly and serialize resume admission

## Request

Fix child `AgentSession` teardown so extensions receive `session_shutdown` before
Pi invalidates their context. Investigate and correct intermittent resume failures,
including misleading `Agent is already processing` outcomes after an agent appears
terminal.

## Grounded findings

- `SubagentSession.dispose()` currently calls `AgentSession.dispose()` directly.
  Pi's direct disposal invalidates the extension runner but does not emit
  `session_shutdown`; managed root-session replacement does emit and await it.
- Child extensions can therefore retain detached processes after child disposal.
  `pi-background-tasks` 0.1.7 contains their late callbacks, but cannot cancel work
  without the shutdown event.
- `Subagent.resume()` has no admission guard. It can call `AgentSession.prompt()`
  while an initial or resumed execution is still settling, and concurrent resume
  calls race each other. Pi then throws `Agent is already processing`.
- `Subagent.abort()` changes domain status to `stopped` before the underlying prompt
  necessarily settles. Status alone therefore cannot identify whether a new prompt
  is safe. Retention cleanup can also mistake this winding-down interval for idle.
- Pi exposes `AgentSession.isIdle`; the record additionally owns the current execution
  promise. Resume needs one record-owned reservation spanning any winding-down wait,
  Pi-idle wait, and the new turn.

## Delivery contract

- Every child teardown emits and awaits `session_shutdown` with reason `quit` before
  calling `AgentSession.dispose()` and publishing child `disposed`.
- Teardown is idempotent and never rejects because cleanup failures must not prevent
  context invalidation or registry cleanup.
- Parent session start/switch/shutdown and retention cleanup await child teardown;
  no record remains resumable once release begins.
- A resume request is admitted at most once. A genuinely active agent gets a clear,
  deterministic busy response without reaching Pi's prompt precondition.
- A terminal/stopped record whose prior prompt is only winding down waits for that
  execution and Pi's idle boundary before resuming, rather than failing spuriously.
- Resume reservations count as active for retention, abort, wait, and shutdown.
- Regression tests cover shutdown ordering, failure containment, idempotence,
  winding-down resume, concurrent resume rejection, and retention races.

## Verification

- Focused `pi-subagents` tests and typecheck/build.
- Repository `npm run check`.
- Different-model review of lifecycle ordering and resume concurrency.
