import { compareUtf8 } from "../domain/canonical-json.js";
import { MarketplaceRegistrationIdSchema } from "../domain/marketplace-registration.js";
import { ScopeContextSchema, type ScopeContext } from "../domain/state/scope.js";
import { MarketplaceRegistrationRecordSchema, UpdateNoticeIdSchema, UpdateNoticeSchema, type UpdateNotice, type UpdateNoticeId } from "../domain/update-policy.js";
import type { Sha256 } from "../domain/source.js";
import { AutomaticUpdateEligibilitySchema, type AutomaticUpdateEligibility, type AutomaticUpdateEligibilityReason } from "./automatic-update-eligibility.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import { createMarketplaceUpdateRecordsMutation, marketplaceUpdateRecords } from "./marketplace-update-state.js";
import { NativeAutomaticUpdateRunRequestSchema, NativeAutomaticUpdateRunResultSchema, type NativeAutomaticUpdateRunRequest, type NativeAutomaticUpdateRunResult } from "./native-update-contract.js";
import type { AutomaticUpdateLifecyclePort, AutomaticUpdateLifecycleResult } from "./ports/automatic-update-lifecycle.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { UpdateActivationContextPort } from "./ports/update-activation-context.js";
import type { UpdatePolicyAuthorityPort } from "./ports/update-policy-authority.js";
import type { GenerationSnapshot } from "./state-contract.js";
import { authorizeCurrentScope, type CurrentScopeAuthorityDependencies } from "./current-scope-authority.js";

const AUTOMATIC_RETRY_BASE_MS = 5 * 60_000;

export interface AutomaticUpdateCoordinator {
  evaluate(request: Readonly<{ noticeId: UpdateNoticeId }>, signal: AbortSignal): Promise<AutomaticUpdateEligibility>;
  run(request: NativeAutomaticUpdateRunRequest, signal: AbortSignal): Promise<NativeAutomaticUpdateRunResult>;
  nextRetryAt(signal: AbortSignal): Promise<number | undefined>;
}

export type AutomaticUpdateCoordinatorDependencies = Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  mutations: GenerationMutationCoordinator;
  policy: UpdatePolicyAuthorityPort;
  lifecycle: AutomaticUpdateLifecyclePort;
  activation: UpdateActivationContextPort;
  clock: LifecycleClock;
  sha256: Sha256;
}> & CurrentScopeAuthorityDependencies;

type LocatedNotice = Readonly<{ context: ScopeContext; snapshot: GenerationSnapshot; notice: UpdateNotice }>;

export function createAutomaticUpdateCoordinator(dependencies: AutomaticUpdateCoordinatorDependencies): AutomaticUpdateCoordinator {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("automatic update coordinator dependencies are required");

  async function authorized(context: ScopeContext, signal: AbortSignal): Promise<boolean> {
    return (await authorizeCurrentScope(context, dependencies, signal)).kind === "trusted";
  }

  async function contexts(signal: AbortSignal): Promise<readonly ScopeContext[]> {
    const inventory = await dependencies.inventory.discover(signal);
    const contexts: ScopeContext[] = [];
    for (const value of inventory.scopes) {
      const context = ScopeContextSchema.parse(value);
      if (await authorized(context, signal)) contexts.push(context);
    }
    return contexts;
  }

  async function locate(idInput: UpdateNoticeId, signal: AbortSignal): Promise<LocatedNotice | undefined> {
    const id = UpdateNoticeIdSchema.parse(idInput);
    for (const context of await contexts(signal)) {
      if (!await authorized(context, signal)) continue;
      const loaded = await dependencies.state.read(context, signal);
      if (!loaded.ok) continue;
      for (const record of marketplaceUpdateRecords(loaded.snapshot)) {
        const notice = record.notices.find((candidate) => candidate.id === id);
        if (notice !== undefined) return { context, snapshot: loaded.snapshot, notice };
      }
    }
    return undefined;
  }

  async function evaluate(request: Readonly<{ noticeId: UpdateNoticeId }>, signal: AbortSignal, explicit = false): Promise<AutomaticUpdateEligibility> {
    signal.throwIfAborted();
    const noticeId = UpdateNoticeIdSchema.parse(request.noticeId);
    const located = await locate(noticeId, signal);
    if (located === undefined || located.notice.resolution !== undefined) return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "stale" });
    const notice = located.notice;
    if (!explicit) {
      const policy = await dependencies.policy.resolve({
        scope: located.context,
        registrationId: MarketplaceRegistrationIdSchema.parse(notice.registrationId),
        plugin: notice.plugin,
        marketplaceSourceIdentity: notice.available.marketplaceSourceIdentity,
        pluginSourceIdentity: notice.available.pluginSourceIdentity,
      }, signal);
      if (policy.application !== "automatic") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: policy.sourceGuard === "none" ? "manual" : "approval-required" });
      if (notice.automatic?.state === "retryable" && notice.automatic.retryAt! > dependencies.clock.nowEpochMilliseconds()) {
        return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "retryable", retryAt: notice.automatic.retryAt });
      }
    }
    // Without a live reload-capable context, defer before candidate materialization
    // or lifecycle inspection. Every authority is reread on the admitted call.
    if (dependencies.activation.availability() !== "available") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "awaiting-host-context" });
    const authority = await dependencies.lifecycle.inspect(notice, signal);
    if (authority.source === "changed") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "approval-required" });
    if (authority.candidate === "stale" || authority.target === "stale") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "stale" });
    if (authority.project === "untrusted") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "project-untrusted" });
    if (authority.recovery === "required") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "recovery-required" });
    if (authority.configuration === "required") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "configuration-required" });
    if (authority.secrets === "unavailable") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "secret-unavailable" });
    if (authority.capability === "unavailable") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "capability-unavailable" });
    if (dependencies.activation.availability() !== "available") return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "awaiting-host-context" });
    return AutomaticUpdateEligibilitySchema.parse({ noticeId, kind: "eligible" });
  }

  async function updateNotice(
    context: ScopeContext,
    id: UpdateNoticeId,
    update: (notice: UpdateNotice) => UpdateNotice,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!await authorized(context, signal)) return false;
      const loaded = await dependencies.state.read(context, signal);
      if (!loaded.ok) return false;
      const records = marketplaceUpdateRecords(loaded.snapshot);
      if (!records.some((record) => record.notices.some((notice) => notice.id === id))) return false;
      // Skip the write entirely when the update is a durable no-op. The
      // comparison tolerates explicit-undefined fields that canonical JSON
      // rejects (for example `automatic: undefined` spreads).
      const unchanged = records.every((record) => record.notices.every((notice) =>
        notice.id !== id || JSON.stringify(update(notice)) === JSON.stringify(notice)));
      if (unchanged) return true;
      const result = await dependencies.mutations.runPreparedMutation(
        { scope: context, plugins: [], expectedGeneration: loaded.snapshot.generation },
        async ({ snapshot }) => ({
          mutation: createMarketplaceUpdateRecordsMutation(snapshot, marketplaceUpdateRecords(snapshot).map((record) => MarketplaceRegistrationRecordSchema.parse({
            ...record,
            notices: record.notices.map((notice) => notice.id === id ? update(notice) : notice),
          })), dependencies.sha256),
          value: undefined,
          beforeCommit: async () => {
            if (!await authorized(context, signal)) throw new Error("PROJECT_AUTHORITY_STALE");
          },
        }),
        signal,
      );
      if (result.kind === "committed") return true;
    }
    return false;
  }

  function sameAutomaticEvidence(left: UpdateNotice["automatic"], right: UpdateNotice["automatic"]): boolean {
    if (left === undefined || right === undefined) return left === right;
    return left.state === right.state && left.reason === right.reason && left.retryAt === right.retryAt;
  }

  function eligibilityUpdate(notice: UpdateNotice, result: AutomaticUpdateEligibility): UpdateNotice {
    const attemptedAt = dependencies.clock.nowEpochMilliseconds();
    const build = (): UpdateNotice => {
      switch (result.kind) {
        case "eligible": return notice;
        case "manual": return UpdateNoticeSchema.parse({ ...notice, disposition: "manual-required", automatic: undefined });
        case "approval-required": return UpdateNoticeSchema.parse({ ...notice, disposition: "approval-required", automatic: { state: "blocked", reason: "approval-required", attemptedAt } });
        case "awaiting-host-context": return UpdateNoticeSchema.parse({ ...notice, disposition: "automatic-pending", automatic: { state: "pending", reason: "awaiting-host-context", attemptedAt } });
        case "configuration-required": return UpdateNoticeSchema.parse({ ...notice, disposition: "configuration-blocked", automatic: { state: "blocked", reason: "configuration-required", attemptedAt } });
        case "secret-unavailable": return UpdateNoticeSchema.parse({ ...notice, disposition: "configuration-blocked", automatic: { state: "blocked", reason: "secret-unavailable", attemptedAt } });
        case "capability-unavailable": return UpdateNoticeSchema.parse({ ...notice, disposition: "capability-blocked", automatic: { state: "blocked", reason: "capability-unavailable", attemptedAt } });
        case "project-untrusted": return UpdateNoticeSchema.parse({ ...notice, disposition: "approval-required", automatic: { state: "blocked", reason: "project-untrusted", attemptedAt } });
        case "recovery-required": return UpdateNoticeSchema.parse({ ...notice, disposition: "recovery-required", automatic: { state: "recovery-required", reason: "recovery-required", attemptedAt } });
        case "stale": return UpdateNoticeSchema.parse({ ...notice, disposition: "automatic-retryable", automatic: { state: "blocked", reason: "stale", attemptedAt } });
        case "retryable": return UpdateNoticeSchema.parse({ ...notice, disposition: "automatic-retryable", automatic: { state: "retryable", reason: "retryable", attemptedAt, retryAt: result.retryAt } });
      }
    };
    const next = build();
    // An unchanged eligibility outcome keeps its original attempt evidence.
    // Re-stamping every cycle churns durable generations and races foreground
    // selection reads against a constantly moving authority.
    if (result.kind !== "eligible" && next.disposition === notice.disposition && sameAutomaticEvidence(next.automatic, notice.automatic)) {
      return notice;
    }
    return next;
  }

  function lifecycleOutcome(notice: UpdateNotice, result: AutomaticUpdateLifecycleResult): Readonly<{ notice: UpdateNotice; kind: NativeAutomaticUpdateRunResult["outcomes"][number]["kind"]; reason?: string }> {
    const attemptedAt = dependencies.clock.nowEpochMilliseconds();
    if (result.kind === "changed" || result.kind === "unchanged") return {
      kind: result.kind === "changed" ? "applied" : "current",
      notice: UpdateNoticeSchema.parse({ ...notice, disposition: "automatic-applied", automatic: { state: "applied", attemptedAt }, resolution: { kind: "installed", at: attemptedAt } }),
    };
    if (result.kind === "recovery-required") return {
      kind: "recovery-required",
      reason: "recovery-required",
      notice: UpdateNoticeSchema.parse({ ...notice, disposition: "recovery-required", automatic: { state: "recovery-required", reason: "recovery-required", attemptedAt } }),
    };
    if (result.kind === "stale") return { kind: "stale", reason: "stale", notice: eligibilityUpdate(notice, AutomaticUpdateEligibilitySchema.parse({ noticeId: notice.id, kind: "stale" })) };
    if (result.kind === "cancelled-before-commit") return { kind: "pending", reason: "cancelled-before-commit", notice: UpdateNoticeSchema.parse({ ...notice, disposition: "automatic-pending", automatic: { state: "pending", reason: "awaiting-host-context", attemptedAt } }) };
    const retryAt = attemptedAt + AUTOMATIC_RETRY_BASE_MS;
    if (result.kind === "rolled-back") {
      return { kind: "retryable", reason: "rolled-back", notice: eligibilityUpdate(notice, AutomaticUpdateEligibilitySchema.parse({ noticeId: notice.id, kind: "retryable", retryAt })) };
    }
    if (result.kind === "rejected" && ["AVAILABLE_REVISION_CHANGED", "CONFIGURATION_STALE", "PROJECTION_FAILED", "PROMOTION_FAILED", "ABORTED"].includes(result.code)) {
      return { kind: "retryable", reason: result.code, notice: eligibilityUpdate(notice, AutomaticUpdateEligibilitySchema.parse({ noticeId: notice.id, kind: "retryable", retryAt })) };
    }
    const reason: AutomaticUpdateEligibilityReason = result.kind === "rejected" && result.code === "UNCONFIGURED" ? "configuration-required" : result.kind === "rejected" && result.code === "CAPABILITY_UNAVAILABLE" ? "capability-unavailable" : "approval-required";
    return { kind: "blocked", reason, notice: eligibilityUpdate(notice, AutomaticUpdateEligibilitySchema.parse({ noticeId: notice.id, kind: reason })) };
  }

  async function run(request: NativeAutomaticUpdateRunRequest, signal: AbortSignal): Promise<NativeAutomaticUpdateRunResult> {
    const parsed = NativeAutomaticUpdateRunRequestSchema.parse(request);
    const wanted = parsed.noticeIds === undefined ? undefined : new Set(parsed.noticeIds);
    const candidates: LocatedNotice[] = [];
    for (const context of await contexts(signal)) {
      if (!await authorized(context, signal)) continue;
      const loaded = await dependencies.state.read(context, signal);
      if (!loaded.ok) continue;
      for (const notice of marketplaceUpdateRecords(loaded.snapshot).flatMap((record) => record.notices)) {
        if (notice.resolution === undefined && (wanted === undefined || wanted.has(notice.id))) candidates.push({ context, snapshot: loaded.snapshot, notice });
      }
    }
    candidates.sort((left, right) => left.notice.discoveredAt - right.notice.discoveredAt || compareUtf8(left.notice.id, right.notice.id));
    const outcomes: NativeAutomaticUpdateRunResult["outcomes"][number][] = [];
    for (const candidate of candidates.slice(0, parsed.limit)) {
      signal.throwIfAborted();
      const eligibility = await evaluate({ noticeId: candidate.notice.id }, signal, parsed.explicit === true);
      if (eligibility.kind !== "eligible") {
        await updateNotice(candidate.context, candidate.notice.id, (notice) => eligibilityUpdate(notice, eligibility), signal);
        outcomes.push({ noticeId: candidate.notice.id, kind: eligibility.kind === "awaiting-host-context" ? "pending" : eligibility.kind === "retryable" ? "retryable" : eligibility.kind === "recovery-required" ? "recovery-required" : eligibility.kind === "stale" ? "stale" : "blocked", reason: eligibility.kind });
        continue;
      }
      const latest = await locate(candidate.notice.id, signal);
      if (latest === undefined || latest.notice.resolution !== undefined) {
        outcomes.push({ noticeId: candidate.notice.id, kind: "stale", reason: "notice-stale" });
        continue;
      }
      if (dependencies.activation.availability() !== "available") {
        const pending = AutomaticUpdateEligibilitySchema.parse({ noticeId: latest.notice.id, kind: "awaiting-host-context" });
        await updateNotice(latest.context, latest.notice.id, (notice) => eligibilityUpdate(notice, pending), signal);
        outcomes.push({ noticeId: latest.notice.id, kind: "pending", reason: "awaiting-host-context" });
        continue;
      }
      const result = await dependencies.lifecycle.apply(latest.notice, signal);
      const projected = lifecycleOutcome(latest.notice, result);
      // Once lifecycle may have committed, rollback/recovery truth outranks the
      // caller's cancellation. Settle the durable ledger with fresh authority.
      const settlementSignal = new AbortController().signal;
      await updateNotice(latest.context, latest.notice.id, (notice) => lifecycleOutcome(notice, result).notice, settlementSignal);
      outcomes.push({ noticeId: latest.notice.id, kind: projected.kind, ...(projected.reason === undefined ? {} : { reason: projected.reason }) });
    }
    return NativeAutomaticUpdateRunResultSchema.parse({ outcomes });
  }

  async function nextRetryAt(signal: AbortSignal): Promise<number | undefined> {
    let earliest: number | undefined;
    for (const context of await contexts(signal)) {
      if (!await authorized(context, signal)) continue;
      const loaded = await dependencies.state.read(context, signal);
      if (!loaded.ok) continue;
      for (const notice of marketplaceUpdateRecords(loaded.snapshot).flatMap((record) => record.notices)) {
        const retryAt = notice.resolution === undefined && notice.automatic?.state === "retryable" ? notice.automatic.retryAt : undefined;
        if (retryAt !== undefined && (earliest === undefined || retryAt < earliest)) earliest = retryAt;
      }
    }
    return earliest;
  }

  return Object.freeze({ evaluate, run, nextRetryAt });
}
