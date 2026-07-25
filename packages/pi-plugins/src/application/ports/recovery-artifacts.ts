import { z } from "zod";

export const RecoveryArtifactKindSchema = z.enum(["staging", "projection-staging", "prepared-revision"]);
export type RecoveryArtifactKind = z.infer<typeof RecoveryArtifactKindSchema>;
export const RecoveryArtifactOwnerStatusSchema = z.enum(["live", "dead", "unknown"]);
export type RecoveryArtifactOwnerStatus = z.infer<typeof RecoveryArtifactOwnerStatusSchema>;

export type RecoveryArtifactCandidate = Readonly<{
  kind: RecoveryArtifactKind;
  key: string;
  owner: RecoveryArtifactOwnerStatus;
  createdAt: number;
  /** Adapter-issued opaque authority. It is intentionally not schema-serializable. */
  readonly capability: object;
}>;

export type RecoveryArtifactScan = Readonly<{
  complete: boolean;
  candidates: readonly RecoveryArtifactCandidate[];
}>;

export interface RecoveryArtifactsPort {
  scan(signal: AbortSignal): Promise<RecoveryArtifactScan>;
  remove(candidate: RecoveryArtifactCandidate, signal: AbortSignal): Promise<"removed" | "already-absent">;
}
