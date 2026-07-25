import type { ContentDigest } from "../../domain/content-manifest.js";
import type { PortableProjectDeclaration } from "../../domain/state/portable-project-declaration.js";
import type { ProjectIntentObservationId } from "../project-sync-contract.js";
import type { TrustedProjectRoot } from "./project-root-authority.js";
import type { ProjectIntentWriteId } from "./project-intent-write-id.js";

declare const projectIntentObservationBrand: unique symbol;
export type VerifiedProjectIntentObservation = Readonly<{
  readonly [projectIntentObservationBrand]: true;
  readonly publicId: ProjectIntentObservationId;
}>;

export type ProjectIntentReadResult =
  | Readonly<{ kind: "missing"; observation: VerifiedProjectIntentObservation }>
  | Readonly<{ kind: "found"; observation: VerifiedProjectIntentObservation; declaration: PortableProjectDeclaration; digest: ContentDigest }>
  | Readonly<{ kind: "unavailable"; code: "PROJECT_UNTRUSTED" | "PROJECT_ROOT_STALE" | "FILE_UNSAFE" | "FILE_TOO_LARGE" | "FILE_INVALID_UTF8" | "FILE_INVALID" | "ADAPTER_FAILED" }>;

export type ProjectIntentReplaceResult =
  | Readonly<{ kind: "written" | "unchanged"; observation: VerifiedProjectIntentObservation; digest: ContentDigest }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "unavailable"; code: "PROJECT_INTENT_WRITE_UNAVAILABLE" }>
  | Readonly<{ kind: "ambiguous"; expectedDigest: ContentDigest }>;

export interface ProjectIntentFilePort {
  read(root: TrustedProjectRoot, signal: AbortSignal): Promise<ProjectIntentReadResult>;
  replace(request: Readonly<{
    root: TrustedProjectRoot;
    expected: VerifiedProjectIntentObservation;
    declaration: PortableProjectDeclaration;
    writeId: ProjectIntentWriteId;
  }>, signal: AbortSignal): Promise<ProjectIntentReplaceResult>;
  cleanup(signal: AbortSignal): Promise<void>;
}
