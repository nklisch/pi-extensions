import { z } from "zod";
import { EpochMillisecondsSchema, type EpochMilliseconds } from "./lifecycle-clock.js";
import { RetainedArtifactRefSchema, type RetainedArtifactRef } from "./revision-artifact-store.js";

export const RevisionRetentionMarkSchema = z.object({
  reference: RetainedArtifactRefSchema,
  firstUnreferencedAt: EpochMillisecondsSchema,
}).strict().readonly();
export type RevisionRetentionMark = z.infer<typeof RevisionRetentionMarkSchema>;
export const RevisionRetentionSnapshotSchema = z.object({
  complete: z.boolean(),
  marks: z.array(RevisionRetentionMarkSchema).readonly(),
}).strict().readonly();
export type RevisionRetentionSnapshot = z.infer<typeof RevisionRetentionSnapshotSchema>;

export interface RevisionRetentionStore {
  reconcile(request: Readonly<{
    completeScanAt: EpochMilliseconds;
    referenced: readonly RetainedArtifactRef[];
    observed: readonly RetainedArtifactRef[];
  }>, signal: AbortSignal): Promise<RevisionRetentionSnapshot>;
  markRemoved(reference: RetainedArtifactRef, at: EpochMilliseconds, signal: AbortSignal): Promise<void>;
}

export type { EpochMilliseconds, RetainedArtifactRef };
