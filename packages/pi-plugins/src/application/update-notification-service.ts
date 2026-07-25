import { canonicalJson, compareUtf8 } from "../domain/canonical-json.js";
import type { MarketplaceCandidateId, MarketplaceRegistrationId, MarketplaceSnapshotToken } from "../domain/marketplace-registration.js";
import { deriveMarketplaceRegistrationId } from "../domain/marketplace-registration.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { ScopeContextSchema, toScopeReference, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import {
  AvailableRevisionSchema,
  MarketplaceRegistrationRecordSchema,
  UpdateCandidateKeySchema,
  UpdateNoticeSchema,
  type AvailableRevision,
  type UpdateCandidateKey,
  type UpdateNotice,
  type UpdateNoticeId,
} from "../domain/update-policy.js";
import type { Sha256 } from "../domain/source.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import { createMarketplaceUpdateRecordsMutation, marketplaceUpdateRecords } from "./marketplace-update-state.js";
import {
  NativeUpdateAcknowledgmentRequestSchema,
  NativeUpdateAcknowledgmentResultSchema,
  NativeUpdateNotificationListRequestSchema,
  NativeUpdateNotificationPageSchema,
  type NativeUpdateAcknowledgmentRequest,
  type NativeUpdateAcknowledgmentResult,
  type NativeUpdateNotificationListRequest,
  type NativeUpdateNotificationPage,
} from "./native-update-contract.js";
import { deriveUpdateNoticeId } from "./native-update-identifiers.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { UpdateNotificationPublisherPort } from "./ports/update-notification-publisher.js";
import type { GenerationSnapshot } from "./state-contract.js";
import { authorizeCurrentScope, type CurrentScopeAuthorityDependencies } from "./current-scope-authority.js";

export const UpdateNoticeRetentionPolicy = Object.freeze({
  resolvedPerPlugin: 64,
  resolvedPerScope: 4_096,
  dispatchLimit: 100,
  mutationAttempts: 4,
});

export type ExactUpdateDiscovery = Readonly<{
  scope: ScopeContext;
  registrationId: MarketplaceRegistrationId;
  snapshot: MarketplaceSnapshotToken;
  candidateId: MarketplaceCandidateId;
  plugin: PluginKey;
  candidate: UpdateCandidateKey;
  available: AvailableRevision;
  display: Readonly<{ installed: string; available: string }>;
  disposition?: UpdateNotice["disposition"];
}>;

export type UpdateNotificationDispatchResult = Readonly<{
  published: readonly UpdateNoticeId[];
  pending: number;
  failed: number;
}>;

export type NativeUpdateNoticeReconciliationResult = Readonly<{
  resolved: readonly UpdateNoticeId[];
  pruned: number;
  unreadCount: number;
  unresolvedCount: number;
}>;

export interface UpdateNotificationService {
  record(discoveries: readonly ExactUpdateDiscovery[], signal: AbortSignal): Promise<readonly UpdateNoticeId[]>;
  dispatch(request: Readonly<{ limit?: number }>, signal: AbortSignal): Promise<UpdateNotificationDispatchResult>;
  list(request: NativeUpdateNotificationListRequest, signal: AbortSignal): Promise<NativeUpdateNotificationPage>;
  acknowledge(request: NativeUpdateAcknowledgmentRequest, signal: AbortSignal): Promise<NativeUpdateAcknowledgmentResult>;
  reconcile(signal: AbortSignal): Promise<NativeUpdateNoticeReconciliationResult>;
}

export type UpdateNotificationServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  mutations: GenerationMutationCoordinator;
  clock: LifecycleClock;
  sha256: Sha256;
  publisher?: UpdateNotificationPublisherPort;
}> & CurrentScopeAuthorityDependencies;

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  return left.kind === right.kind && (left.kind === "user" || right.kind === "user" || left.projectKey === right.projectKey);
}

function noticeOrder(left: UpdateNotice, right: UpdateNotice): number {
  return right.discoveredAt - left.discoveredAt || compareUtf8(right.id, left.id);
}

function resolvedOrder(left: UpdateNotice, right: UpdateNotice): number {
  return (right.resolution?.at ?? 0) - (left.resolution?.at ?? 0) || compareUtf8(right.id, left.id);
}

/** Never prunes unread or unresolved identities. */
export function pruneUpdateNotices(input: readonly UpdateNotice[]): readonly UpdateNotice[] {
  const permanent = input.filter((notice) => notice.unread || notice.resolution === undefined);
  const tombstones = input.filter((notice) => !notice.unread && notice.resolution !== undefined).sort(resolvedOrder);
  const perPlugin = new Map<string, number>();
  const retained: UpdateNotice[] = [];
  for (const notice of tombstones) {
    const count = perPlugin.get(notice.plugin) ?? 0;
    if (count >= UpdateNoticeRetentionPolicy.resolvedPerPlugin || retained.length >= UpdateNoticeRetentionPolicy.resolvedPerScope) continue;
    retained.push(notice);
    perPlugin.set(notice.plugin, count + 1);
  }
  return [...permanent, ...retained].sort((left, right) => compareUtf8(left.id, right.id));
}

function records(snapshot: GenerationSnapshot) {
  return marketplaceUpdateRecords(snapshot);
}

function replaceRecords(snapshot: GenerationSnapshot, replacement: readonly ReturnType<typeof records>[number][], sha256: Sha256) {
  return createMarketplaceUpdateRecordsMutation(snapshot, replacement, sha256);
}

export function createUpdateNotificationService(dependencies: UpdateNotificationServiceDependencies): UpdateNotificationService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("update notification dependencies are required");

  async function authorized(scope: ScopeContext, signal: AbortSignal): Promise<boolean> {
    return (await authorizeCurrentScope(scope, dependencies, signal)).kind === "trusted";
  }

  async function scopes(signal: AbortSignal): Promise<readonly ScopeContext[]> {
    const inventory = await dependencies.inventory.discover(signal);
    const scopes: ScopeContext[] = [];
    for (const value of inventory.scopes) {
      const scope = ScopeContextSchema.parse(value);
      if (await authorized(scope, signal)) scopes.push(scope);
    }
    return scopes;
  }

  async function mutateScope<T>(
    scope: ScopeContext,
    transform: (snapshot: GenerationSnapshot) => Readonly<{ records: readonly ReturnType<typeof records>[number][]; value: T }> | undefined,
    signal: AbortSignal,
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt < UpdateNoticeRetentionPolicy.mutationAttempts; attempt += 1) {
      signal.throwIfAborted();
      if (!await authorized(scope, signal)) return undefined;
      const loaded = await dependencies.state.read(scope, signal);
      if (!loaded.ok) return undefined;
      const projected = transform(loaded.snapshot);
      if (projected === undefined) return undefined;
      if (canonicalJson(projected.records) === canonicalJson(records(loaded.snapshot))) return projected.value;
      const result = await dependencies.mutations.runPreparedMutation(
        { scope, plugins: [], expectedGeneration: loaded.snapshot.generation },
        async ({ snapshot }) => {
          const current = transform(snapshot);
          if (current === undefined) throw new Error("NOTICE_AUTHORITY_STALE");
          return {
            mutation: replaceRecords(snapshot, current.records, dependencies.sha256),
            value: current.value,
            beforeCommit: async () => {
              if (!await authorized(scope, signal)) throw new Error("PROJECT_AUTHORITY_STALE");
            },
          };
        },
        signal,
      );
      if (result.kind === "committed") return result.value;
    }
    return undefined;
  }

  async function snapshots(signal: AbortSignal): Promise<readonly GenerationSnapshot[]> {
    const values: GenerationSnapshot[] = [];
    for (const scope of await scopes(signal)) {
      if (!await authorized(scope, signal)) continue;
      const loaded = await dependencies.state.read(scope, signal);
      if (loaded.ok) values.push(loaded.snapshot);
    }
    return values;
  }

  async function list(request: NativeUpdateNotificationListRequest, signal: AbortSignal): Promise<NativeUpdateNotificationPage> {
    const parsed = NativeUpdateNotificationListRequestSchema.parse(request);
    const all = (await snapshots(signal)).flatMap((snapshot) => records(snapshot).flatMap((record) => record.notices))
      .filter((notice) => parsed.scope === "all-current" || notice.scope.kind === parsed.scope)
      .filter((notice) => parsed.plugin === undefined || notice.plugin === parsed.plugin)
      .sort(noticeOrder);
    const start = parsed.after === undefined ? 0 : Math.max(0, all.findIndex((notice) => notice.id === parsed.after) + 1);
    const page = all.slice(start, start + parsed.limit);
    const next = start + parsed.limit < all.length ? page.at(-1)?.id : undefined;
    return NativeUpdateNotificationPageSchema.parse({
      notices: page.map((notice) => ({
        id: notice.id,
        scope: notice.scope,
        plugin: notice.plugin,
        installed: notice.display.installed,
        available: notice.display.available,
        disposition: notice.disposition,
        unread: notice.unread,
        unresolved: notice.resolution === undefined,
        discoveredAt: notice.discoveredAt,
      })),
      unreadCount: all.filter((notice) => notice.unread).length,
      unresolvedCount: all.filter((notice) => notice.resolution === undefined).length,
      ...(next === undefined ? {} : { next }),
    });
  }

  async function record(discoveries: readonly ExactUpdateDiscovery[], signal: AbortSignal): Promise<readonly UpdateNoticeId[]> {
    const parsed = discoveries.map((discovery) => ({
      ...discovery,
      scope: ScopeContextSchema.parse(discovery.scope),
      plugin: PluginKeySchema.parse(discovery.plugin),
      candidate: UpdateCandidateKeySchema.parse(discovery.candidate),
      available: AvailableRevisionSchema.parse(discovery.available),
    }));
    const created: UpdateNoticeId[] = [];
    for (const scope of await scopes(signal)) {
      const selected = parsed.filter((discovery) => sameScope(toScopeReference(discovery.scope), toScopeReference(scope)));
      if (selected.length === 0) continue;
      const result = await mutateScope(scope, (snapshot) => {
        const next = [...records(snapshot)];
        const added: UpdateNoticeId[] = [];
        for (const discovery of selected) {
          const index = next.findIndex((record) => deriveMarketplaceRegistrationId({ scope: toScopeReference(scope), source: record.source }, dependencies.sha256) === discovery.registrationId);
          if (index < 0) continue;
          const record = next[index]!;
          const id = deriveUpdateNoticeId({ scope: toScopeReference(scope), plugin: discovery.plugin, candidate: discovery.candidate }, dependencies.sha256);
          if (record.notices.some((notice) => notice.id === id || notice.candidate === discovery.candidate)) continue;
          const notice = UpdateNoticeSchema.parse({
            id,
            scope: toScopeReference(scope),
            plugin: discovery.plugin,
            registrationId: discovery.registrationId,
            snapshot: discovery.snapshot,
            candidateId: discovery.candidateId,
            candidate: discovery.candidate,
            available: discovery.available,
            display: discovery.display,
            disposition: discovery.disposition ?? "manual-required",
            publication: "pending",
            unread: true,
            discoveredAt: dependencies.clock.nowEpochMilliseconds(),
          });
          next[index] = MarketplaceRegistrationRecordSchema.parse({ ...record, notices: [...record.notices, notice] });
          added.push(id);
        }
        return { records: next, value: added };
      }, signal);
      if (result !== undefined) created.push(...result);
    }
    return created.sort(compareUtf8);
  }

  async function dispatch(request: Readonly<{ limit?: number }>, signal: AbortSignal): Promise<UpdateNotificationDispatchResult> {
    const limit = request.limit ?? UpdateNoticeRetentionPolicy.dispatchLimit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > UpdateNoticeRetentionPolicy.dispatchLimit) throw new TypeError("notification dispatch limit is invalid");
    const pending = (await snapshots(signal)).flatMap((snapshot) => records(snapshot).flatMap((record) => record.notices.map((notice) => ({ scope: snapshot.scope, notice }))))
      .filter(({ notice }) => notice.publication === "pending")
      .sort((left, right) => noticeOrder(left.notice, right.notice));
    if (dependencies.publisher === undefined) return { published: [], pending: pending.length, failed: 0 };
    const published: UpdateNoticeId[] = [];
    let failed = 0;
    for (const entry of pending.slice(0, limit)) {
      try {
        if (!await authorized(entry.scope, signal)) continue;
        await dependencies.publisher.publish({
          id: entry.notice.id,
          scope: entry.notice.scope,
          plugin: entry.notice.plugin,
          installed: entry.notice.display.installed,
          available: entry.notice.display.available,
          disposition: entry.notice.disposition,
        }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        failed += 1;
        continue;
      }
      const committed = await mutateScope(entry.scope, (snapshot) => {
        let found = false;
        const next = records(snapshot).map((record) => MarketplaceRegistrationRecordSchema.parse({
          ...record,
          notices: record.notices.map((notice) => {
            if (notice.id !== entry.notice.id || notice.publication === "published") return notice;
            found = true;
            return UpdateNoticeSchema.parse({ ...notice, publication: "published" });
          }),
        }));
        return found ? { records: next, value: entry.notice.id } : undefined;
      }, signal);
      if (committed !== undefined) published.push(committed);
    }
    const pendingCount = (await snapshots(signal)).flatMap((snapshot) => records(snapshot).flatMap((record) => record.notices)).filter((notice) => notice.publication === "pending").length;
    return { published, pending: pendingCount, failed };
  }

  async function acknowledge(request: NativeUpdateAcknowledgmentRequest, signal: AbortSignal): Promise<NativeUpdateAcknowledgmentResult> {
    const parsed = NativeUpdateAcknowledgmentRequestSchema.parse(request);
    const wanted = new Set(parsed.ids);
    const acknowledged: UpdateNoticeId[] = [];
    const alreadyRead: UpdateNoticeId[] = [];
    for (const scope of await scopes(signal)) {
      const result = await mutateScope(scope, (snapshot) => {
        let changed = false;
        const foundAck: UpdateNoticeId[] = [];
        const foundRead: UpdateNoticeId[] = [];
        const next = records(snapshot).map((record) => MarketplaceRegistrationRecordSchema.parse({
          ...record,
          notices: record.notices.map((notice) => {
            if (!wanted.has(notice.id)) return notice;
            if (!notice.unread) { foundRead.push(notice.id); return notice; }
            changed = true;
            foundAck.push(notice.id);
            return UpdateNoticeSchema.parse({ ...notice, unread: false, acknowledgedAt: dependencies.clock.nowEpochMilliseconds() });
          }),
        }));
        return { records: changed ? next : records(snapshot), value: { acknowledged: foundAck, alreadyRead: foundRead } };
      }, signal);
      if (result !== undefined) {
        acknowledged.push(...result.acknowledged);
        alreadyRead.push(...result.alreadyRead);
      }
    }
    const page = await list({ scope: "all-current", limit: 1 }, signal);
    const found = new Set([...acknowledged, ...alreadyRead]);
    return NativeUpdateAcknowledgmentResultSchema.parse({
      acknowledged: [...new Set(acknowledged)].sort(compareUtf8),
      alreadyRead: [...new Set(alreadyRead)].sort(compareUtf8),
      missing: parsed.ids.filter((id) => !found.has(id)).sort(compareUtf8),
      unreadCount: page.unreadCount,
      unresolvedCount: page.unresolvedCount,
    });
  }

  async function reconcile(signal: AbortSignal): Promise<NativeUpdateNoticeReconciliationResult> {
    const resolved: UpdateNoticeId[] = [];
    let pruned = 0;
    for (const scope of await scopes(signal)) {
      const result = await mutateScope(scope, (snapshot) => {
        const installed = "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins;
        const resolvedHere: UpdateNoticeId[] = [];
        let removed = 0;
        const next = records(snapshot).map((record) => {
          const newestByPlugin = new Map<string, UpdateNotice>();
          for (const notice of record.notices.filter((notice) => notice.resolution === undefined)) {
            const current = newestByPlugin.get(notice.plugin);
            if (current === undefined || notice.discoveredAt > current.discoveredAt || notice.discoveredAt === current.discoveredAt && compareUtf8(notice.id, current.id) > 0) newestByPlugin.set(notice.plugin, notice);
          }
          const reconciled = record.notices.map((notice) => {
            if (notice.resolution !== undefined) return notice;
            const plugin = installed.find((candidate) => candidate.plugin === notice.plugin);
            const now = dependencies.clock.nowEpochMilliseconds();
            const kind = plugin === undefined ? "plugin-removed" as const :
              plugin.selectedRevision === notice.available.immutableRevision ? "installed" as const :
              newestByPlugin.get(notice.plugin)?.id !== notice.id ? "superseded" as const : undefined;
            if (kind === undefined) return notice;
            resolvedHere.push(notice.id);
            return UpdateNoticeSchema.parse({
              ...notice,
              resolution: { kind, at: now },
              ...(kind === "installed" && notice.automatic?.state === "applied" ? {} : {}),
            });
          });
          const retained = pruneUpdateNotices(reconciled);
          removed += reconciled.length - retained.length;
          return MarketplaceRegistrationRecordSchema.parse({ ...record, notices: retained });
        });
        return { records: next, value: { resolved: resolvedHere, pruned: removed } };
      }, signal);
      if (result !== undefined) {
        resolved.push(...result.resolved);
        pruned += result.pruned;
      }
    }
    const page = await list({ scope: "all-current", limit: 1 }, signal);
    return { resolved: [...new Set(resolved)].sort(compareUtf8), pruned, unreadCount: page.unreadCount, unresolvedCount: page.unresolvedCount };
  }

  return Object.freeze({ record, dispatch, list, acknowledge, reconcile });
}

export type { UpdateNotificationPublisherPort } from "./ports/update-notification-publisher.js";
