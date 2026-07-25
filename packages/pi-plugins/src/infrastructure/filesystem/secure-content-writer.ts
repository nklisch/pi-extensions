import {
  constants,
  createReadStream,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  ContentDigestSchema,
  createContentManifest,
  createMaterializationBinding,
  hashContent,
  normalizeContentLinkTarget,
  normalizeContentPath,
  verifyContentManifest,
  type ContentManifest,
  type ContentManifestEntry,
} from "../../domain/content-manifest.js";
import type { Sha256 } from "../../domain/source.js";
import {
  normalizeMarketplaceSourcePath,
  SourceMaterializationError,
} from "../../application/source-materialization.js";
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  type ContentEntry,
  type MarketplacePathAcquirer,
  type MaterializationLimits,
  type SecureContentSession,
  type SecureContentWriterFactory,
  type StagingSlot,
} from "../../application/ports/source-acquisition.js";

const encoder = new TextEncoder();
const ROOT_MODE = 0o755;
const NO_FOLLOW = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

type EffectiveLimits = MaterializationLimits;
type StoredEntry = ContentManifestEntry | Readonly<{ kind: "hardlink"; path: string; mode: 0o644 | 0o755; target: string; resolvedTarget: string }>;
type PendingLink = Readonly<{ entry: Extract<ContentEntry, { kind: "hardlink" | "symlink" }>; path: string; resolvedTarget: string; target: string; mode: 0o644 | 0o755 | 0o777 }>;
type IncrementalSha256 = Readonly<{
  update(bytes: Uint8Array): void;
  digest(): Uint8Array;
}>;
type IncrementalSha256Factory = () => IncrementalSha256;

function defaultSha256Stream(): IncrementalSha256 {
  const hash = createHash("sha256");
  return {
    update(bytes) { hash.update(bytes); },
    digest() { return new Uint8Array(hash.digest()); },
  };
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  operation: string,
  onPersisted: (bytes: Uint8Array) => void,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    const written = result.bytesWritten;
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
      throw adapterError(operation, "file write made no progress");
    }
    onPersisted(bytes.subarray(offset, offset + written));
    offset += written;
  }
}

function formatRawDigest(bytes: Uint8Array): Extract<ContentManifestEntry, { kind: "file" }>["digest"] {
  if (bytes.byteLength !== 32) throw new Error("SHA-256 function must return exactly 32 bytes");
  let value = "sha256:";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return ContentDigestSchema.parse(value);
}

function digestEqual(left: ContentManifestEntry, right: ContentManifestEntry): boolean {
  if (left.kind !== right.kind || left.path !== right.path || left.mode !== right.mode) return false;
  if (left.kind === "directory" || right.kind === "directory") return left.kind === right.kind;
  if (left.kind === "file" && right.kind === "file") return left.size === right.size && left.digest === right.digest;
  return left.kind === "symlink" && right.kind === "symlink" && left.target === right.target && left.digest === right.digest;
}

function policyError(operation: string, message: string, path?: string): SourceMaterializationError {
  return new SourceMaterializationError({
    code: "PATH_CONTAINMENT_FAILED",
    classification: "security",
    operation,
    message,
    details: {
      operation,
      ...(path === undefined ? {} : { path }),
    },
  });
}

function adapterError(operation: string, message: string, cause?: unknown): SourceMaterializationError {
  return new SourceMaterializationError({
    code: "ADAPTER_FAILED",
    classification: "permanent",
    operation,
    message,
    details: { operation },
    cause,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function limitsWithDefaults(input?: Partial<MaterializationLimits>): EffectiveLimits {
  const result = { ...DEFAULT_MATERIALIZATION_LIMITS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`materialization limit ${name} must be a positive safe integer`);
  }
  if (result.maxExpansionRatio < 1) throw new TypeError("maxExpansionRatio must be at least one");
  return Object.freeze(result);
}

function normalizeMode(kind: ContentEntry["kind"], mode: number): 0o644 | 0o755 | 0o777 {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777 || (mode & 0o7000) !== 0) {
    throw policyError("writeContentEntry", "entry mode contains unsupported special bits");
  }
  if (kind === "directory") return 0o755;
  if (kind === "symlink") return 0o777;
  return mode & 0o111 ? 0o755 : 0o644;
}

function pathCollisionKey(path: string): string {
  return normalizeContentPath(path).toLowerCase();
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.byteLength - b.byteLength;
}

async function readDiskManifest(
  root: string,
  sha256: Sha256,
  sha256Stream: IncrementalSha256Factory,
  limits?: Partial<MaterializationLimits>,
): Promise<ContentManifest> {
  const effective = limitsWithDefaults(limits);
  const canonicalRoot = await realpath(root);
  await assertDirectory(canonicalRoot, "verifyMaterializedContent");
  const entries: ContentManifestEntry[] = [];
  const seenPaths = new Set<string>();
  let totalPathBytes = 0;
  let totalBytes = 0;
  const reservePath = (path: string): string => {
    let normalized: string;
    try { normalized = normalizeContentPath(path); }
    catch (error) { throw policyError("verifyMaterializedContent", "content path is unsafe", path); }
    const pathLength = encoder.encode(normalized).byteLength;
    if (pathLength > effective.maxPathBytes) throw policyError("verifyMaterializedContent", "path length limit exceeded", normalized);
    for (const segment of normalized.split("/")) {
      if (encoder.encode(segment).byteLength > effective.maxSegmentBytes) throw policyError("verifyMaterializedContent", "path segment length limit exceeded", normalized);
    }
    totalPathBytes += pathLength;
    if (totalPathBytes > effective.maxTotalPathBytes) throw policyError("verifyMaterializedContent", "aggregate path limit exceeded", normalized);
    const key = normalized.normalize("NFC").toLowerCase();
    if (seenPaths.has(key)) throw policyError("verifyMaterializedContent", "duplicate or colliding path", normalized);
    seenPaths.add(key);
    if (entries.length >= effective.maxEntries) throw policyError("verifyMaterializedContent", "entry count limit exceeded", normalized);
    return normalized;
  };
  const appendEntry = (entry: ContentManifestEntry): void => {
    if (entries.length >= effective.maxEntries) throw policyError("verifyMaterializedContent", "entry count limit exceeded", entry.path);
    entries.push(entry);
  };
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > effective.maxEntries) throw policyError("verifyMaterializedContent", "content tree depth limit exceeded", prefix);
    const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name));
    // A directory listing gives us a cheap upper bound. Reject the whole
    // batch before lstat, realpath, or file hashing if it cannot fit.
    if (entries.length + children.length > effective.maxEntries) {
      throw policyError("verifyMaterializedContent", "entry count limit exceeded", prefix);
    }
    const pending = children.map((child) => reservePath(prefix.length === 0 ? child.name : `${prefix}/${child.name}`));
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      const normalized = pending[childIndex];
      if (child === undefined || normalized === undefined) throw adapterError("verifyMaterializedContent", "directory traversal became inconsistent");
      const path = normalized;
      const absolute = join(directory, child.name);
      // `reservePath` accounts for this entry before any lstat, realpath, or
      // file/link hashing. The append check remains a defensive invariant for
      // every recursive path, including directories.
      if (entries.length >= effective.maxEntries) throw policyError("verifyMaterializedContent", "entry count limit exceeded", path);
      const stat = await lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        appendEntry({ kind: "directory", path: normalized, mode: 0o755 });
        await visit(absolute, normalized, depth + 1);
        continue;
      }
      const resolved = await realpath(absolute).catch((error) => {
        throw policyError("verifyMaterializedContent", "content link resolution failed", normalized);
      });
      if (!isInside(canonicalRoot, resolved)) throw policyError("verifyMaterializedContent", "content link escapes root", normalized);
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute);
        const link = normalizeContentLinkTarget(normalized, target);
        appendEntry({
          kind: "symlink",
          path: normalized,
          mode: 0o777,
          target: link.target,
          digest: hashContent(encoder.encode(link.target.normalize("NFC")), sha256),
        });
        continue;
      }
      if (!stat.isFile()) throw policyError("verifyMaterializedContent", "content tree contains a special file", normalized);
      const digest = sha256Stream();
      let size = 0;
      const stream = createReadStream(absolute) as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw adapterError("verifyMaterializedContent", "file stream yielded a non-byte value", normalized);
        size += chunk.byteLength;
        totalBytes += chunk.byteLength;
        if (size > effective.maxFileBytes) throw policyError("verifyMaterializedContent", "file size limit exceeded", normalized);
        if (totalBytes > effective.maxExpandedBytes) throw policyError("verifyMaterializedContent", "expanded content limit exceeded", normalized);
        digest.update(chunk);
      }
      const raw = digest.digest();
      appendEntry({
        kind: "file",
        path: normalized,
        mode: stat.mode & 0o111 ? 0o755 : 0o644,
        size,
        digest: formatRawDigest(raw),
      });
    }
  };
  await visit(canonicalRoot, "", 0);
  return createContentManifest(entries, sha256, {
    maxEntries: effective.maxEntries,
    maxPathBytes: effective.maxPathBytes,
    maxSegmentBytes: effective.maxSegmentBytes,
    maxTotalPathBytes: effective.maxTotalPathBytes,
  });
}

async function assertDirectory(path: string, operation: string): Promise<void> {
  let stat;
  try { stat = await lstat(path); } catch (error) { throw adapterError(operation, `directory is unavailable: ${path}`, error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw policyError(operation, "path component is not a real directory", path);
}

async function canonicalizeSlot(slot: StagingSlot): Promise<string> {
  if (slot === null || typeof slot !== "object" || typeof slot.root !== "string" || slot.root.length === 0) {
    throw adapterError("openContentWriter", "staging slot is malformed");
  }
  const resolved = resolve(slot.root);
  let stat;
  try { stat = await lstat(resolved); } catch (error) { throw adapterError("openContentWriter", "staging slot is unavailable", error); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw policyError("openContentWriter", "staging slot must be a real directory", resolved);
  try { return await realpath(resolved); }
  catch (error) { throw adapterError("openContentWriter", "staging slot canonicalization failed", error); }
}

async function assertEmptySlot(slot: string): Promise<void> {
  const entries = await readdir(slot);
  if (entries.length !== 0) throw policyError("openContentWriter", "staging slot must be empty", slot);
}

async function removeOwned(paths: readonly string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const path of paths) {
    try { await rm(path, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "materialization cleanup failed");
}

class SecureContentSessionImpl implements SecureContentSession {
  private readonly slotRoot: string;
  private readonly root: string;
  private readonly work: string;
  private readonly limits: EffectiveLimits;
  private readonly sha256: Sha256;
  private readonly sha256Stream: IncrementalSha256Factory;
  private readonly records = new Map<string, StoredEntry>();
  private readonly collisions = new Map<string, string>();
  private readonly implicitDirectories = new Set<string>();
  private readonly pendingLinks: PendingLink[] = [];
  private entries = 0;
  private expandedBytes = 0;
  private state: "open" | "finalizing" | "finalized" | "aborted" = "open";

  constructor(
    slotRoot: string,
    sha256: Sha256,
    limits: EffectiveLimits,
    sha256Stream: IncrementalSha256Factory,
  ) {
    this.slotRoot = slotRoot;
    this.root = join(slotRoot, "content");
    this.work = join(slotRoot, ".work");
    this.sha256 = sha256;
    this.sha256Stream = sha256Stream;
    this.limits = limits;
  }

  get contentRoot(): string { return this.root; }
  get workRoot(): string { return this.work; }

  private assertOpen(operation: string): void {
    if (this.state !== "open") throw adapterError(operation, `content session is ${this.state}`);
  }

  private reserve(path: string, kind: ContentEntry["kind"], implicit = false): void {
    const normalized = normalizeContentPath(path);
    const key = pathCollisionKey(normalized);
    const previous = this.collisions.get(key);
    if (previous !== undefined) {
      const prior = this.records.get(previous);
      if (implicit && prior?.kind === "directory") return;
      if (kind === "directory" && this.implicitDirectories.has(previous) && prior?.kind === "directory") {
        this.implicitDirectories.delete(previous);
        return;
      }
      throw policyError("writeContentEntry", "duplicate or case/normalization-colliding path", normalized);
    }
    if (this.entries >= this.limits.maxEntries) throw policyError("writeContentEntry", "entry count limit exceeded", normalized);
    this.entries += 1;
    this.collisions.set(key, normalized);
  }

  private async ensureParents(path: string): Promise<void> {
    const segments = path.split("/");
    let current = this.root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) throw policyError("writeContentEntry", "missing path segment", path);
      current = join(current, segment);
      let stat;
      try { stat = await lstat(current); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw adapterError("writeContentEntry", "cannot inspect path ancestor", error);
        await mkdir(current, { mode: ROOT_MODE });
        await chmod(current, ROOT_MODE);
        const relativePath = relative(this.root, current).split(sep).join("/");
        this.reserve(relativePath, "directory", true);
        this.implicitDirectories.add(relativePath);
        this.records.set(relativePath, { kind: "directory", path: relativePath, mode: 0o755 });
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw policyError("writeContentEntry", "path ancestor is not a real directory", path);
    }
  }

  private checkPath(path: string): string {
    let normalized: string;
    try {
      normalized = normalizeContentPath(path);
    } catch (error) {
      throw policyError("writeContentEntry", "content path is unsafe", path);
    }
    const pathLength = encoder.encode(normalized).byteLength;
    if (pathLength > this.limits.maxPathBytes) throw policyError("writeContentEntry", "path length limit exceeded", normalized);
    for (const segment of normalized.split("/")) {
      if (encoder.encode(segment).byteLength > this.limits.maxSegmentBytes) throw policyError("writeContentEntry", "path segment length limit exceeded", normalized);
    }
    return normalized;
  }

  async add(entry: ContentEntry, signal: AbortSignal): Promise<void> {
    this.assertOpen("writeContentEntry");
    throwIfAborted(signal);
    if (entry === null || typeof entry !== "object" || typeof entry.path !== "string") {
      throw policyError("writeContentEntry", "content entry is malformed");
    }
    const path = this.checkPath(entry.path);
    const mode = normalizeMode(entry.kind, entry.mode);
    if (entry.kind === "directory") {
      await this.addDirectory(path, signal);
    } else if (entry.kind === "file") {
      await this.addFile(path, mode === 0o777 ? 0o755 : mode, entry.body, signal);
    } else {
      await this.addLink(path, mode, entry, signal);
    }
  }

  private async addDirectory(path: string, signal: AbortSignal): Promise<void> {
    const mode = 0o755 as const;
    this.reserve(path, "directory");
    await this.ensureParents(path);
    const destination = join(this.root, ...path.split("/"));
    try {
      let stat;
      try { stat = await lstat(destination); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(destination, { mode });
        stat = await lstat(destination);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw policyError("writeContentEntry", "directory collides with a non-directory", path);
      await chmod(destination, mode);
      this.records.set(path, { kind: "directory", path, mode });
      throwIfAborted(signal);
    } catch (error) {
      this.release(path);
      throw error;
    }
  }

  private async addFile(path: string, mode: 0o644 | 0o755, body: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void> {
    this.reserve(path, "file");
    await this.ensureParents(path);
    const destination = join(this.root, ...path.split("/"));
    let handle: FileHandle | undefined;
    const digest = this.sha256Stream();
    let size = 0;
    try {
      handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      for await (const chunk of body) {
        throwIfAborted(signal);
        if (!(chunk instanceof Uint8Array)) throw policyError("writeContentEntry", "file stream yielded a non-byte value", path);
        if (size + chunk.byteLength > this.limits.maxFileBytes) throw policyError("writeContentEntry", "file size limit exceeded", path);
        if (this.expandedBytes + chunk.byteLength > this.limits.maxExpandedBytes) throw policyError("writeContentEntry", "expanded content limit exceeded", path);
        // Hash only the bytes the OS confirms persisted. A short write must
        // never let the manifest describe bytes that were not on disk.
        await writeAll(handle, chunk, "writeContentEntry", (persisted) => {
          digest.update(persisted);
          size += persisted.byteLength;
          this.expandedBytes += persisted.byteLength;
        });
      }
      throwIfAborted(signal);
      await handle.close();
      handle = undefined;
      await chmod(destination, mode);
      const fileDigest = digest.digest();
      if (!(fileDigest instanceof Uint8Array) || fileDigest.byteLength !== 32) {
        throw adapterError("writeContentEntry", "incremental SHA-256 returned an invalid digest", path);
      }
      this.records.set(path, { kind: "file", path, mode, size, digest: formatRawDigest(fileDigest) });
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      let cleanupError: unknown;
      try { await rm(destination, { force: true }); } catch (failure) { cleanupError = failure; }
      this.expandedBytes = Math.max(0, this.expandedBytes - size);
      this.release(path);
      if (cleanupError !== undefined) {
        throw adapterError(
          "abortMaterialization",
          "failed to remove a partially written content entry",
          new AggregateError([error, cleanupError], "content entry cleanup failed"),
        );
      }
      throw error;
    }
  }

  private async addLink(
    path: string,
    mode: 0o644 | 0o755 | 0o777,
    entry: Extract<ContentEntry, { kind: "symlink" | "hardlink" }>,
    signal: AbortSignal,
  ): Promise<void> {
    let link: Readonly<{ target: string; resolvedPath: string }>;
    try {
      link = normalizeContentLinkTarget(path, entry.target);
    } catch (error) {
      throw policyError("writeContentEntry", "link target is unsafe", path);
    }
    if (link.resolvedPath === path) throw policyError("writeContentEntry", "link cannot point to itself", path);
    this.reserve(path, entry.kind);
    await this.ensureParents(path);
    this.pendingLinks.push({ entry, path, resolvedTarget: link.resolvedPath, target: link.target, mode });
    throwIfAborted(signal);
  }

  private release(path: string): void {
    const key = pathCollisionKey(path);
    this.collisions.delete(key);
    this.records.delete(path);
    this.implicitDirectories.delete(path);
    this.entries = Math.max(0, this.entries - 1);
  }

  private async materializeHardlinks(): Promise<void> {
    const remaining = this.pendingLinks.filter((link) => link.entry.kind === "hardlink");
    let progress = true;
    while (remaining.length > 0 && progress) {
      progress = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const link = remaining[index];
        if (link === undefined) continue;
        const target = this.records.get(link.resolvedTarget);
        if (target?.kind !== "file") continue;
        const destination = join(this.root, ...link.path.split("/"));
        const targetPath = join(this.root, ...target.path.split("/"));
        const targetStat = await lstat(targetPath);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
          throw policyError("writeContentEntry", "hardlink target is not a regular file", link.path);
        }
        const sourceStream = createReadStream(targetPath) as unknown as AsyncIterable<Uint8Array>;
        const digest = this.sha256Stream();
        let size = 0;
        let handle: FileHandle | undefined;
        try {
          handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
          for await (const chunk of sourceStream) {
            if (!(chunk instanceof Uint8Array)) throw adapterError("writeContentEntry", "hardlink source yielded a non-byte value", link.path);
            if (size + chunk.byteLength > this.limits.maxFileBytes) throw policyError("writeContentEntry", "hardlink file size limit exceeded", link.path);
            if (this.expandedBytes + chunk.byteLength > this.limits.maxExpandedBytes) throw policyError("writeContentEntry", "expanded content limit exceeded", link.path);
            await writeAll(handle, chunk, "writeContentEntry", (persisted) => {
              digest.update(persisted);
              size += persisted.byteLength;
              this.expandedBytes += persisted.byteLength;
            });
          }
          await handle.close();
          handle = undefined;
          await chmod(destination, link.mode === 0o777 ? 0o755 : link.mode);
          const rawDigest = digest.digest();
          this.records.set(link.path, {
            kind: "file",
            path: link.path,
            mode: link.mode === 0o777 ? 0o755 : link.mode,
            size,
            digest: formatRawDigest(rawDigest),
          });
          remaining.splice(index, 1);
          progress = true;
        } catch (error) {
          if (handle !== undefined) await handle.close().catch(() => undefined);
          let cleanupError: unknown;
          try { await rm(destination, { force: true }); } catch (failure) { cleanupError = failure; }
          this.expandedBytes = Math.max(0, this.expandedBytes - size);
          if (cleanupError !== undefined) {
            throw adapterError("abortMaterialization", "failed to remove a partially materialized hardlink", new AggregateError([error, cleanupError]));
          }
          throw error;
        }
      }
    }
    if (remaining.length > 0) throw policyError("writeContentEntry", "hardlink target is not a retained regular file");
  }

  private async materializeSymlinks(): Promise<void> {
    const pendingSymlinkPaths = new Set(
      this.pendingLinks.filter((link) => link.entry.kind === "symlink").map((link) => link.path),
    );
    for (const link of this.pendingLinks) {
      if (link.entry.kind !== "symlink") continue;
      const target = this.records.get(link.resolvedTarget);
      if (target === undefined && !pendingSymlinkPaths.has(link.resolvedTarget)) {
        throw policyError("writeContentEntry", "symlink target is not a retained entry", link.path);
      }
      const destination = join(this.root, ...link.path.split("/"));
      await symlink(link.target, destination, "file");
      this.records.set(link.path, {
        kind: "symlink",
        path: link.path,
        mode: 0o777,
        target: link.target.normalize("NFC"),
        digest: hashContent(encoder.encode(link.target.normalize("NFC")), this.sha256),
      });
    }
  }

  private async verifyContainment(): Promise<void> {
    const root = await realpath(this.root);
    for (const entry of this.records.values()) {
      const destination = join(this.root, ...entry.path.split("/"));
      const stat = await lstat(destination);
      if (entry.kind === "directory" && !stat.isDirectory()) throw policyError("finalizeContentManifest", "directory changed type", entry.path);
      if (entry.kind === "file" && !stat.isFile()) throw policyError("finalizeContentManifest", "file changed type", entry.path);
      if (entry.kind === "symlink" && !stat.isSymbolicLink()) throw policyError("finalizeContentManifest", "symlink changed type", entry.path);
      let resolved: string;
      try {
        resolved = await realpath(destination);
      } catch (error) {
        throw policyError("finalizeContentManifest", "link resolution failed or contains a cycle", entry.path);
      }
      if (!isInside(root, resolved)) throw policyError("finalizeContentManifest", "resolved path escapes content root", entry.path);
    }
  }

  async finalize(signal: AbortSignal): Promise<Readonly<{ root: string; content: ContentManifest }>> {
    this.assertOpen("finalizeContentManifest");
    this.state = "finalizing";
    try {
      throwIfAborted(signal);
      await this.materializeHardlinks();
      throwIfAborted(signal);
      await this.materializeSymlinks();
      throwIfAborted(signal);
      await this.verifyContainment();
      const expected = createContentManifest(
        [...this.records.values()].filter((entry): entry is ContentManifestEntry => entry.kind !== "hardlink"),
        this.sha256,
      );
      const onDisk = await readDiskManifest(this.root, this.sha256, this.sha256Stream, this.limits);
      if (onDisk.rootDigest !== expected.rootDigest || onDisk.entries.length !== expected.entries.length || onDisk.entries.some((entry, index) => !digestEqual(entry, expected.entries[index]!))) {
        throw policyError("finalizeContentManifest", "persisted content does not match the materialization record");
      }
      throwIfAborted(signal);
      await rm(this.work, { recursive: true, force: true });
      this.state = "finalized";
      return { root: this.root, content: onDisk };
    } catch (error) {
      this.state = "open";
      throw error;
    }
  }

  async abort(_cause?: unknown): Promise<void> {
    if (this.state === "aborted") return;
    this.state = "aborted";
    await removeOwned([this.root, this.work]);
  }
}

export type SecureContentWriterOptions = Readonly<{
  sha256: Sha256;
  limits?: Partial<MaterializationLimits>;
  sha256Stream?: IncrementalSha256Factory;
}>;

/** Internal disk rewalk used by tests and filesystem policy checks. */
export async function inspectMaterializedContent(
  root: string,
  sha256: Sha256,
  options: Readonly<{ limits?: Partial<MaterializationLimits>; sha256Stream?: IncrementalSha256Factory }> = {},
): Promise<ContentManifest> {
  if (typeof root !== "string" || root.length === 0) throw new TypeError("materialized content root is required");
  if (basename(root) !== "content") throw policyError("verifyMaterializedContent", "materialized root must be exactly a content directory");
  return readDiskManifest(root, sha256, options.sha256Stream ?? defaultSha256Stream, options.limits);
}

/** Rewalk and rehash a completed content root before lifecycle handoff. */
async function verifyMaterializedContentWithSha(
  root: string,
  manifest: ContentManifest,
  sha256: Sha256,
  options: Readonly<{ limits?: Partial<MaterializationLimits>; sha256Stream?: IncrementalSha256Factory }> = {},
): Promise<ContentManifest> {
  if (typeof root !== "string" || root.length === 0) throw new TypeError("materialized content root is required");
  if (basename(root) !== "content") throw policyError("verifyMaterializedContent", "materialized root must be exactly a content directory");
  const expected = verifyContentManifest(manifest, sha256, options.limits);
  const actual = await readDiskManifest(root, sha256, options.sha256Stream ?? defaultSha256Stream, options.limits);
  if (actual.rootDigest !== expected.rootDigest || actual.entries.length !== expected.entries.length || actual.entries.some((entry, index) => !digestEqual(entry, expected.entries[index]!))) {
    throw policyError("verifyMaterializedContent", "on-disk content does not match its manifest");
  }
  return actual;
}

/**
 * Public lifecycle verifier. SHA-256 and incremental hashing are deliberately
 * bound inside the Node adapter; callers can request limits but cannot replace
 * the crypto or filesystem implementation.
 */
export async function verifyMaterializedContent(
  root: string,
  manifest: ContentManifest,
  options: Readonly<{ limits?: Partial<MaterializationLimits> }> = {},
): Promise<ContentManifest> {
  return verifyMaterializedContentWithSha(root, manifest, (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()), options);
}

export function createSecureContentWriterFactory(options: SecureContentWriterOptions): SecureContentWriterFactory {
  if (typeof options.sha256 !== "function") throw new TypeError("secure content writer requires SHA-256");
  const limits = limitsWithDefaults(options.limits);
  return {
    async canonicalize(slot: StagingSlot): Promise<StagingSlot> {
      return { root: await canonicalizeSlot(slot) };
    },
    async open(slot: StagingSlot, overrides) {
      const slotRoot = await canonicalizeSlot(slot);
      await assertEmptySlot(slotRoot);
      const effective = limitsWithDefaults({ ...limits, ...(overrides ?? {}) });
      const content = join(slotRoot, "content");
      const work = join(slotRoot, ".work");
      try {
        await mkdir(content, { mode: ROOT_MODE });
        await mkdir(work, { mode: 0o700 });
        await chmod(content, ROOT_MODE);
        await chmod(work, 0o700);
        await assertDirectory(content, "openContentWriter");
        await assertDirectory(work, "openContentWriter");
        return new SecureContentSessionImpl(slotRoot, options.sha256, effective, options.sha256Stream ?? defaultSha256Stream);
      } catch (error) {
        try {
          await removeOwned([content, work]);
        } catch (cleanupError) {
          throw adapterError(
            "abortMaterialization",
            "failed to remove content writer paths after open failure",
            new AggregateError([error, cleanupError], "content writer cleanup failed"),
          );
        }
        throw error;
      }
    },
  };
}

export type FilesystemMarketplacePathAcquirerOptions = Readonly<{
  maxDepth?: number;
  sha256?: Sha256;
}>;

/** Filesystem adapter for marketplace-relative copies; all writes still use the sink. */
export function createFilesystemMarketplacePathAcquirer(
  options: FilesystemMarketplacePathAcquirerOptions = {},
): MarketplacePathAcquirer {
  const maxDepth = options.maxDepth ?? 64;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new TypeError("maxDepth must be positive");
  return {
    async materialize(source, context, sink, signal) {
      throwIfAborted(signal);
      const contextStat = await lstat(context.root);
      if (contextStat.isSymbolicLink() || !contextStat.isDirectory()) {
        throw policyError("copyMarketplacePath", "marketplace context root must be a real directory");
      }
      const sourceRoot = await realpath(context.root);
      await assertDirectory(sourceRoot, "copyMarketplacePath");
      if (basename(sourceRoot) !== "content") throw policyError("copyMarketplacePath", "marketplace context root is not an exact content root");
      const contextSha256 = options.sha256 ?? ((bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest()));
      try {
        const verifiedContext = await verifyMaterializedContentWithSha(sourceRoot, context.content, contextSha256);
        if (verifiedContext.rootDigest !== context.contentRootDigest) {
          throw policyError("copyMarketplacePath", "marketplace context digest does not match on-disk content");
        }
        if (context.binding !== undefined && context.binding !== createMaterializationBinding(context.source.hash, verifiedContext.rootDigest, contextSha256)) {
          throw policyError("copyMarketplacePath", "marketplace context source/content binding is invalid");
        }
      } catch (error) {
        if (error instanceof SourceMaterializationError) throw error;
        throw policyError("copyMarketplacePath", "marketplace context content verification failed");
      }
      const selected = safeSourcePath(source.path);
      const selectedPath = resolve(sourceRoot, ...selected.split("/"));
      const selectedReal = await realpath(selectedPath);
      if (!isInside(sourceRoot, selectedReal)) throw policyError("copyMarketplacePath", "marketplace source escapes its root", source.path);
      const selectedStat = await lstat(selectedPath);
      if (selectedStat.isSymbolicLink()) throw policyError("copyMarketplacePath", "marketplace source root cannot be a symlink", source.path);
      if (selectedStat.isDirectory()) {
        await walkDirectory(selectedPath, "", 0, sourceRoot, sink, signal, maxDepth);
      } else if (selectedStat.isFile()) {
        await addSourceFile(selectedPath, basename(selected), selectedStat.mode, sink, signal);
      } else {
        throw policyError("copyMarketplacePath", "marketplace source is not a regular file or directory", source.path);
      }
    },
  };
}

function safeSourcePath(path: string): string {
  try { return normalizeMarketplaceSourcePath(path); }
  catch (error) { throw policyError("copyMarketplacePath", "marketplace source contains an unsafe path", path); }
}

async function addSourceFile(path: string, destination: string, mode: number, sink: SecureContentSession, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const body = createReadStream(path) as unknown as AsyncIterable<Uint8Array>;
  await sink.add({ kind: "file", path: safeSourcePath(destination), mode: mode & 0o7777, body }, signal);
}

async function walkDirectory(
  directory: string,
  destination: string,
  depth: number,
  sourceRoot: string,
  sink: SecureContentSession,
  signal: AbortSignal,
  maxDepth: number,
): Promise<void> {
  throwIfAborted(signal);
  if (depth > maxDepth) throw policyError("copyMarketplacePath", "marketplace source depth limit exceeded", destination);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    const childDestination = destination.length === 0 ? entry.name : `${destination}/${entry.name}`;
    const childPath = join(directory, entry.name);
    const childStat = await lstat(childPath);
    if (childStat.isDirectory()) {
      await sink.add({ kind: "directory", path: safeSourcePath(childDestination), mode: childStat.mode & 0o7777 }, signal);
      const childReal = await realpath(childPath);
      if (!isInside(sourceRoot, childReal)) throw policyError("copyMarketplacePath", "marketplace directory escapes its root", childDestination);
      await walkDirectory(childPath, childDestination, depth + 1, sourceRoot, sink, signal, maxDepth);
    } else if (childStat.isFile()) {
      await addSourceFile(childPath, childDestination, childStat.mode, sink, signal);
    } else if (childStat.isSymbolicLink()) {
      const target = await readlink(childPath);
      let link: Readonly<{ target: string; resolvedPath: string }>;
      try { link = normalizeContentLinkTarget(childDestination, target); }
      catch (error) { throw policyError("copyMarketplacePath", "marketplace symlink target is unsafe", childDestination); }
      const targetPath = await realpath(resolve(dirname(childPath), target));
      if (!isInside(sourceRoot, targetPath)) throw policyError("copyMarketplacePath", "marketplace symlink escapes its root", childDestination);
      await sink.add({ kind: "symlink", path: childDestination, mode: childStat.mode & 0o7777, target: link.target }, signal);
    } else {
      throw policyError("copyMarketplacePath", "marketplace source contains a special file", childDestination);
    }
  }
}
