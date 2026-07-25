import { z } from "zod";
import { EpochMillisecondsSchema, type EpochMilliseconds } from "./lifecycle-clock.js";
import { RetainedArtifactRefSchema, type RetainedArtifactRef } from "./revision-artifact-store.js";

export const RevisionLeaseSchema = z.object({
  leaseId: z.string().uuid(),
  sessionId: z.string().min(1).max(256),
  artifacts: z.array(RetainedArtifactRefSchema).readonly(),
  acquiredAt: EpochMillisecondsSchema,
}).strict().readonly();
export type RevisionLease = z.infer<typeof RevisionLeaseSchema>;
export const RevisionLeaseOwnerStatusSchema = z.enum(["live", "dead", "unknown", "released"]);
export type RevisionLeaseOwnerStatus = z.infer<typeof RevisionLeaseOwnerStatusSchema>;
export const RevisionLeaseCollectionSchema = z.object({
  complete: z.boolean(),
  leases: z.array(RevisionLeaseSchema).readonly(),
  owners: z.array(z.object({ leaseId: z.string().uuid(), status: RevisionLeaseOwnerStatusSchema }).strict().readonly()).readonly(),
}).strict().readonly();
export type RevisionLeaseCollection = z.infer<typeof RevisionLeaseCollectionSchema>;

export interface RevisionLeaseStore {
  acquire(request: Readonly<{ sessionId: string; artifacts: readonly RetainedArtifactRef[]; at: EpochMilliseconds }>, signal: AbortSignal): Promise<RevisionLease>;
  replace(lease: RevisionLease, artifacts: readonly RetainedArtifactRef[], at: EpochMilliseconds, signal: AbortSignal): Promise<RevisionLease>;
  release(lease: RevisionLease, at: EpochMilliseconds, signal: AbortSignal): Promise<void>;
  list(signal: AbortSignal): Promise<RevisionLeaseCollection>;
}

export type { EpochMilliseconds, RetainedArtifactRef };
