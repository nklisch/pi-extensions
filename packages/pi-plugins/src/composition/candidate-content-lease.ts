import {
  CandidateContentCleanupError,
  type CandidateContentCleanupRecovery,
  type CandidateContentLease,
  type CandidateContentLeaseAdapterDependencies,
  type CandidateContentLeasePort,
  type ClaimedCandidateContent,
} from "../application/ports/candidate-content-lease.js";
import type { ResolvedMarketplaceCandidate } from "../application/marketplace-catalog-service.js";
import type { MaterializedPlugin, SourceContext } from "../application/source-materialization.js";

function sourceContext(candidate: ResolvedMarketplaceCandidate): SourceContext {
  return candidate.entry.source.value.kind === "marketplace-path"
    ? {
        kind: "marketplace",
        root: candidate.marketplace.root,
        source: candidate.marketplace.source,
        contentRootDigest: candidate.marketplace.content.rootDigest,
        content: candidate.marketplace.content,
        binding: candidate.marketplace.binding,
      }
    : { kind: "external" };
}

function createCleanupRecovery(
  discard: () => Promise<void>,
): CandidateContentCleanupRecovery {
  let settled = false;
  let inFlight: Promise<void> | undefined;
  return Object.freeze({
    async retry(): Promise<void> {
      if (settled) return;
      if (inFlight !== undefined) return inFlight;
      inFlight = discard()
        .then(() => { settled = true; })
        .finally(() => { inFlight = undefined; });
      return inFlight;
    },
  }) as CandidateContentCleanupRecovery;
}

/** One allocation, one materialization, and one transfer-or-discard owner. */
export function createCandidateContentLeasePort(
  dependencies: CandidateContentLeaseAdapterDependencies,
): CandidateContentLeasePort {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("candidate lease dependencies are required");

  const port: CandidateContentLeasePort = {
    async acquire(candidate, signal) {
      signal.throwIfAborted();
      const allocation = await dependencies.content.allocateStaging(signal);
      const cleanup = createCleanupRecovery(() =>
        dependencies.content.discardStaging(allocation, new AbortController().signal));
      let materialized;
      try {
        materialized = await dependencies.materializer.materialize(
          candidate.entry.source.value,
          sourceContext(candidate),
          allocation.slot,
          signal,
        );
      } catch (error) {
        try {
          await cleanup.retry();
        } catch (cleanupError) {
          throw new CandidateContentCleanupError(cleanup, {
            cause: new AggregateError([error, cleanupError], "candidate acquisition cleanup failed"),
          });
        }
        throw error;
      }

      let state: "owned" | "claimed" | "released" = "owned";
      let releasePromise: Promise<void> | undefined;
      const lease = {
        candidate,
        materialized,
        async claim(claimSignal: AbortSignal): Promise<ClaimedCandidateContent> {
          claimSignal.throwIfAborted();
          if (state !== "owned") throw new Error("candidate content lease is already settled");
          state = "claimed";
          return Object.freeze({ candidate, materialized, allocation });
        },
        release(): Promise<void> {
          if (state === "claimed" || state === "released") return releasePromise ?? Promise.resolve();
          releasePromise = cleanup.retry()
            .then(() => { state = "released"; })
            .catch((error) => {
              releasePromise = undefined;
              throw new CandidateContentCleanupError(cleanup, { cause: error });
            });
          return releasePromise;
        },
      } as CandidateContentLease;
      return Object.freeze(lease);
    },
    async withMaterialized<T>(candidate: ResolvedMarketplaceCandidate, signal: AbortSignal, use: (materialized: MaterializedPlugin) => Promise<T>): Promise<T> {
      const lease = await port.acquire(candidate, signal);
      let value: T | undefined;
      let failure: unknown;
      try {
        value = await use(lease.materialized);
      } catch (error) {
        failure = error;
      }
      try {
        await lease.release();
      } catch (cleanupError) {
        failure = failure === undefined ? cleanupError : new AggregateError([failure, cleanupError], "candidate staging cleanup failed");
      }
      if (failure !== undefined) throw failure;
      return value as T;
    },
  };
  return Object.freeze(port);
}
