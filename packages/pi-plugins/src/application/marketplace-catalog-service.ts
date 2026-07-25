import {
  MarketplaceCatalogPageSchema,
  MarketplaceCatalogSearchRequestSchema,
  MarketplaceCandidateDetailResultSchema,
  MarketplaceCandidateDetailSchema,
  MarketplaceCandidateSummarySchema,
  MarketplaceCatalogObservationSchema,
  type MarketplaceCatalogPage,
  type MarketplaceCatalogSearchRequest,
  type MarketplaceCandidateDetailResult,
} from "./marketplace-catalog-contract.js";
import {
  deriveMarketplaceCandidateId,
  deriveMarketplaceRegistrationId,
  deriveMarketplaceSnapshotToken,
  MarketplaceCandidateIdSchema,
  MarketplaceSnapshotTokenSchema,
  type MarketplaceCandidateId,
  type MarketplaceSnapshotToken,
} from "../domain/marketplace-registration.js";
import {
  derivePluginSourceIdentity,
} from "../domain/update-policy.js";
import {
  createResolvedMarketplaceSource,
  type Sha256,
} from "../domain/source.js";
import {
  ScopeContextSchema,
  toScopeReference,
  type ScopeContext,
} from "../domain/state/scope.js";
import type { MarketplaceSnapshotRecord } from "../domain/state/installed-state.js";
import type { NormalizedMarketplaceEntry } from "../domain/marketplace.js";
import type { ContentStorePort } from "./ports/content-store.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { MarketplaceInspectionService } from "./marketplace-inspection-contract.js";
import {
  marketplaceSnapshots,
  marketplaceUpdateRecords,
} from "./marketplace-update-state.js";
import {
  createMarketplaceRegistrationView,
  codePointCompare,
} from "./marketplace-state.js";
import {
  normalizeMarketplaceQuery,
  paginateMarketplaceCandidates,
  queryFingerprint,
  type SearchableMarketplaceCandidate,
} from "./marketplace-search.js";

const resolvedCandidateBrand: unique symbol = Symbol("ResolvedMarketplaceCandidate");

export type ResolvedMarketplaceCandidate = Readonly<{
  readonly [resolvedCandidateBrand]: true;
  id: MarketplaceCandidateId;
  scope: ScopeContext;
  registrationId: import("../domain/marketplace-registration.js").MarketplaceRegistrationId;
  snapshot: MarketplaceSnapshotToken;
  snapshotRecord: MarketplaceSnapshotRecord;
  marketplace: Readonly<{
    root: string;
    source: import("../domain/source.js").ResolvedMarketplaceSource;
    content: import("../domain/content-manifest.js").ContentManifest;
    binding: import("../domain/content-manifest.js").ContentDigest;
  }>;
  entry: NormalizedMarketplaceEntry;
}>;

export type ResolvedMarketplaceCandidateResult =
  | Readonly<{ kind: "resolved"; candidate: ResolvedMarketplaceCandidate }>
  | Readonly<{ kind: "candidate-stale" | "candidate-missing" | "catalog-unavailable" }>;

export interface MarketplaceCatalogService {
  search(request: MarketplaceCatalogSearchRequest, signal: AbortSignal): Promise<MarketplaceCatalogPage>;
  detail(request: Readonly<{ candidateId: MarketplaceCandidateId; snapshot: MarketplaceSnapshotToken }>, signal: AbortSignal): Promise<MarketplaceCandidateDetailResult>;
  resolve(request: Readonly<{ candidateId: MarketplaceCandidateId; snapshot: MarketplaceSnapshotToken }>, signal: AbortSignal): Promise<ResolvedMarketplaceCandidateResult>;
}

export type MarketplaceCatalogServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  content: ContentStorePort;
  inspection: MarketplaceInspectionService;
  clock: LifecycleClock;
  sha256: Sha256;
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
}>;

type ProjectedCandidate = SearchableMarketplaceCandidate & Readonly<{
  detail: z.infer<typeof MarketplaceCandidateDetailSchema>;
  resolved: ResolvedMarketplaceCandidate;
}>;

type Projection = Readonly<{
  candidates: readonly ProjectedCandidate[];
  observations: readonly z.infer<typeof MarketplaceCatalogObservationSchema>[];
  currentSnapshots: ReadonlySet<MarketplaceSnapshotToken>;
  unavailableSnapshots: ReadonlySet<MarketplaceSnapshotToken>;
  snapshotHash: string;
}>;

import { z } from "zod";

function abortIfRequested(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const member = Object.getOwnPropertyDescriptor(object, key)?.value;
    if (member !== undefined) deepFreeze(member, seen);
  }
  return Object.freeze(value);
}

function provenance(claims: readonly import("../domain/provenance.js").Provenance[]) {
  const values = claims.map((claim) => ({
    host: claim.location.host,
    documentKind: claim.location.documentKind,
    path: claim.location.path,
    ...(claim.location.pointer === undefined ? {} : { pointer: claim.location.pointer }),
    ...(claim.location.line === undefined ? {} : { line: claim.location.line }),
    ...(claim.location.column === undefined ? {} : { column: claim.location.column }),
  }));
  return values.filter((candidate, index) => values.findIndex((value) => JSON.stringify(value) === JSON.stringify(candidate)) === index)
    .sort((left, right) => codePointCompare(JSON.stringify(left), JSON.stringify(right)));
}

function safeMetadata(entry: NormalizedMarketplaceEntry): readonly Readonly<{ key: string; values: readonly string[] }>[] {
  return entry.metadata.flatMap((metadata) => {
    if (!/(?:^|[.:_-])(category|categories|tag|tags|interface|interfaces)$/iu.test(metadata.key)) return [];
    const value = metadata.claimed.value;
    const values = typeof value === "string" ? [value] : Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
    return values.length === 0 ? [] : [{ key: metadata.key, values: [...new Set(values)].sort(codePointCompare) }];
  }).sort((left, right) => codePointCompare(left.key, right.key));
}

function availability(entry: NormalizedMarketplaceEntry) {
  return entry.policy?.availability.value ?? "available";
}

function availableRevision(entry: NormalizedMarketplaceEntry, snapshot: MarketplaceSnapshotToken, marketplaceRevision: string, sourceIdentity: string) {
  const declaredVersion = entry.version?.value;
  if (entry.source.value.kind === "marketplace-path") {
    return {
      kind: "marketplace-snapshot" as const,
      marketplaceRevision,
      snapshot,
      ...(declaredVersion === undefined ? {} : { declaredVersion }),
    };
  }
  const source = entry.source.value;
  const selector = source.kind === "npm" ? source.selector
    : source.sha ?? source.ref;
  return {
    kind: "declared-selector" as const,
    sourceIdentity,
    ...(selector === undefined ? {} : { selector }),
    ...(declaredVersion === undefined ? {} : { declaredVersion }),
  };
}

function observationStatus(cache: import("./marketplace-management-contract.js").MarketplaceCacheStatus): "ready" | "stale" | "unavailable" | "corrupt" {
  if (cache.kind === "stale") return "stale";
  if (cache.kind === "corrupt") return "corrupt";
  if (cache.kind === "unavailable" || cache.kind === "not-materialized") return "unavailable";
  return "ready";
}

function unavailableKind(error: unknown): "unavailable" | "corrupt" {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "CONTENT_INVALID" || code === "CONTENT_DIGEST_MISMATCH" || code === "CONTENT_VERIFICATION_FAILED" || code === "MARKETPLACE_ROOT_INVALID") return "corrupt";
  }
  return "unavailable";
}

function requestedScopes(selection: MarketplaceCatalogSearchRequest["scope"], project?: Extract<ScopeContext, { kind: "project" }>): readonly ScopeContext[] {
  const scopes: ScopeContext[] = [];
  if (selection === "user" || selection === "all-current") scopes.push(ScopeContextSchema.parse({ kind: "user" }));
  if ((selection === "project" || selection === "all-current") && project !== undefined) scopes.push(project);
  return scopes;
}

export function createMarketplaceCatalogService(dependencies: MarketplaceCatalogServiceDependencies): MarketplaceCatalogService {
  if (typeof dependencies.sha256 !== "function") throw new TypeError("marketplace catalog requires SHA-256");

  async function projectWithSnapshot(
    scopeSelection: MarketplaceCatalogSearchRequest["scope"],
    marketplaceIds: readonly import("../domain/marketplace-registration.js").MarketplaceRegistrationId[] | undefined,
    loaded: Awaited<ReturnType<MarketplaceCatalogServiceDependencies["state"]["read"]>>,
    signal: AbortSignal,
  ): Promise<Projection> {
    const candidates: ProjectedCandidate[] = [];
    const observations: z.infer<typeof MarketplaceCatalogObservationSchema>[] = [];
    const fingerprint: unknown[] = [];
    const currentSnapshots = new Set<MarketplaceSnapshotToken>();
    const unavailableSnapshots = new Set<MarketplaceSnapshotToken>();
    const filter = marketplaceIds === undefined ? undefined : new Set(marketplaceIds);

    const targets = requestedScopes(scopeSelection, dependencies.currentProject);
    if (targets.length > 0 && loaded.ok) {
      // Marketplace configuration is host-global and lives in the user state
      // document. Candidate scope is the requested plugin installation target,
      // not the marketplace registration's storage location.
      const registryScope = ScopeContextSchema.parse({ kind: "user" });
      const registryReference = toScopeReference(registryScope);
      abortIfRequested(signal);
      for (const record of [...marketplaceUpdateRecords(loaded.snapshot)].sort((left, right) => codePointCompare(left.marketplace, right.marketplace))) {
        const registrationId = deriveMarketplaceRegistrationId({ scope: registryReference, source: record.source }, dependencies.sha256);
        if (filter !== undefined && !filter.has(registrationId)) continue;
        const snapshot = marketplaceSnapshots(loaded.snapshot).find((candidate) => candidate.marketplace === record.marketplace);
        const tokens = snapshot === undefined ? [] : targets.map((target) => ({
          target,
          token: deriveMarketplaceSnapshotToken({ scope: toScopeReference(target), registrationId, snapshot }, dependencies.sha256),
        }));
        fingerprint.push({ generation: loaded.snapshot.generation, registrationId, snapshots: tokens.map(({ target, token }) => ({ scope: toScopeReference(target), token })) });
        for (const { token } of tokens) currentSnapshots.add(token);
        const view = await createMarketplaceRegistrationView({
          scope: registryScope,
          record,
          ...(snapshot === undefined ? {} : { snapshot }),
          now: dependencies.clock.nowEpochMilliseconds(),
          content: dependencies.content,
          signal,
          sha256: dependencies.sha256,
        });
        if (snapshot === undefined || view.cache.kind === "unavailable" || view.cache.kind === "corrupt" || view.cache.kind === "not-materialized") {
          observations.push(MarketplaceCatalogObservationSchema.parse({ registrationId, marketplace: record.marketplace, status: observationStatus(view.cache), cache: view.cache }));
          for (const { token } of tokens) unavailableSnapshots.add(token);
          continue;
        }

        try {
          const root = await dependencies.content.resolveMarketplace(snapshot, signal);
          const source = createResolvedMarketplaceSource({ declared: record.source, revision: snapshot.source.revision }, dependencies.sha256);
          if (source.hash !== snapshot.source.sourceHash || root.manifest.rootDigest !== snapshot.contentDigest) throw Object.assign(new Error("selected marketplace evidence is corrupt"), { code: "CONTENT_INVALID" });
          const catalog = await dependencies.inspection.inspect({ root: root.root, source, content: root.manifest, binding: snapshot.binding }, signal);
          if (catalog.marketplace.name.value !== record.marketplace) throw Object.assign(new Error("selected catalog root changed"), { code: "CONTENT_INVALID" });
          observations.push(MarketplaceCatalogObservationSchema.parse({ registrationId, marketplace: record.marketplace, status: observationStatus(view.cache), cache: view.cache }));
          const marketplaceProvenance = provenance(catalog.marketplace.sourceDocuments);
          for (const entry of catalog.marketplace.entries) for (const { target, token } of tokens) {
            const targetReference = toScopeReference(target);
            const sourceIdentity = derivePluginSourceIdentity(entry.source.value, dependencies.sha256);
            const id = deriveMarketplaceCandidateId({ snapshot: token, plugin: entry.identity.value.key, source: entry.source.value }, dependencies.sha256);
            const entryProvenance = provenance(entry.source.provenance);
            const metadata = safeMetadata(entry);
            const summary = MarketplaceCandidateSummarySchema.parse({
              id,
              snapshot: token,
              scope: targetReference,
              registrationId,
              plugin: entry.identity.value.key,
              marketplace: record.marketplace,
              name: entry.identity.value.marketplaceEntryName,
              ...(entry.description === undefined ? {} : { description: entry.description.value }),
              available: availableRevision(entry, token, snapshot.source.revision, sourceIdentity),
              availability: availability(entry),
              source: entry.source.value,
              sourceIdentity,
              provenance: entryProvenance,
              trust: "untrusted-not-inspected",
            });
            const detail = MarketplaceCandidateDetailSchema.parse({
              ...summary,
              marketplaceRevision: snapshot.source.revision,
              marketplaceContentDigest: snapshot.contentDigest,
              marketplaceBinding: snapshot.binding,
              marketplaceProvenance,
              metadata,
            });
            const resolved = deepFreeze({
              [resolvedCandidateBrand]: true as const,
              id,
              scope: target,
              registrationId,
              snapshot: token,
              snapshotRecord: snapshot,
              marketplace: { root: root.root, source, content: root.manifest, binding: snapshot.binding },
              entry,
            });
            candidates.push({
              summary,
              detail,
              resolved,
              safeSearchValues: [
                summary.plugin,
                summary.name,
                summary.marketplace,
                entry.version?.value ?? "",
                entry.description?.value ?? "",
                ...metadata.flatMap((item) => [item.key, ...item.values]),
              ],
              sort: [target.kind, record.marketplace, summary.name, entry.version?.value ?? "", id],
            });
          }
        } catch (error) {
          if (signal.aborted) throw error;
          const kind = unavailableKind(error);
          const cache = { kind } as const;
          const index = observations.findIndex((observation) => observation.registrationId === registrationId);
          const replacement = MarketplaceCatalogObservationSchema.parse({ registrationId, marketplace: record.marketplace, status: kind, cache });
          if (index >= 0) observations[index] = replacement;
          else observations.push(replacement);
          for (const { token } of tokens) unavailableSnapshots.add(token);
        }
      }
    }
    observations.sort((left, right) => codePointCompare(left.registrationId, right.registrationId));
    return {
      candidates,
      observations,
      currentSnapshots,
      unavailableSnapshots,
      snapshotHash: queryFingerprint(fingerprint, dependencies.sha256),
    };
  }

  // Projections derive only from the user-registry generation, the scope
  // selection, and verified (cache-fingerprinted) store content. Control
  // reads routinely project the same catalog several times per command
  // (evidence capture per scope, then the command's own search/resolve), so
  // memoize on the generation that anchors correctness. The TTL bounds how
  // long clock-driven cache staleness (refresh schedules) can lag.
  const PROJECTION_TTL_MS = 30_000;
  const projectionCache = new Map<string, Readonly<{ expires: number; value: Promise<Projection> }>>();

  async function project(
    scopeSelection: MarketplaceCatalogSearchRequest["scope"],
    marketplaceIds: readonly import("../domain/marketplace-registration.js").MarketplaceRegistrationId[] | undefined,
    signal: AbortSignal,
  ): Promise<Projection> {
    abortIfRequested(signal);
    const registryScope = ScopeContextSchema.parse({ kind: "user" });
    const loaded = await dependencies.state.read(registryScope, signal);
    const generation = loaded.ok ? loaded.snapshot.generation : "unavailable";
    const key = JSON.stringify([
      scopeSelection,
      marketplaceIds === undefined ? null : [...marketplaceIds].sort(codePointCompare),
      generation,
      dependencies.currentProject?.projectKey ?? null,
    ]);
    const now = dependencies.clock.nowEpochMilliseconds();
    const cached = projectionCache.get(key);
    if (cached !== undefined && cached.expires > now) {
      return cached.value.then((projection) => { signal.throwIfAborted(); return projection; });
    }
    const value = projectWithSnapshot(scopeSelection, marketplaceIds, loaded, signal);
    projectionCache.set(key, Object.freeze({ expires: now + PROJECTION_TTL_MS, value }));
    if (projectionCache.size > 8) {
      const oldest = projectionCache.keys().next().value;
      if (oldest !== undefined && oldest !== key) projectionCache.delete(oldest);
    }
    try {
      return await value;
    } catch (error) {
      if (projectionCache.get(key)?.value === value) projectionCache.delete(key);
      throw error;
    }
  }

  async function exactCandidate(request: Readonly<{ candidateId: MarketplaceCandidateId; snapshot: MarketplaceSnapshotToken }>, signal: AbortSignal) {
    const candidateId = MarketplaceCandidateIdSchema.parse(request.candidateId);
    const snapshot = MarketplaceSnapshotTokenSchema.parse(request.snapshot);
    const projection = await project("all-current", undefined, signal);
    if (!projection.currentSnapshots.has(snapshot)) return { kind: "candidate-stale" as const };
    if (projection.unavailableSnapshots.has(snapshot)) return { kind: "catalog-unavailable" as const };
    const candidate = projection.candidates.find((item) => item.summary.snapshot === snapshot && item.summary.id === candidateId);
    if (candidate === undefined) return { kind: "candidate-missing" as const };
    return { kind: "found" as const, candidate };
  }

  const service: MarketplaceCatalogService = {
    async search(request, signal) {
      abortIfRequested(signal);
      const parsed = MarketplaceCatalogSearchRequestSchema.parse(request);
      const tokens = normalizeMarketplaceQuery(parsed.query);
      const projection = await project(parsed.scope, parsed.marketplaceIds, signal);
      const queryHash = queryFingerprint({
        scope: parsed.scope,
        marketplaceIds: parsed.marketplaceIds === undefined ? null : [...parsed.marketplaceIds].sort(codePointCompare),
        query: tokens,
        availability: parsed.availability === undefined ? null : [...parsed.availability].sort(codePointCompare),
      }, dependencies.sha256);
      const filtered = parsed.availability === undefined
        ? projection.candidates
        : projection.candidates.filter((candidate) => parsed.availability!.includes(candidate.summary.availability));
      const page = paginateMarketplaceCandidates({
        candidates: filtered,
        tokens,
        limit: parsed.limit,
        queryHash,
        snapshotHash: projection.snapshotHash,
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      });
      return MarketplaceCatalogPageSchema.parse({ ...page, observations: projection.observations });
    },
    async detail(request, signal) {
      const result = await exactCandidate(request, signal);
      if (result.kind !== "found") return MarketplaceCandidateDetailResultSchema.parse(result);
      return MarketplaceCandidateDetailResultSchema.parse({ kind: "found", candidate: result.candidate.detail });
    },
    async resolve(request, signal) {
      const result = await exactCandidate(request, signal);
      if (result.kind !== "found") return result;
      return { kind: "resolved" as const, candidate: result.candidate.resolved };
    },
  };
  return Object.freeze(service);
}
