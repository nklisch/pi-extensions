import {
  MarketplaceAddRequestSchema,
  MarketplaceAddResultSchema,
  MarketplaceRegistrationListRequestSchema,
  MarketplaceRegistrationPageSchema,
  MarketplaceRemoveRequestSchema,
  MarketplaceRemoveResultSchema,
  type MarketplaceAddRequest,
  type MarketplaceAddResult,
  type MarketplaceRegistrationListRequest,
  type MarketplaceRegistrationPage,
  type MarketplaceRemoveRequest,
  type MarketplaceRemoveResult,
} from "./marketplace-management-contract.js";
import {
  deriveMarketplaceRegistrationId,
} from "../domain/marketplace-registration.js";
import {
  MarketplaceRegistrationRecordSchema,
  createMarketplaceConfigurationRecord,
  deriveMarketplaceSourceIdentity,
  type MarketplaceRegistrationRecord,
} from "../domain/update-policy.js";
import {
  type MarketplaceSource,
  type Sha256,
} from "../domain/source.js";
import { ScopeContextSchema, toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import { createMarketplaceSnapshotRecord } from "../domain/state/installed-state.js";
import { createPromotionPlan } from "./content-promotion.js";
import {
  CommittedMutationCleanupError,
  type GenerationMutationCoordinator,
} from "./generation-mutation-coordinator.js";
import type { MarketplaceInspectionService } from "./marketplace-inspection-contract.js";
import type { ContentStorePort } from "./ports/content-store.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type {
  MarketplaceLocalSourcePort,
  MarketplaceRegistrationPort,
} from "./ports/marketplace-registration.js";
import type { MarketplaceMaterializer } from "./source-materialization.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";
import {
  createMarketplaceRegistrationSnapshotMutation,
  marketplaceSnapshots,
  marketplaceUpdateRecords,
} from "./marketplace-update-state.js";
import {
  createMarketplaceRegistrationView,
  registrationSort,
} from "./marketplace-state.js";
import type { GenerationSnapshot } from "./state-contract.js";
import {
  MarketplaceRegistrationResultSchema,
  type MarketplaceRegistrationRequest,
  type MarketplaceRegistrationResult,
} from "./adoption-contract.js";

function abortIfRequested(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function sameScope(left: ScopeContext, right: ScopeContext): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "user" || right.kind === "user" || left.projectKey === right.projectKey;
}

function recordBySource(
  snapshot: GenerationSnapshot,
  source: MarketplaceSource,
  sha256: Sha256,
): MarketplaceRegistrationRecord | undefined {
  const identity = deriveMarketplaceSourceIdentity(source, sha256);
  return marketplaceUpdateRecords(snapshot).find((record) => deriveMarketplaceSourceIdentity(record.source, sha256) === identity);
}

function snapshotFor(snapshot: GenerationSnapshot, marketplace: string) {
  return marketplaceSnapshots(snapshot).find((candidate) => candidate.marketplace === marketplace);
}

function installedPlugins(snapshot: GenerationSnapshot, marketplace: string): readonly import("../domain/identity.js").PluginKey[] {
  const plugins = "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins;
  return plugins
    .filter((plugin) => plugin.plugin.slice(plugin.plugin.lastIndexOf("@") + 1) === marketplace)
    .map((plugin) => plugin.plugin)
    .sort();
}

function classifyPreparation(error: unknown):
  | "INVALID_SOURCE"
  | "SOURCE_UNAVAILABLE"
  | "CATALOG_INVALID"
  | undefined {
  if (error instanceof Error && error.message === "INVALID_LOCAL_SOURCE") return "INVALID_SOURCE";
  if (error instanceof Error && error.message === "SOURCE_UNAVAILABLE") return "SOURCE_UNAVAILABLE";
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "SOURCE_RESOLUTION_FAILED" || code === "ADAPTER_FAILED" || code === "PATH_CONTAINMENT_FAILED") return "SOURCE_UNAVAILABLE";
    if (code === "MARKETPLACE_ROOT_INVALID" || code === "CLAIM_CONFLICT") return "CATALOG_INVALID";
  }
  return undefined;
}

export interface MarketplaceRegistrationService extends MarketplaceRegistrationPort {
  add(request: MarketplaceAddRequest, signal: AbortSignal): Promise<MarketplaceAddResult>;
  remove(request: MarketplaceRemoveRequest, signal: AbortSignal): Promise<MarketplaceRemoveResult>;
  list(request: MarketplaceRegistrationListRequest, signal: AbortSignal): Promise<MarketplaceRegistrationPage>;
}

export type MarketplaceRegistrationServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  mutations: GenerationMutationCoordinator;
  materializer: MarketplaceMaterializer;
  inspection: MarketplaceInspectionService;
  content: ContentStorePort;
  clock: LifecycleClock;
  sha256: Sha256;
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
  projectTrust?: ProjectTrustPort;
  localSources?: MarketplaceLocalSourcePort;
}>;

export function createMarketplaceRegistrationService(
  dependencies: MarketplaceRegistrationServiceDependencies,
): MarketplaceRegistrationService {
  if (typeof dependencies.sha256 !== "function") throw new TypeError("marketplace registration requires SHA-256");
  const userScope = ScopeContextSchema.parse({ kind: "user" });
  const projectScope = dependencies.currentProject === undefined
    ? undefined
    : ScopeContextSchema.parse(dependencies.currentProject) as Extract<ScopeContext, { kind: "project" }>;

  async function projectAuthorityIsCurrent(signal: AbortSignal): Promise<boolean> {
    if (projectScope === undefined || dependencies.projectTrust === undefined) return false;
    const trust = await dependencies.projectTrust.assess(projectScope.projectKey, signal);
    return trust.kind === "trusted";
  }

  async function scopeFor(selection: "user" | "project", signal: AbortSignal): Promise<ScopeContext | undefined> {
    if (selection === "user") return userScope;
    return await projectAuthorityIsCurrent(signal) ? projectScope : undefined;
  }

  async function assertScopeAuthority(scope: ScopeContext, signal: AbortSignal): Promise<void> {
    if (scope.kind === "project" && !await projectAuthorityIsCurrent(signal)) throw new Error("PROJECT_REVOKED");
  }

  async function view(snapshot: GenerationSnapshot, record: MarketplaceRegistrationRecord, signal: AbortSignal) {
    const selected = snapshotFor(snapshot, record.marketplace);
    return createMarketplaceRegistrationView({
      scope: snapshot.scope,
      record,
      ...(selected === undefined ? {} : { snapshot: selected }),
      now: dependencies.clock.nowEpochMilliseconds(),
      content: dependencies.content,
      signal,
      sha256: dependencies.sha256,
    });
  }

  async function add(request: MarketplaceAddRequest, signal: AbortSignal): Promise<MarketplaceAddResult> {
    abortIfRequested(signal);
    const parsed = MarketplaceAddRequestSchema.safeParse(request);
    if (!parsed.success) return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "INVALID_SOURCE" });
    const scope = await scopeFor(parsed.data.scope, signal);
    if (scope === undefined) return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "PROJECT_UNTRUSTED" });
    if (scope.kind === "project" && parsed.data.source.kind === "local-git") {
      return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "NOT_PORTABLE" });
    }

    let source: MarketplaceSource;
    try {
      source = parsed.data.source.kind === "local-git"
        ? await dependencies.localSources?.canonicalize(parsed.data.source, signal) ?? (() => { throw new Error("INVALID_LOCAL_SOURCE"); })()
        : parsed.data.source;
    } catch {
      return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "INVALID_SOURCE" });
    }
    const registrationId = deriveMarketplaceRegistrationId({ scope: toScopeReference(scope), source }, dependencies.sha256);
    const loaded = await dependencies.state.read(scope, signal);
    if (!loaded.ok) return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "STATE_CORRUPT" });
    const existing = recordBySource(loaded.snapshot, source, dependencies.sha256);
    if (existing !== undefined && snapshotFor(loaded.snapshot, existing.marketplace) !== undefined) {
      return MarketplaceAddResultSchema.parse({ kind: "unchanged", registration: await view(loaded.snapshot, existing, signal) });
    }

    let allocation: Awaited<ReturnType<ContentStorePort["allocateStaging"]>> | undefined;
    try {
      allocation = await dependencies.content.allocateStaging(signal);
      let materialized: Awaited<ReturnType<MarketplaceMaterializer["materialize"]>>;
      try {
        materialized = await dependencies.materializer.materialize(source, allocation.slot, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw Object.assign(new Error("SOURCE_UNAVAILABLE"), { cause: error });
      }
      const catalog = await dependencies.inspection.inspect(materialized, signal);
      const marketplace = catalog.marketplace.name.value;
      const selected = createMarketplaceSnapshotRecord({
        marketplace,
        source: materialized.source,
        content: materialized.content,
        binding: materialized.binding,
      }, dependencies.sha256);
      const plan = createPromotionPlan({ kind: "marketplace", allocation, materialized }, dependencies.sha256);
      const now = dependencies.clock.nowEpochMilliseconds();
      const nextRecord = createMarketplaceConfigurationRecord({
        marketplace,
        source,
        origin: parsed.data.origin,
        refresh: {
          lastCompletedAt: now,
          lastAttempt: { completedAt: now, outcome: "succeeded" },
          ...(source.kind === "local-git" ? {} : {
            schedule: { anchorAt: now, baseDelayMs: 6 * 60 * 60 * 1_000, jitterMs: 0, dueAt: now + 6 * 60 * 60 * 1_000, reason: "success" },
          }),
          consecutiveFailures: 0,
        },
      });

      let authority = loaded.snapshot;
      let result: Awaited<ReturnType<GenerationMutationCoordinator["runPreparedMutation"]>> | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        result = await dependencies.mutations.runPreparedMutation(
          { scope, plugins: [], expectedGeneration: authority.generation },
          async (context) => {
          const records = [...marketplaceUpdateRecords(context.snapshot)];
          const snapshots = [...marketplaceSnapshots(context.snapshot)];
          const sameSourceIndex = records.findIndex((record) =>
            deriveMarketplaceSourceIdentity(record.source, dependencies.sha256) === deriveMarketplaceSourceIdentity(source, dependencies.sha256));
          const nameIndex = records.findIndex((record) => record.marketplace === marketplace);
          if (sameSourceIndex >= 0 && records[sameSourceIndex]!.marketplace !== marketplace) throw new Error("SOURCE_NAME_CHANGED");
          if (nameIndex >= 0 && nameIndex !== sameSourceIndex) throw new Error("NAME_CONFLICT");

          await assertScopeAuthority(scope, signal);
          let promoted: Awaited<ReturnType<ContentStorePort["promote"]>>;
          try {
            promoted = await dependencies.content.promote(plan, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            throw Object.assign(new Error("PROMOTION_FAILED"), { cause: error });
          }
          if (promoted.identity.kind !== "marketplace") throw new Error("PROMOTION_FAILED");
          if (sameSourceIndex >= 0) records[sameSourceIndex] = MarketplaceRegistrationRecordSchema.parse({
            ...nextRecord,
            // Idempotent repair keeps existing provenance, policy, and ledger authority.
            origin: records[sameSourceIndex]!.origin,
            ...(records[sameSourceIndex]!.applicationOverride === undefined ? {} : { applicationOverride: records[sameSourceIndex]!.applicationOverride }),
            pluginOverrides: records[sameSourceIndex]!.pluginOverrides,
            notices: records[sameSourceIndex]!.notices,
          });
          else records.push(nextRecord);
          const snapshotIndex = snapshots.findIndex((snapshot) => snapshot.marketplace === marketplace);
          if (snapshotIndex >= 0) snapshots[snapshotIndex] = selected;
          else snapshots.push(selected);
            return {
              mutation: createMarketplaceRegistrationSnapshotMutation(context.snapshot, records, snapshots, dependencies.sha256),
              value: marketplace,
              beforeCommit: () => assertScopeAuthority(scope, signal),
            };
          },
          signal,
        );
        if (result.kind === "committed") break;
        if (result.kind === "commit-ambiguous") {
          // Ambiguous commit evidence may be followed immediately by another
          // scope generation. The exact source registration plus selected
          // snapshot is sufficient idempotent authority even when this caller
          // can no longer prove which concurrent writer published it.
          const recoverySignal = new AbortController().signal;
          const reconciled = await dependencies.state.read(scope, recoverySignal).catch(() => undefined);
          if (reconciled?.ok) {
            const winner = recordBySource(reconciled.snapshot, source, dependencies.sha256);
            if (winner !== undefined && snapshotFor(reconciled.snapshot, winner.marketplace) !== undefined) {
              return MarketplaceAddResultSchema.parse({ kind: "unchanged", registration: await view(reconciled.snapshot, winner, recoverySignal) });
            }
          }
          return MarketplaceAddResultSchema.parse({ kind: "indeterminate", code: "COMMIT_AMBIGUOUS", registrationId });
        }
        if (result.kind !== "stale-generation") break;

        const latest = await dependencies.state.read(scope, signal);
        if (!latest.ok) break;
        const winner = recordBySource(latest.snapshot, source, dependencies.sha256);
        if (winner !== undefined && snapshotFor(latest.snapshot, winner.marketplace) !== undefined) {
          return MarketplaceAddResultSchema.parse({ kind: "unchanged", registration: await view(latest.snapshot, winner, signal) });
        }
        if (marketplaceUpdateRecords(latest.snapshot).some((record) => record.marketplace === marketplace)) {
          return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "NAME_CONFLICT" });
        }
        authority = latest.snapshot;
      }
      if (result?.kind !== "committed") {
        const after = await dependencies.state.read(scope, new AbortController().signal).catch(() => undefined);
        if (after?.ok) {
          const winner = recordBySource(after.snapshot, source, dependencies.sha256);
          if (winner !== undefined && snapshotFor(after.snapshot, winner.marketplace) !== undefined) {
            return MarketplaceAddResultSchema.parse({ kind: "unchanged", registration: await view(after.snapshot, winner, new AbortController().signal) });
          }
          if (marketplaceUpdateRecords(after.snapshot).some((record) => record.marketplace === marketplace)) {
            return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "NAME_CONFLICT" });
          }
        }
        return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "STATE_STALE" });
      }
      const committed = recordBySource(result.snapshot, source, dependencies.sha256)!;
      // A committed add remains added even if the caller cancels while the
      // post-commit cache projection is being built. Cancellation governs only
      // work that has not yet acquired durable authority.
      return MarketplaceAddResultSchema.parse({ kind: "added", registration: await view(result.snapshot, committed, new AbortController().signal) });
    } catch (error) {
      if (error instanceof CommittedMutationCleanupError) {
        const snapshot = error.committed.snapshot;
        const committed = recordBySource(snapshot, source, dependencies.sha256);
        if (committed !== undefined) return MarketplaceAddResultSchema.parse({ kind: "added", registration: await view(snapshot, committed, new AbortController().signal) });
      }
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof Error && error.message === "NAME_CONFLICT") return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "NAME_CONFLICT" });
      if (error instanceof Error && error.message === "SOURCE_NAME_CHANGED") return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "SOURCE_NAME_CHANGED" });
      if (error instanceof Error && error.message === "PROJECT_REVOKED") return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "PROJECT_UNTRUSTED" });
      if (error instanceof Error && error.message === "PROMOTION_FAILED") return MarketplaceAddResultSchema.parse({ kind: "rejected", code: "PROMOTION_FAILED" });
      const code = classifyPreparation(error);
      return MarketplaceAddResultSchema.parse({ kind: "rejected", code: code ?? "CATALOG_INVALID" });
    } finally {
      if (allocation !== undefined) {
        await dependencies.content.discardStaging(allocation, new AbortController().signal).catch(() => undefined);
      }
    }
  }

  async function remove(request: MarketplaceRemoveRequest, signal: AbortSignal): Promise<MarketplaceRemoveResult> {
    abortIfRequested(signal);
    const parsed = MarketplaceRemoveRequestSchema.parse(request);
    const scope = await scopeFor(parsed.scope, signal);
    if (scope === undefined) return MarketplaceRemoveResultSchema.parse({ kind: "rejected", code: "PROJECT_UNTRUSTED" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const loaded = await dependencies.state.read(scope, signal);
      if (!loaded.ok) return MarketplaceRemoveResultSchema.parse({ kind: "rejected", code: "STATE_CORRUPT" });
      const record = marketplaceUpdateRecords(loaded.snapshot).find((candidate) =>
        deriveMarketplaceRegistrationId({ scope: toScopeReference(scope), source: candidate.source }, dependencies.sha256) === parsed.registrationId);
      if (record === undefined) return MarketplaceRemoveResultSchema.parse({ kind: "unchanged", reason: "not-configured" });
      const dependents = installedPlugins(loaded.snapshot, record.marketplace);
      if (dependents.length > 0) return MarketplaceRemoveResultSchema.parse({ kind: "blocked", code: "INSTALLED_PLUGINS_DEPEND", plugins: dependents });

      try {
        const result = await dependencies.mutations.runPreparedMutation(
          { scope, plugins: [], expectedGeneration: loaded.snapshot.generation },
          async (context) => {
            const current = marketplaceUpdateRecords(context.snapshot).find((candidate) =>
              deriveMarketplaceRegistrationId({ scope: toScopeReference(scope), source: candidate.source }, dependencies.sha256) === parsed.registrationId);
            if (current === undefined) throw new Error("NOT_CONFIGURED");
            if (installedPlugins(context.snapshot, current.marketplace).length > 0) throw new Error("INSTALLED_PLUGINS_DEPEND");
            const records = marketplaceUpdateRecords(context.snapshot).filter((candidate) =>
              deriveMarketplaceRegistrationId({ scope: toScopeReference(scope), source: candidate.source }, dependencies.sha256) !== parsed.registrationId);
            const snapshots = marketplaceSnapshots(context.snapshot).filter((candidate) => candidate.marketplace !== current.marketplace);
            return {
              mutation: createMarketplaceRegistrationSnapshotMutation(context.snapshot, records, snapshots, dependencies.sha256),
              value: parsed.registrationId,
            };
          },
          signal,
        );
        if (result.kind === "committed") return MarketplaceRemoveResultSchema.parse({ kind: "removed", registrationId: parsed.registrationId });
        if (result.kind === "commit-ambiguous") return MarketplaceRemoveResultSchema.parse({ kind: "indeterminate", code: "COMMIT_AMBIGUOUS", registrationId: parsed.registrationId });
      } catch (error) {
        if (error instanceof CommittedMutationCleanupError) return MarketplaceRemoveResultSchema.parse({ kind: "removed", registrationId: parsed.registrationId });
        if (signal.aborted) throw signal.reason ?? error;
        if (error instanceof Error && error.message === "NOT_CONFIGURED") return MarketplaceRemoveResultSchema.parse({ kind: "unchanged", reason: "not-configured" });
        if (error instanceof Error && error.message === "INSTALLED_PLUGINS_DEPEND") {
          const latest = await dependencies.state.read(scope, new AbortController().signal).catch(() => undefined);
          const latestRecord = latest?.ok ? marketplaceUpdateRecords(latest.snapshot).find((candidate) => deriveMarketplaceRegistrationId({ scope: toScopeReference(scope), source: candidate.source }, dependencies.sha256) === parsed.registrationId) : undefined;
          return MarketplaceRemoveResultSchema.parse({ kind: "blocked", code: "INSTALLED_PLUGINS_DEPEND", plugins: latest?.ok && latestRecord !== undefined ? installedPlugins(latest.snapshot, latestRecord.marketplace) : [] });
        }
      }
    }
    return MarketplaceRemoveResultSchema.parse({ kind: "rejected", code: "STATE_STALE" });
  }

  async function list(request: MarketplaceRegistrationListRequest, signal: AbortSignal): Promise<MarketplaceRegistrationPage> {
    abortIfRequested(signal);
    const parsed = MarketplaceRegistrationListRequestSchema.parse(request);
    const scopes: ScopeContext[] = [];
    if (parsed.scope === "user" || parsed.scope === "all-current") scopes.push(userScope);
    if ((parsed.scope === "project" || parsed.scope === "all-current") && projectScope !== undefined) scopes.push(projectScope);
    const registrations = [] as Awaited<ReturnType<typeof view>>[];
    for (const scope of scopes) {
      const loaded = await dependencies.state.read(scope, signal);
      if (!loaded.ok) continue;
      for (const record of marketplaceUpdateRecords(loaded.snapshot)) registrations.push(await view(loaded.snapshot, record, signal));
    }
    registrations.sort(registrationSort);
    return MarketplaceRegistrationPageSchema.parse({ registrations: registrations.slice(0, parsed.limit) });
  }

  async function register(
    request: MarketplaceRegistrationRequest,
    signal: AbortSignal,
  ): Promise<MarketplaceRegistrationResult> {
    const scope = ScopeContextSchema.parse(request.scope);
    const expected = scope.kind === "user" ? userScope : projectScope;
    if (expected === undefined || !sameScope(scope, expected)) return MarketplaceRegistrationResultSchema.parse({ kind: "rejected", code: "PROJECT_UNTRUSTED" });
    const result = await add({
      source: request.source,
      scope: scope.kind,
      origin: { kind: "legacy" },
    }, signal);
    if (result.kind === "added") return MarketplaceRegistrationResultSchema.parse({ kind: "registered", marketplace: result.registration.marketplace });
    if (result.kind === "unchanged") return MarketplaceRegistrationResultSchema.parse({ kind: "unchanged", marketplace: result.registration.marketplace });
    if (result.kind === "rejected") {
      const code = result.code === "NAME_CONFLICT" ? "NAME_CONFLICT"
        : result.code === "PROJECT_UNTRUSTED" ? "PROJECT_UNTRUSTED"
          : result.code === "NOT_PORTABLE" ? "NOT_PORTABLE"
            : result.code === "INVALID_SOURCE" ? "INVALID_SOURCE"
              : "ADAPTER_FAILED";
      return MarketplaceRegistrationResultSchema.parse({ kind: "rejected", code });
    }
    return MarketplaceRegistrationResultSchema.parse({ kind: "rejected", code: "STALE" });
  }

  return Object.freeze({ add, remove, list, register });
}
