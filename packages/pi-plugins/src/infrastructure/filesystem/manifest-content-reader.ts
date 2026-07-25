import { BoundaryError, ErrorCodeRegistry } from "../../domain/errors.js";
import type { Sha256 } from "../../domain/source.js";
import type {
  ContentReadPort,
  ManifestFileRef,
} from "../../application/ports/content-read.js";
import {
  ManifestBackedFileError,
  readManifestBackedFile,
} from "./manifest-backed-file.js";

const OPERATION = "readManifestContentFile";

function pathBoundary(message: string, cause?: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.pathContainmentFailed,
    operation: OPERATION,
    message,
    details: { operation: OPERATION, failureKind: "escape" },
    cause,
  });
}

function adapterBoundary(cause?: unknown, failureKind: "missing" | "mutated" | "unreadable" = "unreadable"): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation: OPERATION,
    message: "manifest-backed content adapter failed",
    details: { operation: OPERATION, failureKind },
    cause,
  });
}

function mapFailure(error: unknown): BoundaryError {
  if (error instanceof ManifestBackedFileError) {
    if (error.kind === "escape") return pathBoundary("manifest-backed content path is outside its root", error);
    return adapterBoundary(error, error.kind);
  }
  if (error instanceof BoundaryError) return error;
  return adapterBoundary(error);
}

/**
 * Node adapter for the exact content-read port. The shared helper owns all
 * containment, no-symlink, no-follow, bounded-read, and digest mechanics.
 */
export function createManifestContentReader(sha256: Sha256): ContentReadPort {
  if (typeof sha256 !== "function") throw new TypeError("manifest content reader requires a SHA-256 function");

  return {
    async readFile(file: ManifestFileRef, limitBytes: number, signal: AbortSignal): Promise<Uint8Array> {
      if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      try {
        return await readManifestBackedFile(file, limitBytes, sha256, signal);
      } catch (error) {
        if (signal.aborted || (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError")) {
          throw signal.reason ?? error;
        }
        throw mapFailure(error);
      }
    },
  };
}