import { ContentManifestEntrySchema } from "../../domain/content-manifest.js";
import { BoundaryError } from "../../domain/errors.js";
import type { ContentReadPort, ManifestFileRef } from "../../application/ports/content-read.js";
import type {
  SkillResourcePathPort,
  SkillResourcePathVerificationResult,
} from "../../application/ports/skill-resource-path.js";
import {
  ManifestBackedFileError,
  inspectManifestBackedFile,
} from "./manifest-backed-file.js";

function cancelled(signal: AbortSignal): SkillResourcePathVerificationResult {
  if (!signal.aborted) return { kind: "cancelled" };
  return { kind: "cancelled" };
}

function mapFailure(error: unknown): Exclude<SkillResourcePathVerificationResult, { kind: "ready" | "cancelled" }> {
  if (error instanceof ManifestBackedFileError) {
    switch (error.kind) {
      case "missing": return { kind: "failed", code: "ROOT_MISSING" };
      case "escape": return { kind: "failed", code: "ROOT_ESCAPE" };
      case "mutated": return { kind: "failed", code: "ROOT_MUTATED" };
      case "unreadable": return { kind: "failed", code: "ROOT_UNREADABLE" };
    }
  }
  if (error instanceof BoundaryError) {
    const details = error.details;
    if (details !== undefined && details !== null && typeof details === "object" && !Array.isArray(details) && "failureKind" in details) {
      switch (details.failureKind) {
        case "missing": return { kind: "failed", code: "ROOT_MISSING" };
        case "mutated": return { kind: "failed", code: "ROOT_MUTATED" };
        case "escape": return { kind: "failed", code: "ROOT_ESCAPE" };
        case "unreadable": return { kind: "failed", code: "ROOT_UNREADABLE" };
      }
    }
    return { kind: "failed", code: error.code === "PATH_CONTAINMENT_FAILED" ? "ROOT_ESCAPE" : "ROOT_UNREADABLE" };
  }
  return { kind: "failed", code: "ROOT_UNREADABLE" };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

/** Verify exactly one manifest-selected skill file; no skill metadata is parsed. */
export function createManifestSkillPathVerifier(dependencies: Readonly<{
  content: ContentReadPort;
}>): SkillResourcePathPort {
  if (dependencies === null || typeof dependencies !== "object" || dependencies.content === null || typeof dependencies.content.readFile !== "function") {
    throw new TypeError("manifest skill path verifier requires a content reader");
  }

  async function verify(fileInput: ManifestFileRef, signal: AbortSignal): Promise<SkillResourcePathVerificationResult> {
    try {
      if (signal.aborted) return cancelled(signal);
      const entry = ContentManifestEntrySchema.parse(fileInput.entry);
      if (entry.kind !== "file") return { kind: "failed", code: "ROOT_MUTATED" };
      const file = { root: fileInput.root, entry } satisfies ManifestFileRef;
      const inspected = await inspectManifestBackedFile(file, signal);
      if (signal.aborted) return cancelled(signal);
      const bytes = await dependencies.content.readFile(file, Math.max(entry.size, 1), signal);
      if (signal.aborted) return cancelled(signal);
      if (bytes.byteLength !== entry.size) {
        return { kind: "failed", code: "ROOT_MUTATED" };
      }
      // The content port contract guarantees digest verification. Re-open the
      // exact file through the shared no-follow helper to close a verification
      // to contribution race before exposing the ephemeral path.
      const final = await inspectManifestBackedFile(file, signal);
      if (signal.aborted) return cancelled(signal);
      return { kind: "ready", value: { path: final.path, canonicalPath: final.canonicalPath } };
    } catch (error) {
      if (isAbort(error, signal)) return cancelled(signal);
      return mapFailure(error);
    }
  }

  return Object.freeze({ verify });
}