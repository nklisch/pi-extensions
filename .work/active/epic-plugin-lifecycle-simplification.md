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

> Workbench version mismatch: stop and offer setup upgrade.

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


---

## Design review adjudication (2026-08-22, glm-5.3 cross-model, standard weight)

Verdict: pass-with-revisions. All load-bearing claims verified against code;
multi-session non-blocking confirmed satisfied by deletion (only the
millisecond BEGIN IMMEDIATE window remains, fail-not-block with bounded busy
budget). All three material findings accepted and folded in:

- **M1 (accepted):** pending-delete markers are one file per marker under
  `cleanup/v1/pending-deletes/<scope-plugin-hash>.json`, created temp+atomic
  rename, removed via unlink — no shared read-modify-write file. The §5
  harvest uses the same discipline.
- **M2 (accepted):** convergence rule 1's discard of markers whose plugin is
  still installed is age-gated (discard only when `requestedAt` older than
  60 min); replay-if-absent stays immediate. Closes the TOCTOU that could
  orphan a confirmed deletion against a concurrent uninstall commit.
- **M3 (accepted):** the multi-session contract is pinned, not implied —
  (a) the store busy budget is named and BUSY-exhaustion maps to a typed
  retryable result ("another session is mid-write, retry"), never a raw
  sqlite error; (b) the transaction-window invariant (no I/O, no awaits, no
  recheck callbacks between BEGIN IMMEDIATE and COMMIT; `recheckAuthority`
  runs before begin) is a pinned contract with a test; (c) the same-session
  reload-broker rule: tickets are settled (publish/fail) on every path.

Minor notes accepted: §1 wording corrected (schemas are `.strict()` — safety
comes from migration-first ordering; a deferred-migration scope reads as
corrupt-degraded-recoverable, pinned in a migration test); U5 foundation list
gains three missed sentences (ARCHITECTURE.md session_start "performs
recovery", composition-ownership "recovery-artifact adapters", SPEC.md
uninstall "removes activation first, then cached revisions"). Non-blocking
follow-ups (WAL during migration, broker ticket expiry, refresh-claim bound
doc) parked, not scope.

# Design: Files-and-Pointer Convergence Lifecycle for pi-plugins

**Epic:** `epic-plugin-lifecycle-simplification` · **Features:** `feature-convergent-lifecycle-core`, `feature-degraded-runtime-repair` · **Status:** implementation-shaping design, no code written.

---

## 1. Outcome and constraints

**Outcome.** Every lifecycle mutation (install / update / enable / disable / uninstall) is exactly one short `BEGIN IMMEDIATE` sqlite transaction against the scope state DB, over immutable content-addressed revision directories. State is the only authority. Startup convergence (idempotent, bounded, grace-based) replaces the journal, reconciler, owner fencing, and activation-observation settlement. A broken revision is degraded-and-visible with a mandatory session-local fallback to the previous revision — never automatically rolled back, never wedged.

**Settled inputs (incorporated, not re-litigated):**

1. Expected-generation checks stay inside the single `BEGIN IMMEDIATE` transaction — exact-conflict, not last-writer-wins. All state families live in one scope DB (`state_blobs` keyed by `kind`, `sqlite-lifecycle-state-store.ts:112`), so installed+trust+config *can* commit atomically; the design makes that capability available and uses it where it deletes a second commit.
2. Mandatory fall-back-to-previous-revision when the selected revision fails to load — session-local, not a transaction.
3. Live-session lease pinning is deliberately replaced by day-scale orphan-GC grace (trade-off documented in §6 and §10).
4. Migration harvests `pending-data-delete` journal rows before dropping the journal DB, clears `pendingTransition` markers through the digest-verified canonical-JSON codec as a new generation per scope, and removes `pendingTransition` from `InstalledPluginRecordSchema`.

**Constraints from PRINCIPLES.md / CONVENTIONS.md:**

- Fail-closed guards need a named threat or they don't ship. Convergence GC is a *cleanup* policy, not a guard; it degrades (retains) on incomplete evidence, matching today's collection posture (`revision-collection-service.ts` returns `deferred` on any incomplete scan).
- Project-owned schemas change in place; no v1/v2 shims, no compat layers. Critical corollary discovered during study: the state codec **reinitializes** stale document versions to empty defaults (`codec.ts:694-699` — "clean cut-over … never migrated"). Therefore the migration must *not* bump `InstalledUserStateDocumentSchema` (currently literal 2, `installed-state.ts:213`) or `ProjectLocalStateDocument` versions in a way that trips cut-over — that would wipe every installed plugin. The field removal rides the *existing* schema versions, with legacy-tolerant decode confined to the migration module (§5).
- Tests earn their upkeep: recovery-machinery tests die with the machinery; replacements are contract-level (state CAS, convergence rules, migration fixtures, degraded propagation), not implementation mirrors.
- `npm run check` stays green or nearly-green between implementation units (§8).

---

## 2. Chosen approach

### 2.1 The one mechanism: `runScopedMutation`

Today there are three layered mutual-exclusion mechanisms: the in-process `KeyedMutationScheduler` (FIFO per scope+plugin), the cross-process `ScopeLockManager` (a second sqlite DB per scope under `locks/v1/`), and the store's own commit CAS (`sqlite-lifecycle-state-store.ts:412` returns `stale-generation`). The coordinator (`generation-mutation-coordinator.ts`, 427 lines) orchestrates all three plus commit-proof reconciliation (`provesMutationResult`, `MutationCleanupError`, `CommittedMutationCleanupError`).

**Design:** one mechanism. The sqlite state store's `commit` already is an atomic compare-and-swap inside `BEGIN IMMEDIATE`; two racing commits resolve as winner + `stale-generation`. On top of it, one application helper:

```text
runScopedMutation(store, scope, plan, signal):
  loop (max 4 attempts):
    snapshot ← store.read(scope)                 // validated, as today
    decision ← plan(snapshot)                    // pure: guard checks + build mutation | reject | no-op
    if decision is reject/no-op → return it
    result ← store.commit(decision.mutation)     // BEGIN IMMEDIATE; CAS on expectedGeneration
    if committed → return committed snapshot
    if stale-generation → continue               // re-read, re-plan
  return stale
```

`plan` is pure and synchronous over the snapshot — no I/O inside the transaction window. An optional `recheckAuthority` callback (project-trust revalidation, today's `beforeCommit`) runs immediately before each commit attempt. Bounded retries preserve exact-conflict semantics; contention on a single-user machine converges in one retry.

**This deletes** `generation-mutation-coordinator.ts`, `keyed-mutation-scheduler.ts` (application + infrastructure + `mutation-coordination.ts` + `ports/mutation-execution-context.ts`), `sqlite-scope-lock.ts`, `ports/scope-lock.ts`, and the `locks/v1/` DBs. All current `mutations.runPreparedMutation` consumers (lifecycle, host-precedence, hook-visibility, marketplace refresh, update notices, trust grants, revision pruning) move to the helper. *Rejected alternative:* keep the coordinator and lock for non-lifecycle services — that retains two exclusion mechanisms where one is provably sufficient (commit CAS + retry), and the lock manager's durable-lease family is the same category of machinery the epic removes. The marketplace-refresh claim owner (`refresh-claim-owner.ts`) is a different, working mechanism and is untouched.

**Multi-document commits.** `parseStateMutation` already accepts `replace: { installed, trust, config, ... }`. The helper exposes that; the automatic-update path folds the trust-continuity grant into the update commit (one commit instead of grant-then-commit). Interactive install keeps consent-grant before candidate preparation (the grant must exist for the trust check anyway), so no behavioral change there.

### 2.2 Mutation flow per operation (question A)

Shared shape — **all slow work before the transaction, one commit, activation after:**

```text
resolve → materialize staging → parse/normalize/compatibility → trust gate
  → prepare projection (private, sealed, READY) → promote staging → store
  (atomic rename; digest-addressed, so a racing promoter yields already-present)
  → runScopedMutation (guards + single commit)
  → activation attempt (below)
```

- **install**: guards = plugin absent. Commit writes the new `InstalledPluginRecord` (no marker, no journal). Trust consent and configuration custody remain pre-commit, exactly as today (the trust check inside candidate preparation rejects `UNTRUSTED`/`UNCONFIGURED` before any write).
- **update**: guards = plugin present, exact-target expectation (`LifecycleTargetExpectation`, minus its `pendingTransition: "none"` literal — the field disappears), automatic-update authorization when origin is `automatic-update` (unchanged logic, `plugin-lifecycle-service.ts` currently at the policy/authorization block). Commit writes `selectedRevision: candidate`, `previousRevision: old selected`, appended revision record, and — when continuity applies — the trust grant, in one transaction.
- **enable**: guards = plugin present + disabled; candidate projection prepared pre-commit (local, cheap; preserves the `PROJECTION_FAILED` rejection instead of discovering it as degraded post-commit). Commit flips `activation`.
- **disable**: commit flips `activation`. No preparation.
- **uninstall**: write the pending-delete marker **first** when `delete-confirmed` (§2.4), then commit record removal, then attempt data deletion inline. Revision dirs become unreferenced and are grace-GC'd by convergence; no state pruning needed at uninstall time.

**Activation after commit** (replaces reload-and-observe + settlement + rollback):

```text
if a reload-capable Pi context exists:
    open broker ticket(scope) → ctx.reload() → successor session_start
    successor reconstructs from state (state already points at the candidate)
    successor publishes an activation report (applied | degraded plugin list)
    → result: applied, or degraded (with the failure summary and repair hint)
else:
    → result: live-next-start
reload attempted and failed → live-next-start with note reload-failed
```

There is no observation-gated settlement and no rollback. A candidate that fails to load in the successor is *visible* as degraded in that session (the operation returns `degraded` when the successor reports it) and falls back to the previous revision in-session (§4). The reload broker (`pi-reload-broker.ts`) keeps its open/claim/publish/fail/wait mechanics; its payload changes from `ActivationObservation[]` (`pi-reload-broker.ts:18`) to a small `SuccessorActivationReport` (degraded entries only). `acceptSuccessor` stops reading the journal (`complete-plugin-reload.ts:159-167`) — the ticket carries scope only, and reconstruction reads state directly. `LifecycleReloadPort.observe` and `reconcileLocal` are deleted; the port shrinks to `reload(scope) → accepted | failed | unavailable`.

**Trust continuity** stays pre-commit/adjacent-to-commit: the automatic-update coordinator's `continuity.ensure` call currently runs after a committed apply (`automatic-update-coordinator.ts:234`); in the new flow the grant is computed during planning and included in the same commit. The "heal pre-existing revisions at each run" call stays as-is.

**Trusted-install UI flow without `install.recover`.** Today `install.recover` resumes a paused session whose configuration save or trust grant landed ambiguously (`trusted-install-service.ts:547-562`, the `pauseForWorkflowRecovery` machinery). With CAS commits there is no ambiguous mid-flight state: a commit either returned `committed` or threw, and re-running is idempotent (`already-recorded` grant path and `current-state`/`already-installed-different-revision` install paths already exist in `trusted-install-lifecycle.ts`). So: an interrupted trusted install expires by the existing session TTL (15 min idle / 1 h absolute, `native-lifecycle-operation-contract.ts:31-36`) and the user re-runs `install open` → `apply`. `install.recover` is removed from the command registry, and `TrustedInstallLifecycleResult`'s `recovery-required` kind and the session-resume machinery are deleted. *Rejected alternative:* keep a resume command "for safety" — there is no state left to resume; the command would be a no-op alias for re-apply and would preserve the vocabulary the epic bans.

### 2.3 Startup convergence (question B)

**Startup order (foreground, in `start()` of `create-packaged-plugin-host.ts`):**

1. **Migration** (§5) — first run only; afterwards it is three existence checks (no `recovery/` dir, no markers, no legacy fields) costing microseconds.
2. **Runtime reconstruction** (`reconcileCurrent` / `acceptSuccessor`) — reads state, builds the runtime, applies the fallback rule, produces the degraded list (§4). Unchanged in position; today's ordering rationale (reconstruction before settlement, `create-packaged-plugin-host.ts` comment at the `recovery.recover` call) becomes moot because there is no settlement.
3. **Convergence sweep** — one bounded pass replacing both the recovery sweep and the never-invoked collection service (`create-packaged-plugin-host.ts:370` composes `collection` and never calls it; `recovery-service.ts` gates staging cleanup on `!deferred` — both bugs die with the split).

**Convergence rules, in order.** All checks are `lstat`/`readdir`-only in the foreground — no content rehashing at startup. Budget knobs unchanged: 2 000 ms / 128 items (today's `DefaultLifecycleRecoveryPolicy`, `recovery-contract.ts:36-40`), grace constants below.

1. **Pending-delete markers** (`cleanup/v1/pending-deletes.json`): for each entry, if the plugin is absent from state → attempt data deletion; on success remove the marker entry; on failure retain and report. If the plugin is *still installed*, the marker is residue of a failed commit → remove it (the delete was never committed). Marker file is removed when empty.
2. **Orphan staging dirs** (`staging/v1/*`, projection staging): delete any slot whose directory mtime is older than `stagingGrace` (default 7 days). No owner sidecars, no process-identity probing — `staging-allocator.ts` stops writing `.owner` files and `classifyProcessIdentity` (`infrastructure/process/process-identity.ts`) loses its staging/journal/lease callers. Threat model honesty: the only thing the sidecar protected against was deleting an in-flight materialization; a 7-day mtime grace covers that with a wider margin than any real operation, and a process materializing into a deleted dir fails its own operation cleanly (rejected, retryable) rather than wedging anything.
3. **Orphan revision/marketplace/projection dirs**: compute the referenced set from every scope's state (marketplace snapshot refs, every revision record's store key, projection refs derivable from revision evidence — same derivation the collection service uses today, `revision-collection-service.ts:44-46`). Anything unreferenced with mtime older than `orphanGrace` (default 7 days, env override `PI_PLUGINS_CONVERGENCE_GRACE_DAYS`) is deleted via the existing prepared-tree removal path (`revision-artifact-store.ts`'s removal half is kept; its scan/report half is simplified). Incomplete evidence (a scope fails to read, a dir fails to inspect) → retain everything in that category, report `deferred`, try next start. This is the deliberate replacement for lease pinning: grace is measured in days, far longer than any realistic session.
4. **State revision pruning**: for each plugin record, revisions other than `selectedRevision` and `previousRevision` are pruned from the record in one convergence commit per scope (only when something prunes — no churn commits). The pruned revisions' dirs become orphans and are collected by rule 3 on a later pass. `previousRevision` is never pruned (it is the fallback target) even if its content is currently missing — repair (§4) can restore it.
5. **Pointer-to-missing-files**: detected during reconstruction (step 2 of startup), not by a separate scan — if the loader/projection for a selected revision fails, the plugin is degraded (§4). Convergence does not re-materialize on its own; repair is explicit via doctor/manager. (Automatic online re-materialization is parked, §11.)
6. **Orphan data dirs** (`data/v1/` entries with no installed record): **never auto-deleted** — keep-data uninstall intent is indistinguishable from abandonment without a marker. Surfaced as a doctor "leftover data" finding with an explicit delete action.

**Foreground vs background.** Migration, reconstruction, and the bounded sweep run in `session_start` (startup stays fast: stat-only, same 2 s/128 budget as today's sweep). If the budget exhausts, the remainder is rescheduled onto the existing background coordinator (`background-update-coordinator.ts` gains a convergence tick alongside update checks) and the next startup continues it — convergence is idempotent, so partial passes are safe. A daily-ish background re-sweep keeps long-lived sessions collected. *Rejected alternative:* all-background convergence — orphans and unharvested data deletions would linger until the first background tick, and startup would have no bounded self-healing story, regressing the current sweep contract.

### 2.4 Persistent-data deletion: marker-based, immediate-with-grace

Replaces journal-deferred deletion (`native-uninstall-cleanup.ts`, whose API is journal-row-shaped — it reads `retainedData`/`dataRef` from `LifecycleTransitionJournalEntry` rows). New mechanism, one tiny file + one tiny module:

- `cleanup/v1/pending-deletes.json`: `[{ scope, plugin, dataRef, requestedAt }]` (schema-validated, digest-optional — it is a work queue, not authority).
- Uninstall with `--delete-data`: write marker → commit removal → attempt deletion inline → remove marker entry on success. Marker-first closes the kill window: a kill between commit and inline delete leaves a marker that convergence rule 1 replays; a kill between marker-write and commit leaves a marker that rule 1 discards because the plugin is still installed.
- Migration (§5) harvests journal `pending-data-delete` rows into this file before dropping the journal DB — those rows exist nowhere else (epic requirement 5).

*Rejected alternative:* inline deletion without a marker — a kill in the commit→delete window silently loses a deletion the user explicitly confirmed, and doctor could not distinguish it from keep-data.

---

## 3. Degraded model (question C, feature `feature-degraded-runtime-repair`)

### 3.1 Uniform "fails to load"

One definition, evaluated per plugin during `buildRuntimeDesiredState` (`runtime-desired-state.ts`): **a revision fails to load when any surface that the plugin declares cannot be constructed from the revision's content and current runtime capabilities.** Concretely, per surface:

| Surface | Load failure |
|---|---|
| skill/hook projection | `installed.load` throws; projection `prepare`/`read` not `ready`; compatibility re-assessment not `activatable` (existing behavior, `runtime-desired-state.ts:140-145`); snapshot load fails in the skill/hook participant |
| MCP launch | MCP projection construction or source registration/validation fails during reconcile (`McpLifecycleReconcileResult` `failed`/`ambiguous`). Remote connect/auth/tool-discovery failures remain per-server *health*, not load failure — unchanged from today |
| subagent registration | required subagent capability unavailable or registration throws for a plugin declaring subagent hooks (already an incompatibility surface; now also a degraded trigger at load time) |

### 3.2 Fallback and where degraded lives

- **Fallback rule (mandatory, session-local):** when the selected revision fails to load and `previousRevision` is set, reconstruction attempts the previous revision. If it loads, the session runs the previous revision; if not (or absent), the plugin is inactive this session. Each new session tries the selected revision first — transient filesystem failures self-heal; a genuinely broken update stays degraded until repaired.
- **The pointer never changes.** `selectedRevision` in state stays on the broken revision. *Rejected alternative:* persist the fallback into state (auto-rollback by another name — a transient fs error would silently rewrite authority, and the epic explicitly wants degraded-and-visible, not silently reverted).
- **Degraded state is runtime-only.** Reconstruction returns `degraded: [{ plugin, scope, code, explanation, selectedRevision, runningRevision: previous | none }]` (extending today's `HostBlockedPlugin` list, `runtime-desired-state.ts:26-29`). Nothing is written to the state DB at startup. Doctor and the manager derive the same view at read time from the latest desired state plus an on-demand re-check — one derivation path, no second source of truth. *Rejected alternative:* a persisted `degraded` field — startup writes for runtime health would make the authority store track ephemeral conditions and reintroduce settle/clear transitions.

### 3.3 Repair actions

Two actions, both small, both surfaced identically in doctor (finding + suggested command) and the manager Health section (action rows):

1. **Repair (re-materialize).** `repair(scope, plugin)` on the lifecycle service: re-materialize the recorded source evidence for `selectedRevision` → verify the content digest still equals `selectedRevision` (source drift rejects with `AVAILABLE_REVISION_CHANGED` and points at `update`) → promote (idempotent rename) → reload. **No state transaction at all** when the pointer is already correct — the common case is missing/corrupt files under a correct pointer.
2. **Rollback (pointer flip).** `rollback(scope, plugin)`: one `runScopedMutation` setting `selectedRevision ← previousRevision`, `previousRevision ← (the broken revision, so roll-forward remains possible)`; then reload. New registry command `lifecycle.rollback` (`/plugins rollback <key> --scope …`); repair rides a new `/plugins repair <key>` (alias of the same application method). Disable/uninstall remain available as today.

A deliberately broken revision therefore shows: manager Health row "degraded — running previous revision" (or "not running"), doctor finding with both repair paths, and working `repair`/`rollback`.

---

## 4. Result contracts (question D)

Vocabulary target: **applied / live-next-start / degraded / current / rejected / stale** — `blocked` stays a readiness/inspection concept, not a lifecycle result.

### 4.1 `PluginLifecycleResult` (rewritten)

```text
applied          { operation, snapshot, activationReport? }
live-next-start  { operation, snapshot, note?: "no-reload-context" | "reload-failed" }
degraded         { operation, snapshot, failure: { plugin, code, explanation }, runningRevision }
current          { operation, snapshot }                       // was "unchanged"
rejected         { operation, code }                           // unchanged
stale            { operation, expected, actual }               // unchanged
```

Deleted kinds: `rolled-back`, `recovery-required`, `staged` (`plugin-lifecycle-service.ts:151-186`). Deleted rejection codes: `PENDING_TRANSITION` (no marker exists to conflict with). Deleted support types: `LifecycleActivationFailure`, `LifecycleCleanupIntent`, the `PendingTransitionRef` plumbing in results, `ActivationObservation`/`ProjectionExpectation` in *lifecycle result* positions (projection expectations remain as an internal preparation artifact).

### 4.2 Native result layer

- `NativeLifecycleOperationResultSchema` (`native-lifecycle-operation-contract.ts:200-240`): delete kinds `rolled-back`, `staged`, `recovery-required`; add `degraded` (fields: `failure` summary, `repairHint: "repair" | "rollback" | "both"`); `succeeded` gains `activation: "applied" | "live-next-start"`. Delete the `conflict` reason `pending-transition`; delete `transition: z.literal("none")` from `LifecycleTargetExpectationSchema`/`NativeLifecycleTargetBindingSchema`; progress phase `runtime-observation` deleted (`uninstall-cleanup` stays — marker + inline delete; `finalization` stays). `UninstallCleanupViewSchema.persistentData`: `"retained" | "deleted" | "pending"` (marker recorded, convergence will retry) — `recovery-required` gone.
- Session states (`NativeLifecycleOperationSessionStateSchema`): drop `rolled-back`, `recovery-required`, `staged`; add `degraded`.
- Update notices (`domain/update-policy.ts` + `native-update-contract.ts:161`): disposition `recovery-required` deleted; `automatic-applied` covers both applied and live-next-start (notice text gains "live next start" when applicable). Automatic-run outcome kinds: `staged` → `live-next-start`; `recovery-required` deleted (transient failures map to existing `retryable`; load failures map to `blocked` with reason `degraded`). `AutomaticUpdateEligibility` kind `recovery-required` deleted — it exists solely to gate on pending transitions (`automatic-update-coordinator.ts:94`, fed by `authority.recovery === "required"`, which disappears with the marker).
- Control envelope (`native-control-contract.ts:43,75`): status `recovery-required` removed from the enum and exit-class map; `partial`/`failed` cover the residue.
- Presenters/UI: `native-failure-presenter.ts` (`RECOVERY_REQUIRED`/`TRANSITION_PENDING`/`RECOVERY_BLOCKED` lines and `presentRecoveryRequired`), `native-automatic-run-presenter.ts:29-54`, `pi/native-control-human.ts:29`, `pi/manager/plugin-operation-view.ts` (the "setup didn't finish — restart pi" line), `pi/manager/plugin-manager-status.ts` (tone/clause entries) — all re-plumbed to degraded/repair language. Inspection views: `NativeLifecycleViewSchema.transition` (`native-inspection-contract.ts:173`) becomes `health: "none" | "degraded" | "fallback-active" | "blocked"`; `NativeActivationViewSchema.state` loses `pending`/`recovery-required`, gains `degraded`, and gains `runningRevision` when fallback is active. `native-installed-inspection.ts:83-88`'s `recoveryTransition()` (which reads `snapshot.recovery.results`) is replaced by a degraded-lookup over the desired-state snapshot.

---

## 5. Migration (question F)

**Module:** `src/infrastructure/state/lifecycle-convergence-migration.ts`, invoked from `createNodeLifecycleStateAdapters` before the stores open. Idempotent by construction — every step is detect-and-do; a completed migration is three cheap existence checks per startup. Per-scope isolation: one scope's failure never blocks another scope or startup; failures are collected into the startup result and doctor.

**Steps, per scope DB found in `state/v1/*.sqlite`:**

1. `BEGIN IMMEDIATE`; read `current_pointer` + the installed/project document blob.
2. Legacy-tolerant decode: parse the raw JSON, delete the `pendingTransition` key from any plugin record that has it (JSON-level removal, *before* schema parse — the shipped schema no longer contains the field, per settled input 4). **Do not bump document schema versions** — the codec reinitializes unknown versions to empty defaults (`codec.ts:694-699`), which would wipe installed state.
3. If any marker was stripped: re-encode the document through the current digest-verified canonical codec (digests recomputed by construction), write the new blob at `generation + 1`, update `generation_pointers`/`current_pointer`, commit. If nothing was stripped: no write, generation untouched.
4. Commit; close.

Semantic note: clearing the marker leaves the committed candidate as the selected record — exactly the "interrupted operations complete forward" rule, and reconstruction already activates whatever state points to. An interrupted uninstall (record still present, disabled, marker cleared) is simply an installed-disabled plugin; re-running remove finishes it. Nothing can wedge: there is no marker left to fence on.

**Then, once at host level:**

5. **Harvest** `recovery/journal/v1/*.sqlite`: for each row with `cleanup_status = 'pending-data-delete'` and `status = 'completed'` (schema: `lifecycle_transitions`, journal DB v2), decode `record_json` minimally (plugin, scope, `previous` revision's `dataRef`) and append to `cleanup/v1/pending-deletes.json` (deduped by journal `reference`). **Marker write precedes journal deletion**; if the marker write fails, that journal DB is retained and the harvest retries next start.
6. Delete: journal DBs, `recovery/leases/v1/`, `recovery/retention/v1/`, `locks/v1/`, `staging/v1/*.owner` sidecars, and the `recovery/` tree when empty. ENOENT is success. (The stray `.identity`/`.sqlite-root.identity` files visible on real disks are residue of the already-removed v0.2.4 identity guard; the migration deletes them opportunistically as part of the same sweep — tidying, not a guard.)
7. Convergence rule 1 then performs the harvested deletions on this or a later pass.

**Verification.** Contract tests build pre-change fixtures *without the old code*: raw SQL fixtures for the journal (3-table schema is small and known) and state DBs whose installed blob is produced by encoding with the current codec, injecting `pendingTransition` into the JSON, and recomputing the blob digest manually. Assertions: markers cleared; generation bumped exactly once; new blob verifies under the shipped codec; journal/lease/retention/lock DBs gone; harvest marker written; **re-run is a no-op** (idempotence pinned, per the fail-closed-testing rule). Epic closure additionally requires a run against a copy of the author's real pre-change `~/.pi/agent/plugin-host` (which currently contains stuck journal rows — e.g. the krometrail wedge); that is a scripted manual verification step in the implementation units, not a committed test (real data stays out of the repo).

---

## 6. Lease removal trade-off (settled input 3, documented)

Live-session revision pinning (`process-revision-leases.ts`, `create-skill-hook-runtime.ts:153-159` `replaceSessionLease`, `runtime/mcp/revision-lease-provider.ts`) is deleted and replaced by the 7-day orphan grace. Consequences, accepted deliberately:

- A session **older than the grace period** whose plugin was updated-and-collected could lose the on-disk projection/revision dir mid-session. Running MCP stdio processes hold inode handles on Linux and keep working; hooks re-read per execution and would fail on their next invocation. This requires a 7+-day-old session *and* an update *and* a completed GC — accepted.
- The `McpRuntimeLeaseProvider` port (sibling adapter contract) is kept but implemented as an **in-memory, validation-only** provider (binding verification retained, durable store gone), so the adapter's launch-time shape checks are unchanged. The `runtimeLeases` capability flag's semantics narrow to "launch-time binding validation available"; renaming/removing the flag is a sibling-package change and is parked (§11).
- Env override `PI_PLUGINS_CONVERGENCE_GRACE_DAYS` ships with the GC (operability escape hatch, per the guard rule's override requirement — the grace is a policy knob, and pinning behavior is its override surface).

---

## 7. Deletion map (question E)

### Delete outright (source)

| File | Why |
|---|---|
| `src/application/recovery-service.ts` | startup sweep replaced by convergence |
| `src/application/lifecycle-transition-reconciler.ts` | settlement/rollback deleted |
| `src/application/recovery-contract.ts` | classification vocabulary deleted (`stateWithoutPending`/`projectionMatchesObservation` die with it) |
| `src/application/revision-collection-service.ts` | folded into convergence (also fixes the composed-but-never-invoked bug by construction) |
| `src/application/native-uninstall-cleanup.ts` | journal-row-shaped; replaced by marker module (`src/application/pending-data-deletion.ts`) |
| `src/application/generation-mutation-coordinator.ts` + `keyed-mutation-scheduler.ts` + `mutation-coordination.ts` + `ports/mutation-execution-context.ts` + `ports/scope-lock.ts` | one mechanism: store CAS + `runScopedMutation` |
| `src/application/ports/lifecycle-transition-store.ts` + `ports/recovery-artifacts.ts` + `ports/revision-lease-store.ts` + `ports/revision-retention-store.ts` | ports of deleted machinery |
| `src/infrastructure/recovery/sqlite-transition-journal.ts`, `sqlite-revision-retention.ts`, `process-revision-leases.ts`, `recovery-artifact-scanner.ts`, `local-recovery-filesystem.ts`, `create-node-recovery-adapters.ts` | journal/retention/lease/owner-sidecar infrastructure; the directory itself disappears (migration computes legacy journal paths from `hostRoot` directly) |
| `src/infrastructure/state/sqlite-scope-lock.ts` + `infrastructure/state/keyed-mutation-scheduler.ts` | lock DB and scheduler adapters |
| `src/runtime/mcp/revision-lease-provider.ts` (durable version) | replaced by in-memory validation-only provider |

### Rewrite

| File | Shape after |
|---|---|
| `src/application/plugin-lifecycle-service.ts` (1042 lines) | ~350-400 lines: per-operation guards → `runScopedMutation` → activation attempt; no transitions/reconciler/observation |
| `src/application/ports/lifecycle-reload.ts` | `reload(scope) → accepted|failed|unavailable`; observation composition deleted (participant-level `observe` stays — used by inspection evidence, `native-inspection-evidence.ts:233`, `resource-discovery.ts:280`) |
| `src/composition/runtime-desired-state.ts` | drop `stripPendingTransition` (`:63-69`) and the override machinery; add fallback selection + `degraded` list |
| `src/composition/complete-plugin-reload.ts` | drop journal read in `acceptSuccessor`, expectation-override plumbing, observation map; broker payload becomes the successor activation report |
| `src/pi/pi-reload-broker.ts` | payload type change only |
| `src/infrastructure/recovery/revision-artifact-store.ts` → `src/infrastructure/convergence/artifact-gc.ts` | keep published-revision/projection inspection + removal; drop lease/retention coupling; new mtime-grace staging GC; new home since `infrastructure/recovery/` is gone |
| `src/infrastructure/state/sqlite-lifecycle-state-store.ts` | unchanged in behavior; gains the internal `BEGIN IMMEDIATE` read-check-write as the documented contract point (it already operates this way — the change is deleting the layers above it, plus dropping lock-root coupling if present) |
| `src/domain/state/installed-state.ts` | `pendingTransition` out of `InstalledPluginRecordSchema` and all constructors/verifiers; `previousRevision?: ContentDigest` in |
| `src/domain/state/references.ts` | `pendingTransition` tag and `PendingTransitionRef`/`derivePendingTransitionRef` removed |
| `src/application/plugin-lifecycle-contract.ts` | transition-ref derivation, `PENDING_TRANSITION` code, `rolledBack`/`recoveryRequired` outcomes, `LifecyclePluginStateSchema` removed |
| Result plumbing cluster (§4.2): `native-lifecycle-operation-contract.ts`, `native-lifecycle-result.ts`, `native-lifecycle-operation.ts`, `native-control-mutation-dispatch.ts`, `native-failure-presenter.ts`, `native-automatic-run-presenter.ts`, `native-control-contract.ts`, `native-update-contract.ts`, `native-inspection-contract.ts`, `native-installed-inspection.ts`, `native-lifecycle-update.ts`, `native-lifecycle-target.ts`, `automatic-update-coordinator.ts`, `automatic-update-eligibility.ts`, `automatic-update-lifecycle-adapter.ts` (composition), `project-sync-service.ts` (+planner/projection/state where they reference pending), `trusted-install-service.ts`, `trusted-install-lifecycle.ts`, `trusted-install-contract.ts`, `trusted-install-session.ts`, `host-status-service.ts` (`recovery:` field → `convergence:`), `native-control-service` registry (drop `install.recover`), `pi/native-control-human.ts`, `pi/manager/*` (status registry, operation view, controller/session/install-component references) | per §4 |
| `src/composition/create-packaged-plugin-host.ts` | startup = migration → reconstruction → bounded convergence; delete recovery/collection/journal/lock composition; wire convergence + background continuation tick |
| `src/composition/create-skill-hook-runtime.ts`, `create-mcp-runtime.ts` | lease wiring removed |
| `src/index.ts` | public surface loses deleted exports |

### Tests (die / rewrite / new), per "tests earn their upkeep"

- **Die:** `test/application/recovery-service`, `recovery-contract`, `lifecycle-transition-reconciler`, `generation-mutation-coordinator`, `revision-collection-service`, `native-uninstall-cleanup`; `test/infrastructure/recovery/*` (4 files); `test/integration/lifecycle-recovery`, `mcp-lifecycle-recovery`, `packaged-host-crash-recovery`, `packaged-host-startup-recovery`, `trusted-installation-recovery`, `recovery-review-hardening`, `revision-collection`, `bundle-reconciler` (if transition-bound); `test/e2e/chaos/lifecycle-crash-recovery`; transition/journal assertions inside `plugin-lifecycle-service.test.ts`, `complete-plugin-reload.test.ts`, `runtime-desired-state.test.ts`, `native-lifecycle-*`, `trusted-install-service.test.ts`, manager/presenter tests.
- **Rewrite (contract-level):** `plugin-lifecycle-service.test.ts` → single-transaction outcome matrix per operation (applied / live-next-start / current / rejected / stale, kill-9 between promote and commit → convergence completes forward); new `convergence-service.test.ts` (one test per rule, budget exhaustion, retain-on-incomplete-evidence); `state-transaction.test.ts` (CAS exact-conflict, bounded retry, multi-document commit); `lifecycle-convergence-migration.test.ts` (SQL fixtures, idempotence); runtime-desired-state fallback tests; degraded propagation through inspection/manager.
- **New e2e:** crash-convergence (kill mid-install/update/uninstall → next start converges; no wedge), degraded-update (broken revision → degraded visible, fallback runs, repair and rollback both work).
- **Kept:** everything orthogonal (format readers, acquisition, trust policy, codec, hook runtime, MCP participant contract tests, pack/provenance pinning tests).

---

## 8. Implementation units (question G)

Sequenced for one strong implementation agent; `npm run check` green or nearly-green after each. U1–U2 deliver `feature-convergent-lifecycle-core`; U3–U4 deliver `feature-degraded-runtime-repair` (respecting its `blocked_by`); U5 closes the epic.

**U1 — Transaction helper + migration module (additive only; no deletions).**
New: `src/application/state-transaction.ts` (`runScopedMutation`), `src/infrastructure/state/lifecycle-convergence-migration.ts` with its legacy-tolerant decode, `cleanup/v1` marker module. Wire the migration into `createNodeLifecycleStateAdapters` (it is a no-op against pre-change state until U2 removes the field from the shipped schema — the legacy decode tolerates both). *Not* changing the schema yet keeps every existing consumer compiling.
Tests: helper contract tests; migration SQL-fixture tests including idempotence. Risk: low (additive).

**U2 — Convergent core (the big cut; schema + lifecycle + infrastructure deletion together).**
Schema change (`pendingTransition` out, `previousRevision` in, references tag out), lifecycle-service rewrite, convergence service + artifact GC, deletion of the journal/reconciler/recovery/coordinator/scheduler/scope-lock/lease/retention cluster, composition rewiring (migration live, convergence in startup, background tick, collection bug gone), all non-lifecycle `mutations` consumers moved to the helper, `native-lifecycle-result.ts` mechanically re-mapped so the native layer compiles (deep presenter/UI language lands in U4). Staging allocator stops writing `.owner`.
Tests: suites in §7 die or are rewritten here. Green bar: full `npm run check`.
Why one unit: the schema field is referenced across lifecycle/recovery/inspection; splitting it from the lifecycle rewrite leaves the tree un-compilable. This is the irreducible cut; everything around it is staged to keep it small.

**U3 — Degraded runtime semantics.**
`runtime-desired-state.ts` fallback + degraded list; `complete-plugin-reload.ts`/broker payload reshape; skill-hook lease removal; MCP in-memory lease provider; subagent load-failure mapping; startup-result degradation wiring; `previousRevision` maintenance in update/uninstall paths.
Tests: fallback matrix (selected broken + previous good/missing/absent), degraded visibility at startup, reload-successor degraded reporting.

**U4 — Result contracts and UX.**
Native contract kinds, dispatch, presenters, notices, automatic coordinator/eligibility, trusted-install (drop `install.recover`, session-resume machinery, recovery-required kinds), project-sync plumbing, doctor findings + repair/rollback commands and registry rows, manager UI statuses/actions. SPEC registry table + documentation contract tests updated in the same unit (the table is mechanically checked).
Tests: contract-level presenter/dispatch/inspection rewrites; golden command-manager e2e updated.

**U5 — E2E, migration validation, foundation.**
Crash-convergence and degraded-update e2e; production `failure-recovery-drift` and `concurrency-presentation-security` suites rewritten; `packed-pi-consumer` expectations; scripted verification against a copy of the real pre-change state dir (incl. stuck journal rows); ARCHITECTURE.md / SPEC.md / CHANGELOG reconciliation (§10); close `backlog-recovery-owner-observability` as superseded.

---

## 9. Verification

- `npm run check` green at each unit boundary (validation, builds, typecheck, tests, pack inspection).
- Structural impossibility proof (epic closure): no `pendingTransition` field exists; grep-level invariant test asserting no source file references `pendingTransition`, `recovery-required`, `LifecycleTransitionStore`, or `install.recover` outside the migration module's legacy decode (whose fixture strings are the deliberate exception).
- Kill-9 matrix: mid-materialize (orphan staging → grace GC), post-promote/pre-commit (orphan revision → grace GC; state unchanged), post-commit/pre-reload (live-next-start; next start activates), mid-uninstall with `--delete-data` (marker replays deletion). Each lands converged; none wedges.
- Migration: fixture tests + real-dir copy run (U5), asserting the krometrail-class stuck state lands as an ordinary installed plugin with no markers.
- Startup perf: convergence sweep is stat-only with the existing 2 s/128 budget; a perf smoke assertion on a populated fixture dir (hundreds of revisions) guards the "startup stays fast" requirement.

## 10. Risks and recovery

| Risk | Handling |
|---|---|
| Lost confirmed data deletion in the marker-write→commit kill window | Marker written *before* commit; convergence discards markers for still-installed plugins and replays them for absent ones — both halves idempotent |
| Grace-GC deletes a dir a >7-day session still uses | Documented trade-off (§6); MCP stdio holds inodes on Linux; env override; sessions that old are already pathological |
| Concurrent promotion of the same digest | Content store `promote` already returns `already-present`; rename is atomic no-replace |
| Contention without the scheduler/lock | CAS + bounded retry (4) → `stale` result, identical to today's stale surface; single-user scale makes this rare |
| Fallback hides a bad update indefinitely | Degraded is visible in startup result, doctor, manager Health, and update notices; repair/rollback are one command each |
| Migration partially fails | Per-scope isolation; journal DB retained if its harvest marker wasn't written; every step re-runnable |
| Deleting the scope lock regresses cross-process config-custody guarantees | Configuration/trust writes move to the same CAS+retry helper with their existing `beforeCommit`-equivalent revalidation; correctness never depended on the lock, only on CAS |
| Schema-field removal trips codec cut-over | Explicitly avoided: no version bump (§5, `codec.ts:694-699` is the trap); pinned by migration fixture tests |

## 11. Foundation reconciliation (question H)

**ARCHITECTURE.md:**

- *"Installation transaction"* diagram + pending-transition bullet list (`resolve → … → write pending transition → reload → verify activation → finalize transition`) — **invalidated.** Replacement truth: a mutation is resolve → materialize → validate → trust → prepare projection → promote → one `BEGIN IMMEDIATE` commit with an expected-generation CAS → best-effort activation. There is no post-commit settlement; an interrupted operation completes forward (committed state activates next start) or vanishes (orphan GC).
- *"Staged updates"* (whole section) — **invalidated.** Replacement: automatic and update-all runs commit and report *live-next-start*; the next start or reload activates from state directly. There is no durable staged marker, no ownership handoff, no settlement.
- *"Revision retention and recovery"* (startup recovery steps 1–6) — **invalidated.** Replacement: startup runs migration (once), runtime reconstruction with session-local fallback, then a bounded convergence sweep: replay pending-delete markers, grace-GC orphan staging/revision/projection/marketplace dirs, prune non-selected/non-previous revision records, retain everything on incomplete evidence.
- *Concurrency* bullets for `KeyedMutationScheduler`, `ScopeLockManager`, `createGenerationMutationCoordinator` — **invalidated.** Replacement: one mechanism — the store's `BEGIN IMMEDIATE` compare-and-swap plus an application retry helper; no lock DBs, no scheduler, no commit-proof reconciliation because a CAS result is unambiguous.
- *"Derived runtime projections"* — the sentence "A projection hash participates in pending-transition verification and trust comparison" loses its first clause; trust comparison remains.
- *MCP adapter* — "runtime revision leases" and the lease-provider sentences — **invalidated.** Replacement: launch-time binding validation stays (in-memory provider); durable pinning is replaced by day-scale orphan-GC grace (trade-off documented).
- *Testing strategy / E2E* — "interrupted-transition recovery, multiprocess contention" becomes "crash convergence, multiprocess CAS contention".

**SPEC.md:**

- *State contract*: "Installed records carry activation intent and may carry only an opaque pending transition reference" → "Installed records carry activation intent and a `previousRevision` fallback pointer; no in-flight markers exist."
- *Install transaction* steps 9–12 + "Activation failure restores the prior active revision" → single commit; a revision that fails to load is degraded-and-visible with session-local fallback; repair/rollback are explicit actions.
- *"Automatic and sync-now updates are staged"* paragraph → committed, live-next-start; no staging concept.
- *Registry table*: `install.recover` row deleted; `lifecycle.rollback` and `lifecycle.repair` rows added; `updates.automatic.run --mode stage|apply` becomes `--mode apply|defer` (or drops the flag — implementation detail for U4; default stays background-apply-live-next-start).
- *Staging-ownership paragraph* ("Staging ownership uses a PID plus stable process-start evidence…") — **invalidated.** Replacement: staging slots are anonymous; orphan cleanup is mtime-grace only.
- *Acceptance criterion 15* ("interrupted-transition recovery") → "interrupted operations converge (forward-complete or orphan-collected) and never wedge"; criterion 7 ("Failed installation and activation preserve the working revision") → pre-commit failure leaves state untouched; post-commit load failure degrades with fallback.

## 12. Non-blocking follow-ups (parked, not in this epic)

- **Atomic install+trust+config single commit for interactive installs** — the helper supports multi-document replace; folding consent-grant into the install commit removes a second commit but reshapes the trust UI flow, so it stays out.
- **Automatic online re-materialization** of missing revision content as a background repair (requires network-policy and consent decisions; explicit repair ships first).
- **`runtimeLeases` capability rename/removal** in pi-mcp-adapter — sibling contract change, deliberately deferred.
- **Grace-aware hook execution** (detecting a collected hook path mid-very-old-session and rebuilding the projection on demand) — only matters past the 7-day grace.
- **Revision history beyond one previous** — the single `previousRevision` pointer is the settled fallback; a bounded history list is easy later if wanted.
- **Doctor-triggered deep verification** (full rehash of selected revisions on demand) — startup deliberately stays stat-only.

---

### Notes on evidence and judgment calls

- The three real-machine failure modes in the epic (evidence-gate loops, `OWNER_LIVE` wedges, dead collection service) are all structurally removed: no marker to gate on, no owner to fence on, one sweep that is always invoked.
- The one judgment call beyond the epic's explicit delete list is removing `sqlite-scope-lock.ts`/`locks/v1/` with the coordinator (the coordinator *is* named for deletion in `feature-convergent-lifecycle-core`, and the lock exists only to serve it). Rationale and rejected alternative are in §2.1; risk row in §10.
- Key file:line anchors used: `plugin-lifecycle-service.ts` (`runFirstCommit` pending-marker write, staged path), `recovery-service.ts` (OWNER_LIVE deferral, budget gating), `recovery-contract.ts:36-40` (2 s/128 budget), `create-packaged-plugin-host.ts:370` (dead collection service), `runtime-desired-state.ts:63-69` (`stripPendingTransition`), `codec.ts:694-699` (version cut-over reinitializes — the migration constraint), `automatic-update-coordinator.ts:94,175-182,234` (recovery gating, staged mapping, continuity), `native-lifecycle-operation-contract.ts:200-240` (result kinds), journal schema (`lifecycle_transitions.cleanup_status`, owner columns) from the live DB.