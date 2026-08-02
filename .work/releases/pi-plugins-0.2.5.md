---
version: pi-plugins-0.2.5
date: 2026-08-02
items: [staged-plugin-updates]
---

# pi-plugins 0.2.5

Plugin updates now converge on their own. With automatic updates on, eligible
updates install in the background and go live on the next Pi start — no
foreground gestures, no repeated confirmations.

## What changed

- **Background updates actually apply.** Previously the background scheduler
  could never install anything (no reload authority) and "update all" could
  install at most one plugin per run. Updates now stage: the new revision is
  committed immediately and activates on the next start or reload.
- **Update all is sync-now.** One gesture refreshes catalogs, stages every
  eligible update, prints one plain per-plugin summary ("workbench 0.4.0 →
  0.5.0 — updated; live on next start"), and offers a single optional reload.
  Per-plugin confirmation prompts are gone for policy-conformant updates;
  updates whose source or permissions changed still require approval and
  surface as "needs your approval" with the reason.
- **Results speak plainly.** Human surfaces no longer show internal command
  ids or raw outcome kinds. The post-reload successor screen and the
  activation-inventory read-out are replaced by one-line notifications;
  install success is a single sentence.
- **Staged vs. stuck is visible.** A plugin with an update waiting for next
  start reads "live next start"; one the startup sweep could not settle reads
  recovery-required.

## Fixes

- Startup recovery no longer rolls back committed updates: runtime
  reconstruction (now including committed pending candidates) runs before the
  recovery sweep, so interrupted or staged transitions finalize instead of
  being compensated into rollback.
- The control parser no longer drops `--explicit` on `updates automatic run`;
  manager update-all now runs with the intended intent. New `--mode
  stage|apply` option; `stage` is the default.
- Updates in non-interactive (RPC) contexts settle staged instead of rolling
  back when no reload authority exists.

## Compatibility and operations

- Envelope/result contracts change in place (project-owned): automatic-run
  outcomes gain `plugin`/`display` and a `staged` kind; lifecycle results gain
  a `staged` kind; the update-eligibility `awaiting-host-context` reason is
  retired (durable notices carrying it remain readable and are re-evaluated on
  the next cycle).
- Staged finalization assumes a Pi reload is a full host restart; noted in
  ARCHITECTURE.md.

## Verification

- `npm run check` green (1792 pi-plugins tests + workspace gates).
- Design and implementation each received one independent cross-model review
  (GLM-5.2); the implementation review's blocker (pending records excluded
  from runtime reconstruction) was fixed and covered by tests.
- The stage→restart→activate e2e golden is updated but not executed locally:
  the e2e harness cannot pack workspace bundles in this checkout (pre-existing
  harness issue; see backlog item test-typecheck-brand-cleanup).
