import {
  MarketplaceRegistrationRecordSchema,
  UpdateNoticeSchema,
  deriveMarketplaceSourceIdentity,
  type MarketplaceRegistrationRecord,
} from "../domain/update-policy.js";
import { createMarketplaceSnapshotRecord, type MarketplaceSnapshotRecord } from "../domain/state/installed-state.js";
import { ScopeContextSchema, toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import { createPromotionPlan } from "./content-promotion.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import type { MarketplaceInspectionService } from "./marketplace-inspection-contract.js";
import type { ContentStorePort } from "./ports/content-store.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { CurrentProjectRuntimeContext, ProjectTrustPort } from "./ports/project-trust.js";
import type { UpdateSchedulerLeasePort } from "./ports/update-scheduler-lease.js";
import type { UpdateSchedulerLeaseId } from "../domain/update-policy.js";
import type { MarketplaceMaterializer, MaterializedMarketplace, PluginMaterializer } from "./source-materialization.js";
import type { PluginLifecycleService } from "./plugin-lifecycle-service.js";
import type { LifecycleRejectionCode } from "./plugin-lifecycle-contract.js";
import type { GenerationSnapshot } from "./state-contract.js";
import {
  createMarketplaceUpdateRecordsMutation,
  createMarketplaceRegistrationSnapshotMutation,
  marketplaceSnapshots,
  marketplaceUpdateRecords,
} from "./marketplace-update-state.js";
import {
  MarketplaceRefreshRequestSchema,
  MarketplaceRefreshResultSchema,
  MarketplaceRefreshOutcomeSchema,
  PluginUpdateOutcomeSchema,
  type MarketplaceRefreshRequest,
  type MarketplaceRefreshResult,
  type MarketplaceRefreshOutcome,
  type PluginUpdateOutcome,
  type NotificationIntent,
} from "./update-contract.js";
import type { Sha256 } from "../domain/source.js";
import type { RefreshClaimIdPort } from "./ports/refresh-claim-id.js";
import type { RefreshClaimOwnerPort } from "./ports/refresh-claim-owner.js";
import {
  MarketplaceRegistrationIdSchema,
  deriveMarketplaceRegistrationId,
  deriveMarketplaceSnapshotToken,
  deriveMarketplaceCandidateId,
  type MarketplaceRegistrationId,
} from "../domain/marketplace-registration.js";
import { deriveUpdateNoticeId } from "./native-update-identifiers.js";
import { deriveUpdateSchedule } from "./update-schedule.js";
import {
  createMarketplaceRegistrationView,
  codePointCompare,
} from "./marketplace-state.js";
import type { MarketplaceCacheStatus } from "./marketplace-management-contract.js";
import { authorizeCurrentScope } from "./current-scope-authority.js";

export const DefaultMarketplaceUpdatePolicy = Object.freeze({
  successIntervalMs: 6 * 60 * 60 * 1_000,
  failureBaseMs: 5 * 60 * 1_000,
  failureMaxMs: 6 * 60 * 60 * 1_000,
  claimLeaseMs: 15 * 60 * 1_000,
  inventoryPollMs: 15 * 60 * 1_000,
});

export type MarketplacePluginProbeResult = Readonly<{
  plugin: import("../domain/identity.js").PluginKey;
  entry: import("../domain/marketplace.js").NormalizedMarketplaceEntry;
  available: import("../domain/update-policy.js").AvailableRevision;
  candidate: import("../domain/update-policy.js").UpdateCandidateKey;
  display: Readonly<{ installed: string; available: string }>;
}>;

export type MarketplacePluginProbePort = (input: Readonly<{
  scope: ScopeContext;
  record: MarketplaceRegistrationRecord;
  snapshot: MarketplaceSnapshotRecord;
  catalog: import("../domain/marketplace.js").MarketplaceReadResult;
  marketplace: MaterializedMarketplace;
  signal: AbortSignal;
}>) => Promise<readonly MarketplacePluginProbeResult[]>;

function abortIfRequested(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function scopeSort(left: ScopeContext, right: ScopeContext): number {
  if (left.kind !== right.kind) return left.kind === "user" ? -1 : 1;
  if (left.kind === "user" || right.kind === "user") return 0;
  return codePointCompare(left.projectKey, right.projectKey);
}

function sameScope(left: ScopeContext, right: ScopeContext): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "user" || right.kind === "user" || left.projectKey === right.projectKey;
}

function registrationId(scope: ScopeContext, record: MarketplaceRegistrationRecord, sha256: Sha256): MarketplaceRegistrationId {
  return deriveMarketplaceRegistrationId({ scope: toScopeReference(scope), source: record.source }, sha256);
}

function recordFor(snapshot: GenerationSnapshot, id: MarketplaceRegistrationId, sha256: Sha256): MarketplaceRegistrationRecord | undefined {
  return marketplaceUpdateRecords(snapshot).find((record) => registrationId(snapshot.scope, record, sha256) === id);
}

function snapshotFor(snapshot: GenerationSnapshot, record: MarketplaceRegistrationRecord): MarketplaceSnapshotRecord | undefined {
  return marketplaceSnapshots(snapshot).find((candidate) => candidate.marketplace === record.marketplace);
}

function claimIsActive(record: MarketplaceRegistrationRecord, now: number): boolean {
  return record.refresh.claim !== undefined && record.refresh.claim.startedAt <= now && record.refresh.claim.expiresAt > now;
}

function withoutRefreshClaim(record: MarketplaceRegistrationRecord): Omit<MarketplaceRegistrationRecord["refresh"], "claim"> {
  const { claim: _claim, ...refresh } = record.refresh;
  return refresh;
}

function failureCode(error: unknown): Extract<MarketplaceRefreshOutcome, { kind: "failed" }>["code"] {
  if (error instanceof Error) {
    if (error.message === "REMOVED_DURING_REFRESH") return "REMOVED_DURING_REFRESH";
    if (error.message === "STATE_STALE" || error.message === "PROJECT_REVOKED") return "STATE_STALE";
    if (error.message === "PROMOTION_FAILED") return "PROMOTION_FAILED";
  }
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "MARKETPLACE_ROOT_INVALID" || code === "CLAIM_CONFLICT") return "CATALOG_INVALID";
    if (code === "CONTENT_INVALID" || code === "CONTENT_DIGEST_MISMATCH" || code === "PATH_CONTAINMENT_FAILED") return "CONTENT_INVALID";
  }
  return "SOURCE_UNAVAILABLE";
}

function cacheWithoutIo(record: MarketplaceRegistrationRecord, snapshot: MarketplaceSnapshotRecord | undefined, now: number): MarketplaceCacheStatus {
  if (snapshot === undefined) return { kind: "not-materialized" };
  const validator = { kind: "git-commit" as const, revision: snapshot.source.revision };
  const etag = { kind: "not-applicable" as const };
  if (record.source.kind === "local-git") return { kind: "unknown-local", validator, etag };
  return {
    kind: record.refresh.schedule !== undefined && record.refresh.schedule.dueAt <= now ? "stale" : "ready",
    validator,
    etag,
    ...(record.refresh.lastCompletedAt === undefined ? {} : { checkedAt: record.refresh.lastCompletedAt }),
  };
}

function replaceRecord(snapshot: GenerationSnapshot, replacement: MarketplaceRegistrationRecord, sha256: Sha256) {
  const identity = deriveMarketplaceSourceIdentity(replacement.source, sha256);
  const records = marketplaceUpdateRecords(snapshot).map((record) =>
    deriveMarketplaceSourceIdentity(record.source, sha256) === identity ? replacement : record);
  return createMarketplaceUpdateRecordsMutation(snapshot, records, sha256);
}

async function assertScopeAuthority(
  dependencies: MarketplaceRefreshServiceDependencies,
  scope: ScopeContext,
  signal: AbortSignal,
): Promise<void> {
  if ((await authorizeCurrentScope(scope, dependencies, signal)).kind !== "trusted") throw new Error("PROJECT_REVOKED");
}

function recordsEqual(left: MarketplaceRegistrationRecord, right: MarketplaceRegistrationRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function mutateClaimRecord(
  dependencies: MarketplaceRefreshServiceDependencies,
  scope: ScopeContext,
  expected: GenerationSnapshot,
  registrationIdValue: MarketplaceRegistrationId,
  replacement: MarketplaceRegistrationRecord,
  signal: AbortSignal,
  schedulerLeaseId?: UpdateSchedulerLeaseId,
): Promise<"committed" | "stale" | "removed"> {
  const expectedRecord = recordFor(expected, registrationIdValue, dependencies.sha256);
  if (expectedRecord === undefined) return "removed";
  let authority = expected;
  // Refresh work intentionally occurs outside the scope lock. An unrelated
  // writer may therefore advance the generation before a claim is acquired or
  // settled. Rebase only while the target registration is byte-for-byte the
  // authority originally inspected, so concurrent policy, notice, source, and
  // claim changes are never overwritten by stale refresh memory.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await dependencies.mutations.runPreparedMutation(
        { scope, plugins: [], expectedGeneration: authority.generation },
        async (context) => {
          const current = recordFor(context.snapshot, registrationIdValue, dependencies.sha256);
          if (current === undefined) throw new Error("REMOVED_DURING_REFRESH");
          if (!recordsEqual(current, expectedRecord)) throw new Error("STATE_STALE");
          return {
            mutation: replaceRecord(context.snapshot, replacement, dependencies.sha256),
            value: undefined,
            beforeCommit: async () => {
              await assertScopeAuthority(dependencies, scope, signal);
              if (schedulerLeaseId !== undefined && (dependencies.schedulerLeases === undefined ||
                  !(await dependencies.schedulerLeases.validate(scope, schedulerLeaseId, dependencies.clock.nowEpochMilliseconds(), signal)))) {
                throw new Error("STATE_STALE");
              }
            },
          };
        },
        signal,
      );
      if (result.kind === "committed") return "committed";
      if (result.kind !== "stale-generation") return "stale";
    } catch (error) {
      if (error instanceof Error && error.message === "REMOVED_DURING_REFRESH") return "removed";
      if (error instanceof Error && error.message === "STATE_STALE") return "stale";
      throw error;
    }

    await assertScopeAuthority(dependencies, scope, signal);
    const latest = await dependencies.state.read(scope, signal);
    if (!latest.ok) return "stale";
    const latestRecord = recordFor(latest.snapshot, registrationIdValue, dependencies.sha256);
    if (latestRecord === undefined) return "removed";
    if (!recordsEqual(latestRecord, expectedRecord)) return "stale";
    authority = latest.snapshot;
  }
  return "stale";
}

type AutomaticDispositionInput =
  | Readonly<{ kind: "changed" | "unchanged" }>
  | Readonly<{ kind: "stale" | "rolled-back" }>
  | Readonly<{ kind: "recovery-required" }>
  | Readonly<{ kind: "rejected"; code: LifecycleRejectionCode }>;

export function automaticDisposition(result: AutomaticDispositionInput): "automatic-applied" | "automatic-retryable" | "manual-required" | "approval-required" | "recovery-required" {
  switch (result.kind) {
    case "changed":
    case "unchanged": return "automatic-applied";
    case "recovery-required": return "recovery-required";
    case "stale":
    case "rolled-back": return "automatic-retryable";
    case "rejected":
      switch (result.code) {
        case "INVALID_REQUEST":
        case "NOT_INSTALLED":
        case "ALREADY_INSTALLED":
        case "WRONG_ACTIVATION":
        case "PENDING_TRANSITION":
        case "INCOMPATIBLE":
        case "UNTRUSTED":
        case "UNCONFIGURED":
        case "MALFORMED": return "manual-required";
        case "PROJECTION_FAILED":
        case "PROMOTION_FAILED":
        case "ABORTED":
        case "AVAILABLE_REVISION_CHANGED":
        case "CONFIGURATION_STALE": return "automatic-retryable";
      }
  }
}

function discoveredNotifications(
  record: MarketplaceRegistrationRecord,
  scope: ScopeContext,
  id: MarketplaceRegistrationId,
  selected: MarketplaceSnapshotRecord,
  probes: readonly MarketplacePluginProbeResult[],
  discoveredAt: number,
  sha256: Sha256,
): Readonly<{ record: MarketplaceRegistrationRecord; outcomes: readonly PluginUpdateOutcome[]; created: ReadonlySet<string> }> {
  const notices = [...record.notices];
  const outcomes: PluginUpdateOutcome[] = [];
  const created = new Set<string>();
  const scopeReference = toScopeReference(scope);
  const snapshot = deriveMarketplaceSnapshotToken({ scope: scopeReference, registrationId: id, snapshot: selected }, sha256);
  for (const probe of probes) {
    const existing = notices.find((notice) => notice.candidate === probe.candidate);
    outcomes.push(PluginUpdateOutcomeSchema.parse({
      plugin: probe.plugin,
      disposition: existing === undefined ? "discovered" : existing.disposition,
      candidate: probe.candidate,
      available: probe.available,
      notification: existing === undefined ? "new" : "already-emitted",
    }));
    if (existing !== undefined) continue;
    const candidateId = deriveMarketplaceCandidateId({ snapshot, plugin: probe.plugin, source: probe.entry.source.value }, sha256);
    const noticeId = deriveUpdateNoticeId({ scope: scopeReference, plugin: probe.plugin, candidate: probe.candidate }, sha256);
    notices.push(UpdateNoticeSchema.parse({
      id: noticeId,
      scope: scopeReference,
      plugin: probe.plugin,
      registrationId: id,
      snapshot,
      candidateId,
      candidate: probe.candidate,
      available: probe.available,
      display: probe.display,
      disposition: record.applicationOverride === "automatic" ? "automatic-pending" : "manual-required",
      publication: "pending",
      unread: true,
      discoveredAt,
      ...(record.applicationOverride === "automatic" ? { automatic: { state: "pending", reason: "awaiting-host-context" } } : {}),
    }));
    created.add(probe.candidate);
  }
  return { record: MarketplaceRegistrationRecordSchema.parse({ ...record, notices }), outcomes, created };
}

export interface MarketplaceRefreshService {
  refresh(request: MarketplaceRefreshRequest, signal: AbortSignal): Promise<MarketplaceRefreshResult>;
  /** Internal lease-fenced scheduled entry; explicit refresh never needs lease evidence. */
  refreshScheduled?(request: Readonly<{
    scope: ScopeContext;
    registrationIds: readonly MarketplaceRegistrationId[];
    leaseId: UpdateSchedulerLeaseId;
  }>, signal: AbortSignal): Promise<MarketplaceRefreshResult>;
  nextScheduledAt(signal: AbortSignal): Promise<number | undefined>;
}

export type MarketplaceRefreshServiceDependencies = Readonly<{
  inventory: LifecycleStateInventoryPort;
  state: LifecycleStateStore;
  mutations: GenerationMutationCoordinator;
  clock: LifecycleClock;
  claimIds: RefreshClaimIdPort;
  claimOwners?: RefreshClaimOwnerPort;
  materializers: Readonly<{ marketplaces: MarketplaceMaterializer; plugins?: PluginMaterializer }>;
  inspection: MarketplaceInspectionService;
  content: ContentStorePort;
  sha256: Sha256;
  probe?: MarketplacePluginProbePort;
  lifecycle?: PluginLifecycleService;
  inventoryComplete?: () => boolean;
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
  projectTrust?: ProjectTrustPort;
  revalidateCurrentProject?: (signal: AbortSignal) => Promise<CurrentProjectRuntimeContext>;
  schedulerLeases?: UpdateSchedulerLeasePort;
}>;

export function createMarketplaceRefreshService(dependencies: MarketplaceRefreshServiceDependencies): MarketplaceRefreshService {
  if (typeof dependencies.sha256 !== "function") throw new TypeError("marketplace refresh requires SHA-256");
  const now = () => dependencies.clock.nowEpochMilliseconds();

  async function cadence(signal: AbortSignal) {
    const loaded = await dependencies.state.read({ kind: "user" }, signal);
    return loaded.ok && "config" in loaded.snapshot ? loaded.snapshot.config.global.cadence : "balanced" as const;
  }

  async function safeView(snapshot: GenerationSnapshot, record: MarketplaceRegistrationRecord, signal: AbortSignal) {
    const selected = snapshotFor(snapshot, record);
    return createMarketplaceRegistrationView({
      scope: snapshot.scope,
      record,
      ...(selected === undefined ? {} : { snapshot: selected }),
      now: now(),
      content: dependencies.content,
      signal,
      sha256: dependencies.sha256,
    });
  }

  async function settleFailure(
    scope: ScopeContext,
    id: MarketplaceRegistrationId,
    claimId: string,
    code: Extract<MarketplaceRefreshOutcome, { kind: "failed" }>["code"],
  ): Promise<MarketplaceRefreshOutcome> {
    const cleanupSignal = new AbortController().signal;
    if ((await authorizeCurrentScope(scope, dependencies, cleanupSignal)).kind !== "trusted") {
      return { kind: "failed", registrationId: id, code: "STATE_STALE", retained: { kind: "unavailable" } };
    }
    const loaded = await dependencies.state.read(scope, cleanupSignal).catch(() => undefined);
    if (loaded?.ok !== true) return { kind: "failed", registrationId: id, code, retained: { kind: "unavailable" } };
    const record = recordFor(loaded.snapshot, id, dependencies.sha256);
    if (record === undefined) return { kind: "failed", registrationId: id, code: "REMOVED_DURING_REFRESH", retained: { kind: "not-materialized" } };
    const retained = cacheWithoutIo(record, snapshotFor(loaded.snapshot, record), now());
    if (record.refresh.claim?.id !== claimId) return { kind: "failed", registrationId: id, code: "STATE_STALE", retained };
    const failures = record.refresh.consecutiveFailures + 1;
    const completedAt = now();
    const schedule = deriveUpdateSchedule({ registrationId: id, outcome: "failure", failureCount: failures, anchorAt: completedAt, cadence: await cadence(cleanupSignal) }, dependencies.sha256);
    const replacement = MarketplaceRegistrationRecordSchema.parse({
      ...record,
      refresh: {
        ...withoutRefreshClaim(record),
        lastAttempt: {
          completedAt,
          outcome: code === "SOURCE_UNAVAILABLE" ? "unavailable" : "failed",
          code,
        },
        consecutiveFailures: failures,
        schedule,
      },
    });
    const settlement = await mutateClaimRecord(dependencies, scope, loaded.snapshot, id, replacement, cleanupSignal).catch(() => "stale" as const);
    if (settlement !== "committed") {
      if ((await authorizeCurrentScope(scope, dependencies, cleanupSignal)).kind !== "trusted") {
        return { kind: "failed", registrationId: id, code: "STATE_STALE", retained: { kind: "unavailable" } };
      }
      const authoritative = await dependencies.state.read(scope, cleanupSignal).catch(() => undefined);
      if (authoritative?.ok) {
        const authority = recordFor(authoritative.snapshot, id, dependencies.sha256);
        if (authority === undefined) return { kind: "failed", registrationId: id, code: "REMOVED_DURING_REFRESH", retained: { kind: "not-materialized" } };
        return {
          kind: "failed",
          registrationId: id,
          code: "STATE_STALE",
          retained: cacheWithoutIo(authority, snapshotFor(authoritative.snapshot, authority), now()),
        };
      }
    }
    return { kind: "failed", registrationId: id, code, retained };
  }

  async function settleCancellation(
    scope: ScopeContext,
    id: MarketplaceRegistrationId,
    claimId: string,
  ): Promise<MarketplaceRefreshOutcome> {
    const cleanupSignal = new AbortController().signal;
    if ((await authorizeCurrentScope(scope, dependencies, cleanupSignal)).kind !== "trusted") return { kind: "cancelled", registrationId: id };
    const loaded = await dependencies.state.read(scope, cleanupSignal).catch(() => undefined);
    if (loaded?.ok !== true) return { kind: "cancelled", registrationId: id };
    const record = recordFor(loaded.snapshot, id, dependencies.sha256);
    if (record === undefined || record.refresh.claim?.id !== claimId) return { kind: "cancelled", registrationId: id };
    const completedAt = now();
    const replacement = MarketplaceRegistrationRecordSchema.parse({
      ...record,
      refresh: {
        ...withoutRefreshClaim(record),
        lastAttempt: { completedAt, outcome: "cancelled", code: "ABORTED" },
      },
    });
    await mutateClaimRecord(dependencies, scope, loaded.snapshot, id, replacement, cleanupSignal).catch(() => "stale");
    return { kind: "cancelled", registrationId: id };
  }

  async function refreshOne(
    scope: ScopeContext,
    id: MarketplaceRegistrationId,
    trigger: "explicit" | "scheduled",
    completeInventory: boolean,
    signal: AbortSignal,
    schedulerLeaseId?: UpdateSchedulerLeaseId,
  ): Promise<Readonly<{ outcome: MarketplaceRefreshOutcome; notifications: readonly NotificationIntent[] }>> {
    abortIfRequested(signal);
    await assertScopeAuthority(dependencies, scope, signal);
    const loaded = await dependencies.state.read(scope, signal);
    if (!loaded.ok) return { outcome: { kind: "failed", registrationId: id, code: "STATE_STALE", retained: { kind: "unavailable" } }, notifications: [] };
    const current = recordFor(loaded.snapshot, id, dependencies.sha256);
    if (current === undefined) return { outcome: { kind: "not-configured", registrationId: id }, notifications: [] };
    const time = now();
    if (trigger === "scheduled" && current.source.kind === "local-git") return { outcome: { kind: "skipped-local", registrationId: id }, notifications: [] };
    if (claimIsActive(current, time)) {
      const claimOwner = current.refresh.claim?.owner;
      const ownerStatus = claimOwner === undefined || dependencies.claimOwners === undefined
        ? "unknown"
        : dependencies.claimOwners.status(claimOwner);
      // A lease protects a live or unverifiable owner. A proven-dead owner may
      // be replaced immediately under the generation lock; waiting for the
      // wall-clock lease would strand refresh after a process crash.
      if (ownerStatus !== "dead") {
        return { outcome: { kind: "coalesced", registrationId: id, claimExpiresAt: current.refresh.claim!.expiresAt }, notifications: [] };
      }
    }
    if (trigger === "scheduled" && current.refresh.schedule !== undefined && current.refresh.schedule.dueAt > time) {
      return { outcome: { kind: "rate-limited", registrationId: id, nextAt: current.refresh.schedule.dueAt }, notifications: [] };
    }

    const claimId = await dependencies.claimIds.create();
    const claimOwner = dependencies.claimOwners?.current();
    const claimed = MarketplaceRegistrationRecordSchema.parse({
      ...current,
      refresh: {
        ...current.refresh,
        claim: {
          id: claimId,
          startedAt: time,
          expiresAt: time + DefaultMarketplaceUpdatePolicy.claimLeaseMs,
          ...(claimOwner === undefined ? {} : { owner: claimOwner }),
        },
      },
    });
    const claimedResult = await mutateClaimRecord(dependencies, scope, loaded.snapshot, id, claimed, signal, schedulerLeaseId);
    if (claimedResult === "removed") return { outcome: { kind: "not-configured", registrationId: id }, notifications: [] };
    if (claimedResult !== "committed") {
      return { outcome: { kind: "failed", registrationId: id, code: "STATE_STALE", retained: cacheWithoutIo(current, snapshotFor(loaded.snapshot, current), time) }, notifications: [] };
    }

    let allocation: Awaited<ReturnType<ContentStorePort["allocateStaging"]>> | undefined;
    try {
      allocation = await dependencies.content.allocateStaging(signal);
      const materialized = await dependencies.materializers.marketplaces.materialize(current.source, allocation.slot, signal);
      const catalog = await dependencies.inspection.inspect(materialized, signal);
      if (catalog.marketplace.name.value !== current.marketplace) throw new Error("STATE_STALE");
      const selected = createMarketplaceSnapshotRecord({ marketplace: current.marketplace, source: materialized.source, content: materialized.content, binding: materialized.binding }, dependencies.sha256);
      const probes = dependencies.probe === undefined ? [] : await dependencies.probe({ scope, record: claimed, snapshot: selected, catalog, marketplace: materialized, signal });
      const completedAt = now();
      await assertScopeAuthority(dependencies, scope, signal);
      const latest = await dependencies.state.read(scope, signal);
      if (!latest.ok) throw new Error("STATE_STALE");
      const latestAuthority = recordFor(latest.snapshot, id, dependencies.sha256);
      if (latestAuthority === undefined) throw new Error("REMOVED_DURING_REFRESH");
      if (latestAuthority.refresh.claim?.id !== claimId || deriveMarketplaceSourceIdentity(latestAuthority.source, dependencies.sha256) !== deriveMarketplaceSourceIdentity(current.source, dependencies.sha256)) throw new Error("STATE_STALE");
      const oldSnapshot = snapshotFor(latest.snapshot, latestAuthority);
      const unchanged = oldSnapshot !== undefined && oldSnapshot.source.revision === selected.source.revision && oldSnapshot.contentDigest === selected.contentDigest && oldSnapshot.binding === selected.binding;
      const discovery = discoveredNotifications(latestAuthority, scope, id, selected, probes, completedAt, dependencies.sha256);
      const plan = createPromotionPlan({ kind: "marketplace", allocation, materialized }, dependencies.sha256);
      let publicationAuthority = latest.snapshot;
      let result: Awaited<ReturnType<GenerationMutationCoordinator["runPreparedMutation"]>> | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        result = await dependencies.mutations.runPreparedMutation(
          { scope, plugins: [], expectedGeneration: publicationAuthority.generation },
          async (context) => {
            const authority = recordFor(context.snapshot, id, dependencies.sha256);
            if (authority === undefined) throw new Error("REMOVED_DURING_REFRESH");
            if (authority.refresh.claim?.id !== claimId || deriveMarketplaceSourceIdentity(authority.source, dependencies.sha256) !== deriveMarketplaceSourceIdentity(current.source, dependencies.sha256)) throw new Error("STATE_STALE");
            await assertScopeAuthority(dependencies, scope, signal);
            // Policy and origin are authoritative in the locked snapshot. Only
            // refresh memory and newly discovered notification facts belong to
            // this long-running refresh operation.
            const discovered = discoveredNotifications(authority, scope, id, selected, probes, completedAt, dependencies.sha256);
            const schedule = authority.source.kind === "local-git" ? undefined : deriveUpdateSchedule({
              registrationId: id,
              outcome: "success",
              failureCount: 0,
              anchorAt: completedAt,
              cadence: await cadence(signal),
            }, dependencies.sha256);
            const { schedule: _previousSchedule, ...settledRefresh } = withoutRefreshClaim(authority);
            const publicationRecord = MarketplaceRegistrationRecordSchema.parse({
              ...discovered.record,
              refresh: {
                ...settledRefresh,
                lastCompletedAt: completedAt,
                lastAttempt: { completedAt, outcome: unchanged ? "unchanged" : "succeeded" },
                ...(schedule === undefined ? {} : { schedule }),
                consecutiveFailures: 0,
              },
            });
            let promoted: Awaited<ReturnType<ContentStorePort["promote"]>>;
            try {
              promoted = await dependencies.content.promote(plan, signal);
            } catch (error) {
              if (signal.aborted) throw error;
              throw Object.assign(new Error("PROMOTION_FAILED"), { cause: error });
            }
            if (promoted.identity.kind !== "marketplace") throw new Error("PROMOTION_FAILED");
            const records = marketplaceUpdateRecords(context.snapshot).map((record) => registrationId(scope, record, dependencies.sha256) === id ? publicationRecord : record);
            const snapshots = [...marketplaceSnapshots(context.snapshot)];
            const index = snapshots.findIndex((snapshot) => snapshot.marketplace === current.marketplace);
            if (index >= 0) snapshots[index] = selected;
            else snapshots.push(selected);
            return {
              mutation: createMarketplaceRegistrationSnapshotMutation(context.snapshot, records, snapshots, dependencies.sha256),
              value: undefined,
              beforeCommit: () => assertScopeAuthority(dependencies, scope, signal),
            };
          },
          signal,
        );
        if (result.kind === "committed") break;
        if (result.kind !== "stale-generation") throw new Error("STATE_STALE");
        await assertScopeAuthority(dependencies, scope, signal);
        const rebased = await dependencies.state.read(scope, signal);
        if (!rebased.ok) throw new Error("STATE_STALE");
        const rebasedRecord = recordFor(rebased.snapshot, id, dependencies.sha256);
        if (rebasedRecord === undefined) throw new Error("REMOVED_DURING_REFRESH");
        if (rebasedRecord.refresh.claim?.id !== claimId || deriveMarketplaceSourceIdentity(rebasedRecord.source, dependencies.sha256) !== deriveMarketplaceSourceIdentity(current.source, dependencies.sha256)) throw new Error("STATE_STALE");
        publicationAuthority = rebased.snapshot;
      }
      if (result?.kind !== "committed") throw new Error("STATE_STALE");
      const committed = recordFor(result.snapshot, id, dependencies.sha256)!;
      // Once state proves publication, caller cancellation cannot turn the
      // committed refresh into a cancelled result.
      const registration = await safeView(result.snapshot, committed, new AbortController().signal);

      // Discovery persists exact notice identity before any automatic application.
      // Publication and lifecycle execution belong to the notification service and
      // automatic coordinator; refresh never calls Pi reload or lifecycle directly.
      const notifications: NotificationIntent[] = probes
        .filter((probe) => discovery.created.has(probe.candidate))
        .map((probe) => ({
          scope: toScopeReference(scope),
          plugin: probe.plugin,
          candidate: probe.candidate,
          installed: probe.display.installed,
          available: probe.display.available,
          disposition: committed.applicationOverride === "automatic" && completeInventory ? "discovered" as const : "manual-required" as const,
        }));
      return {
        outcome: MarketplaceRefreshOutcomeSchema.parse({ kind: "refreshed", registrationId: id, change: unchanged ? "unchanged" : "changed", registration, plugins: discovery.outcomes }),
        notifications,
      };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return { outcome: await settleCancellation(scope, id, claimId), notifications: [] };
      }
      return { outcome: await settleFailure(scope, id, claimId, failureCode(error)), notifications: [] };
    } finally {
      if (allocation !== undefined) await dependencies.content.discardStaging(allocation, new AbortController().signal).catch(() => undefined);
    }
  }

  async function activeScopes(signal: AbortSignal): Promise<Readonly<{ scopes: readonly ScopeContext[]; complete: boolean }>> {
    const inventory = await dependencies.inventory.discover(signal);
    const candidates = inventory.scopes.map((scope) => ScopeContextSchema.parse(scope));
    const scopes: ScopeContext[] = [];
    for (const scope of candidates) {
      if (scope.kind === "user" || await authorizeCurrentScope(scope, dependencies, signal).then((authority) => authority.kind === "trusted")) scopes.push(scope);
    }
    return { scopes: scopes.sort(scopeSort), complete: inventory.complete };
  }

  return {
    async refresh(request, signal) {
      const parsed = MarketplaceRefreshRequestSchema.parse(request);
      const inventory = await activeScopes(signal);
      const jobs: Array<{ scope: ScopeContext; id: MarketplaceRegistrationId; record: MarketplaceRegistrationRecord }> = [];
      const requested = parsed.registrationIds === undefined ? undefined : new Set(parsed.registrationIds);
      for (const scope of inventory.scopes) {
        if (parsed.scope !== "all-current" && parsed.scope !== scope.kind) continue;
        await assertScopeAuthority(dependencies, scope, signal);
        const loaded = await dependencies.state.read(scope, signal);
        if (!loaded.ok) continue;
        for (const record of marketplaceUpdateRecords(loaded.snapshot)) {
          const id = registrationId(scope, record, dependencies.sha256);
          if (requested !== undefined && !requested.has(id)) continue;
          jobs.push({ scope, id, record });
        }
      }
      jobs.sort((left, right) => scopeSort(left.scope, right.scope) || codePointCompare(left.record.marketplace, right.record.marketplace) || codePointCompare(left.id, right.id));
      const outcomes: MarketplaceRefreshOutcome[] = [];
      const notifications: NotificationIntent[] = [];
      for (const job of jobs) {
        const result = await refreshOne(job.scope, job.id, parsed.trigger, inventory.complete, signal);
        outcomes.push(result.outcome);
        notifications.push(...result.notifications);
      }
      if (requested !== undefined) {
        const seen = new Set(outcomes.map((outcome) => outcome.registrationId));
        for (const id of [...requested].filter((candidate) => !seen.has(candidate)).sort(codePointCompare)) outcomes.push({ kind: "not-configured", registrationId: id });
      }
      return MarketplaceRefreshResultSchema.parse({ outcomes, notifications });
    },
    async refreshScheduled(request, signal) {
      const scope = ScopeContextSchema.parse(request.scope);
      const leaseId = request.leaseId;
      const ids = request.registrationIds.map((id) => MarketplaceRegistrationIdSchema.parse(id));
      if (dependencies.schedulerLeases === undefined ||
          !(await dependencies.schedulerLeases.validate(scope, leaseId, dependencies.clock.nowEpochMilliseconds(), signal))) {
        return MarketplaceRefreshResultSchema.parse({
          outcomes: ids.map((registrationId) => ({ kind: "failed", registrationId, code: "STATE_STALE", retained: { kind: "unavailable" } })),
          notifications: [],
        });
      }
      const inventory = await activeScopes(signal);
      const active = inventory.scopes.find((candidate) => sameScope(candidate, scope));
      if (active === undefined) return MarketplaceRefreshResultSchema.parse({ outcomes: [], notifications: [] });
      const outcomes: MarketplaceRefreshOutcome[] = [];
      const notifications: NotificationIntent[] = [];
      for (const id of ids) {
        const result = await refreshOne(active, id, "scheduled", inventory.complete, signal, leaseId);
        outcomes.push(result.outcome);
        notifications.push(...result.notifications);
      }
      return MarketplaceRefreshResultSchema.parse({ outcomes, notifications });
    },
    async nextScheduledAt(signal) {
      const inventory = await activeScopes(signal);
      let earliest: number | undefined;
      for (const scope of inventory.scopes) {
        await assertScopeAuthority(dependencies, scope, signal);
        const loaded = await dependencies.state.read(scope, signal);
        if (!loaded.ok) continue;
        for (const record of marketplaceUpdateRecords(loaded.snapshot)) {
          if (record.source.kind === "local-git") continue;
          const dueAt = record.refresh.schedule?.dueAt ?? 0;
          const scheduledAt = record.refresh.claim !== undefined && record.refresh.claim.expiresAt > dependencies.clock.nowEpochMilliseconds()
            ? Math.max(dueAt, record.refresh.claim.expiresAt)
            : dueAt;
          if (earliest === undefined || scheduledAt < earliest) earliest = scheduledAt;
        }
      }
      return earliest;
    },
  };
}
