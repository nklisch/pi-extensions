import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  ContentManifestEntrySchema,
  hashContent,
  normalizeContentPath,
  type ContentManifestEntry,
} from "../../domain/content-manifest.js";
import type { Sha256 } from "../../domain/source.js";
import type { ManifestFileRef } from "../../application/ports/content-read.js";

const CHUNK_SIZE = 64 * 1024;

type ManifestBackedFileFailureKind = "missing" | "escape" | "mutated" | "unreadable";

export class ManifestBackedFileError extends Error {
  constructor(readonly kind: ManifestBackedFileFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManifestBackedFileError";
  }
}

function classifyFsError(error: unknown, kind: ManifestBackedFileFailureKind = "unreadable"): ManifestBackedFileError {
  if (error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return new ManifestBackedFileError("missing", "manifest-backed file is missing", { cause: error });
  }
  return new ManifestBackedFileError(kind, "manifest-backed file could not be inspected", { cause: error });
}

function assertRoot(root: string): string {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
    throw new ManifestBackedFileError("escape", "manifest-backed content root is not absolute");
  }
  return resolve(root);
}

function assertEntry(entry: ContentManifestEntry): Extract<ContentManifestEntry, { kind: "file" }> {
  const parsed = ContentManifestEntrySchema.parse(entry);
  if (parsed.kind !== "file") throw new ManifestBackedFileError("mutated", "manifest-backed entry is not a file");
  return parsed;
}

export function manifestBackedFilePath(file: ManifestFileRef): string {
  const root = assertRoot(file.root);
  const entry = assertEntry(file.entry);
  let normalized: string;
  try {
    normalized = normalizeContentPath(entry.path);
  } catch (error) {
    throw new ManifestBackedFileError("escape", "manifest-backed content path is unsafe", { cause: error });
  }
  const candidate = resolve(root, ...normalized.split("/"));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate === root || !candidate.startsWith(prefix)) {
    throw new ManifestBackedFileError("escape", "manifest-backed content path escapes its root");
  }
  return candidate;
}

async function inspectPath(root: string, target: string): Promise<string> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    throw classifyFsError(error);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ManifestBackedFileError("escape", "manifest-backed content root is not a real directory");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    throw classifyFsError(error);
  }
  if (canonicalRoot !== root) {
    throw new ManifestBackedFileError("escape", "manifest-backed content root is not canonical");
  }

  const relative = target.slice(root.length).replace(/^[/\\]+/u, "");
  let current = root;
  for (const segment of relative.split(sep)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      throw classifyFsError(error);
    }
    if (stats.isSymbolicLink()) {
      throw new ManifestBackedFileError("escape", "manifest-backed content path contains a symlink");
    }
    if (current !== target && !stats.isDirectory()) {
      throw new ManifestBackedFileError("mutated", "manifest-backed content ancestor is not a directory");
    }
  }
  let targetStat;
  try {
    targetStat = await lstat(target);
  } catch (error) {
    throw classifyFsError(error);
  }
  if (targetStat.isSymbolicLink()) throw new ManifestBackedFileError("escape", "manifest-backed content target is a symlink");
  if (!targetStat.isFile()) throw new ManifestBackedFileError("mutated", "manifest-backed content target is not a regular file");
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(target);
  } catch (error) {
    throw classifyFsError(error);
  }
  const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
  if (canonicalTarget !== target || !canonicalTarget.startsWith(rootPrefix)) {
    throw new ManifestBackedFileError("escape", "manifest-backed content target escapes its root");
  }
  return canonicalTarget;
}

export async function inspectManifestBackedFile(file: ManifestFileRef, signal: AbortSignal): Promise<Readonly<{ path: string; canonicalPath: string }>> {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  const path = manifestBackedFilePath(file);
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  const canonicalPath = await inspectPath(resolve(file.root), path);
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  return Object.freeze({ path, canonicalPath });
}

/** Shared exact-file read used by the existing inspection adapter. */
export async function readManifestBackedFile(file: ManifestFileRef, limitBytes: number, sha256: Sha256, signal: AbortSignal): Promise<Uint8Array> {
  const inspected = await inspectManifestBackedFile(file, signal);
  const entry = assertEntry(file.entry);
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new ManifestBackedFileError("unreadable", "manifest content limit is invalid");
  if (entry.size > limitBytes) throw new ManifestBackedFileError("mutated", "manifest file exceeds its configured read limit");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW closes the final-component race between inspection and open.
    handle = await open(inspected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== entry.size || stats.size > limitBytes) {
      throw new ManifestBackedFileError("mutated", "manifest file changed after inspection");
    }
    const bytes = new Uint8Array(entry.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      const result = await handle.read(bytes, offset, Math.min(CHUNK_SIZE, bytes.byteLength - offset), offset);
      if (result.bytesRead <= 0) throw new ManifestBackedFileError("mutated", "manifest file ended before its declared size");
      offset += result.bytesRead;
    }
    if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    if (hashContent(bytes, sha256) !== entry.digest) throw new ManifestBackedFileError("mutated", "manifest file digest does not match");
    return bytes;
  } catch (error) {
    if (error instanceof ManifestBackedFileError || (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError")) throw error;
    throw classifyFsError(error);
  } finally {
    if (handle !== undefined) await handle.close().catch((error) => { throw classifyFsError(error); });
  }
}