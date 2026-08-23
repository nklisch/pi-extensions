import { z } from "zod";
import { deriveMarketplaceSourceIdentity, MarketplaceUpdateRecordSchema, UpdateApplicationPreferenceSchema, type UpdateApplicationPreference } from "../domain/update-policy.js";
import { MarketplaceNameSchema, type MarketplaceName } from "../domain/identity.js";
import { ScopeContextSchema, type ScopeContext } from "../domain/state/scope.js";
import { marketplaceUpdateRecords, createMarketplaceUpdateRecordsMutation } from "./marketplace-update-state.js";
import { runScopedMutation } from "./state-transaction.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import { SourceHashSchema, type Sha256, type SourceHash } from "../domain/source.js";

export const MarketplaceUpdatePreferenceResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["changed", "unchanged"]), preference: UpdateApplicationPreferenceSchema }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: z.enum(["NOT_CONFIGURED", "SOURCE_CHANGED", "LOCAL_AUTOMATIC_FORBIDDEN", "STATE_STALE"]) }).strict().readonly(),
]);
export type MarketplaceUpdatePreferenceResult = z.infer<typeof MarketplaceUpdatePreferenceResultSchema>;


export interface MarketplaceUpdatePolicyService {
  setApplicationPreference(request: Readonly<{
    scope: ScopeContext;
    marketplace: MarketplaceName;
    sourceIdentity: SourceHash;
    preference: UpdateApplicationPreference;
  }>, signal: AbortSignal): Promise<MarketplaceUpdatePreferenceResult>;
}

export function createMarketplaceUpdatePolicyService(dependencies: Readonly<{
  state: LifecycleStateStore;
  mutations: LifecycleStateStore;
  sha256: Sha256;
}>): MarketplaceUpdatePolicyService {
  if (typeof dependencies.sha256 !== "function") throw new TypeError("update policy requires SHA-256");
  return {
    async setApplicationPreference(request, signal) {
      const scope = ScopeContextSchema.parse(request.scope);
      const marketplace = MarketplaceNameSchema.parse(request.marketplace);
      const sourceIdentity = SourceHashSchema.parse(request.sourceIdentity) as SourceHash;
      const preference = UpdateApplicationPreferenceSchema.parse(request.preference);
      const loaded = await dependencies.state.read(scope, signal);
      if (!loaded.ok) return { kind: "rejected", code: "STATE_STALE" };
      const record = marketplaceUpdateRecords(loaded.snapshot).find((candidate) => candidate.marketplace === marketplace);
      if (record === undefined) return { kind: "rejected", code: "NOT_CONFIGURED" };
      if (deriveMarketplaceSourceIdentity(record.source, dependencies.sha256) !== sourceIdentity) return { kind: "rejected", code: "SOURCE_CHANGED" };
      if (record.source.kind === "local-git" && preference === "automatic") return { kind: "rejected", code: "LOCAL_AUTOMATIC_FORBIDDEN" };
      if ((record.applicationOverride ?? "manual") === preference) return { kind: "unchanged", preference };

      try {
        const result = await runScopedMutation<UpdateApplicationPreference | MarketplaceUpdatePreferenceResult>(dependencies.mutations,
          scope,
          (snapshot) => {
            const current = marketplaceUpdateRecords(snapshot).find((candidate) => candidate.marketplace === marketplace);
            if (current === undefined) return { kind: "reject" as const, value: { kind: "rejected" as const, code: "NOT_CONFIGURED" as const } };
            if (deriveMarketplaceSourceIdentity(current.source, dependencies.sha256) !== sourceIdentity) return { kind: "reject" as const, value: { kind: "rejected" as const, code: "SOURCE_CHANGED" as const } };
            const next = MarketplaceUpdateRecordSchema.parse({ ...current, applicationOverride: preference });
            const records = marketplaceUpdateRecords(snapshot).map((candidate) => candidate.marketplace === marketplace ? next : candidate);
            return { kind: "commit" as const, mutation: createMarketplaceUpdateRecordsMutation(snapshot, records, dependencies.sha256), value: preference };
          },
          signal,
        );
        if (result.kind === "committed") return { kind: "changed", preference };
        return { kind: "rejected", code: "STATE_STALE" };
      } catch (error) {
        if (error instanceof Error && error.message === "SOURCE_CHANGED") return { kind: "rejected", code: "SOURCE_CHANGED" };
        if (error instanceof Error && error.message === "NOT_CONFIGURED") return { kind: "rejected", code: "NOT_CONFIGURED" };
        if (signal.aborted) throw signal.reason;
        return { kind: "rejected", code: "STATE_STALE" };
      }
    },
  };
}
