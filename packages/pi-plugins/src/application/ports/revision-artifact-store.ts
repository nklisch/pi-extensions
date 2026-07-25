import { z } from "zod";
import { MarketplaceStoreKeySchema, PluginStoreKeySchema, type MarketplaceStoreKey, type PluginStoreKey } from "../../domain/content-store.js";
import { ProjectionRootRefSchema, type ProjectionRootRef } from "../../domain/state/references.js";

export const RetainedArtifactRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("marketplace"), key: MarketplaceStoreKeySchema }).strict().readonly(),
  z.object({ kind: z.literal("plugin"), key: PluginStoreKeySchema }).strict().readonly(),
  z.object({ kind: z.literal("projection"), reference: ProjectionRootRefSchema }).strict().readonly(),
]);
export type RetainedArtifactRef = z.infer<typeof RetainedArtifactRefSchema>;

export const RevisionArtifactKindSchema = z.enum(["marketplace", "plugin", "projection"]);
export type RevisionArtifactKind = z.infer<typeof RevisionArtifactKindSchema>;
export type RevisionArtifactCandidate = Readonly<{
  kind: RevisionArtifactKind;
  key: string;
  reference: RetainedArtifactRef;
  firstObservedAt?: number;
  readonly capability: object;
}>;
export type RevisionArtifactCollection = Readonly<{
  complete: boolean;
  artifacts: readonly RevisionArtifactCandidate[];
}>;

/** The scanner issues capabilities; application code can only return them. */
export interface RevisionArtifactStore {
  scan(signal: AbortSignal): Promise<RevisionArtifactCollection>;
  remove(candidate: RevisionArtifactCandidate, signal: AbortSignal): Promise<"removed" | "already-absent">;
}

export type { MarketplaceStoreKey, PluginStoreKey, ProjectionRootRef };
