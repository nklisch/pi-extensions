import {
  MarketplaceRegistrationViewSchema,
  type MarketplaceCacheStatus,
  type MarketplaceRegistrationView,
} from "./marketplace-management-contract.js";
import {
  deriveMarketplaceRegistrationId,
  deriveMarketplaceSnapshotToken,
} from "../domain/marketplace-registration.js";
import {
  deriveMarketplaceSourceIdentity,
  type MarketplaceRegistrationRecord,
} from "../domain/update-policy.js";
import type { MarketplaceSnapshotRecord } from "../domain/state/installed-state.js";
import { toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import type { ContentStorePort } from "./ports/content-store.js";
import type { Sha256 } from "../domain/source.js";

export function codePointCompare(left: string, right: string): number {
  if (left === right) return 0;
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function registrationSort(left: MarketplaceRegistrationView, right: MarketplaceRegistrationView): number {
  if (left.scope.kind !== right.scope.kind) return left.scope.kind === "user" ? -1 : 1;
  return codePointCompare(left.marketplace, right.marketplace) || codePointCompare(left.id, right.id);
}

function initialCacheStatus(
  record: MarketplaceRegistrationRecord,
  snapshot: MarketplaceSnapshotRecord | undefined,
  now: number,
): MarketplaceCacheStatus {
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

function cacheFailure(error: unknown): MarketplaceCacheStatus {
  if (error !== null && typeof error === "object" && "code" in error &&
      ((error as { code?: unknown }).code === "CONTENT_INVALID" ||
       (error as { code?: unknown }).code === "CONTENT_DIGEST_MISMATCH" ||
       (error as { code?: unknown }).code === "CONTENT_VERIFICATION_FAILED")) {
    return { kind: "corrupt" };
  }
  return { kind: "unavailable" };
}

export async function createMarketplaceRegistrationView(input: Readonly<{
  scope: ScopeContext;
  record: MarketplaceRegistrationRecord;
  snapshot?: MarketplaceSnapshotRecord;
  now: number;
  content?: ContentStorePort;
  signal: AbortSignal;
  sha256: Sha256;
}>): Promise<MarketplaceRegistrationView> {
  const scope = toScopeReference(input.scope);
  const id = deriveMarketplaceRegistrationId({ scope, source: input.record.source }, input.sha256);
  let cache = initialCacheStatus(input.record, input.snapshot, input.now);
  if (input.snapshot !== undefined && input.content !== undefined) {
    try {
      await input.content.resolveMarketplace(input.snapshot, input.signal);
    } catch (error) {
      if (input.signal.aborted) throw error;
      cache = cacheFailure(error);
    }
  }
  const selected = input.snapshot === undefined ? undefined : {
    token: deriveMarketplaceSnapshotToken({ scope, registrationId: id, snapshot: input.snapshot }, input.sha256),
    resolvedSourceHash: input.snapshot.source.sourceHash,
    revision: input.snapshot.source.revision,
    contentDigest: input.snapshot.contentDigest,
    binding: input.snapshot.binding,
    contentRef: input.snapshot.contentRef,
  };
  return MarketplaceRegistrationViewSchema.parse({
    id,
    scope,
    marketplace: input.record.marketplace,
    source: input.record.source,
    sourceIdentity: deriveMarketplaceSourceIdentity(input.record.source, input.sha256),
    origin: input.record.origin,
    updateApplication: input.record.applicationOverride === "automatic" ? "automatic" : "manual",
    refresh: input.record.refresh,
    ...(input.record.refresh.lastAttempt === undefined ? {} : { lastAttempt: input.record.refresh.lastAttempt }),
    ...(selected === undefined ? {} : { selected }),
    cache,
  });
}
