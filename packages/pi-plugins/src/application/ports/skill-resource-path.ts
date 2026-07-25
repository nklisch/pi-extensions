import type { ManifestFileRef } from "./content-read.js";

export type SkillResourcePathFailureCode =
  | "ROOT_MISSING"
  | "ROOT_ESCAPE"
  | "ROOT_MUTATED"
  | "ROOT_UNREADABLE"
  | "ADAPTER_FAILED";

export type VerifiedSkillResourcePath = Readonly<{
  /** Ephemeral absolute path returned only to the Pi adapter. */
  path: string;
  /** Process-local canonical key for exact-file deduplication. */
  canonicalPath: string;
}>;

export type SkillResourcePathVerificationResult =
  | Readonly<{ kind: "ready"; value: VerifiedSkillResourcePath }>
  | Readonly<{ kind: "failed"; code: SkillResourcePathFailureCode }>
  | Readonly<{ kind: "cancelled" }>;

export interface SkillResourcePathPort {
  verify(file: ManifestFileRef, signal: AbortSignal): Promise<SkillResourcePathVerificationResult>;
}
