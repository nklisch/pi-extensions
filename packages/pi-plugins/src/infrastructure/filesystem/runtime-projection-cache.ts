import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeRuntimeProjectionCache,
  encodeRuntimeProjectionCache,
  type RuntimeProjectionCachePort,
  type RuntimeProjectionCacheReadResult,
} from "../../application/runtime-projection-cache.js";
import {
  verifyProjectionExpectation,
  type ProjectionExpectation,
} from "../../application/ports/runtime-projection.js";
import type { ContentStorePort, ProjectionRootAllocation } from "../../application/ports/content-store.js";
import type { Sha256 } from "../../domain/source.js";

const PROJECTION_FILE = "projection.json";
const READY_FILE = "READY";
const METADATA_FILE = "metadata.json";
const CLEANUP_SIGNAL = new AbortController().signal;

type RuntimeProjectionCacheDependencies = Readonly<{
  content: Pick<ContentStorePort, "allocateProjectionRoot" | "sealProjectionRoot" | "discardProjectionRoot" | "resolveProjectionRoot">;
  sha256: Sha256;
}>;

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError";
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}

function hasErrno(error: unknown, code: string, seen = new Set<object>()): boolean {
  if (error === null || typeof error !== "object") return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if ("code" in error && (error as { code?: unknown }).code === code) return true;
  if ("cause" in error) return hasErrno((error as { cause?: unknown }).cause, code, seen);
  return false;
}

function failed(code: "CACHE_MISSING" | "CACHE_CORRUPT" | "IDENTITY_COLLISION" | "ADAPTER_FAILED"): RuntimeProjectionCacheReadResult {
  return { kind: "failed", code };
}

async function assertCachePayload(root: string): Promise<Uint8Array> {
  const names = (await readdir(root)).sort();
  const expected = [METADATA_FILE, PROJECTION_FILE, READY_FILE].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("runtime projection cache contains an unexpected payload entry");
  }
  const stat = await lstat(join(root, PROJECTION_FILE));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("runtime projection cache payload is not a regular file");
  return new Uint8Array(await readFile(join(root, PROJECTION_FILE)));
}

/** Compose the filesystem cache adapter around the existing generated-root port. */
export function createRuntimeProjectionCache(
  dependencies: RuntimeProjectionCacheDependencies,
): RuntimeProjectionCachePort {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("runtime projection cache dependencies are required");
  if (typeof dependencies.sha256 !== "function") throw new TypeError("runtime projection cache requires SHA-256");

  async function prepare(input: ProjectionExpectation, signal: AbortSignal): Promise<ProjectionExpectation> {
    const expectation = verifyProjectionExpectation(input, dependencies.sha256);
    if (expectation.kind === "inactive") return expectation;
    const encoded = encodeRuntimeProjectionCache(expectation.projection, dependencies.sha256);
    let allocation: ProjectionRootAllocation | undefined;
    try {
      allocation = await dependencies.content.allocateProjectionRoot({
        scope: expectation.projection.scope,
        plugin: expectation.projection.plugin,
        projectionDigest: expectation.projection.digest,
        payloadDigest: encoded.payloadDigest,
        projectionRef: expectation.projectionRef,
      }, signal);
      await writeFile(join(allocation.root, PROJECTION_FILE), encoded.bytes, { flag: "wx", mode: 0o600 });
      await dependencies.content.sealProjectionRoot(allocation, signal);
      return expectation;
    } catch (error) {
      // The root port itself keeps an allocation safe across publication races.
      // Cleanup is only attempted through the same opaque capability and never
      // by guessing a generated path.
      if (allocation !== undefined && dependencies.content.discardProjectionRoot !== undefined) {
        await dependencies.content.discardProjectionRoot(allocation, CLEANUP_SIGNAL).catch(() => undefined);
      }
      throw error;
    }
  }

  async function read(
    input: Extract<ProjectionExpectation, { kind: "active" }>,
    signal: AbortSignal,
  ): Promise<RuntimeProjectionCacheReadResult> {
    try {
      const expectation = verifyProjectionExpectation(input, dependencies.sha256);
      if (expectation.kind !== "active") return failed("CACHE_CORRUPT");
      if (dependencies.content.resolveProjectionRoot === undefined) return failed("ADAPTER_FAILED");
      const root = await dependencies.content.resolveProjectionRoot({
        scope: expectation.projection.scope,
        plugin: expectation.projection.plugin,
        projectionDigest: expectation.projection.digest,
        projectionRef: expectation.projectionRef,
      }, signal);
      if (root.scope.kind !== expectation.projection.scope.kind ||
        (root.scope.kind === "project" && expectation.projection.scope.kind === "project" && root.scope.projectKey !== expectation.projection.scope.projectKey) ||
        root.plugin !== expectation.projection.plugin ||
        root.projectionDigest !== expectation.projection.digest ||
        root.projectionRef !== expectation.projectionRef) {
        return failed("IDENTITY_COLLISION");
      }
      const bytes = await assertCachePayload(root.root);
      const value = decodeRuntimeProjectionCache(bytes, expectation, dependencies.sha256);
      if (value.payloadDigest !== root.payloadDigest) return failed("IDENTITY_COLLISION");
      return { kind: "ready", value };
    } catch (error) {
      if (isAbort(error, signal)) return { kind: "cancelled" };
      if (hasCode(error, "STORE_IDENTITY_COLLISION")) return failed("IDENTITY_COLLISION");
      if (hasErrno(error, "ENOENT")) return failed("CACHE_MISSING");
      if (error instanceof Error && error.name === "CacheContractFailure") return failed("CACHE_CORRUPT");
      if (hasCode(error, "CONTENT_VERIFICATION_FAILED")) return failed("CACHE_CORRUPT");
      return failed("ADAPTER_FAILED");
    }
  }

  return Object.freeze({ prepare, read });
}