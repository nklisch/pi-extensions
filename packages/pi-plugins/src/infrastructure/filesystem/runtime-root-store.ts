import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  ContentDigestSchema,
  hashContent,
  type ContentDigest,
} from "../../domain/content-manifest.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import {
  derivePluginDataRef,
  deriveProjectionRootRef,
  PluginDataRefSchema,
  ProjectionRootRefSchema,
  type ProjectionRootRef,
} from "../../domain/state/references.js";
import { ScopeReferenceSchema, type ScopeReference } from "../../domain/state/scope.js";
import { DomainContractError, ErrorCodeRegistry } from "../../domain/errors.js";
import type {
  ContentStoreCapabilities,
  ProjectionRootAllocation,
  ProjectionRootRequest,
  ResolvedProjectionRoot,
  StableDataRootRequest,
  WritableDataRoot,
} from "../../application/ports/content-store.js";
import type { ContentStorePlatform } from "../../application/ports/content-store-platform.js";
import type { Sha256 } from "../../domain/source.js";
import {
  assertLayoutRoot,
  assertOwnedDirectory,
  type ContentStoreLayout,
} from "./content-store-layout.js";
import { projectionStagingPath } from "./content-store-layout.js";
import { removePreparedTree, type PreparedTreeIdentity } from "./prepared-tree-cleanup.js";

const READY_TEXT = "content-store-ready-v1\n";
const READY = "READY";
const READY_TMP = "READY.tmp";
const METADATA = "metadata.json";

const ProjectionMetadataV1Schema = z.object({
  version: z.literal(1),
  projectionRef: ProjectionRootRefSchema,
  /** Complete logical lifecycle identity. */
  projectionDigest: ContentDigestSchema,
  /** Exact generated payload-tree integrity, independent of projectionDigest. */
  payloadDigest: ContentDigestSchema,
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
}).strict().readonly();
const ProjectionMetadataV2Schema = z.object({
  version: z.literal(2),
  projectionRef: ProjectionRootRefSchema,
  projectionDigest: ContentDigestSchema,
  payloadDigest: ContentDigestSchema,
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  payload: z.string().regex(/^\.payload-[0-9a-f]{32}$/u),
}).strict().readonly();
const ProjectionMetadataSchema = z.discriminatedUnion("version", [ProjectionMetadataV1Schema, ProjectionMetadataV2Schema]);

type ProjectionMetadata = z.infer<typeof ProjectionMetadataSchema>;
type ProjectionEntry = Readonly<{ kind: "directory" | "file" | "symlink"; path: string; mode: number; size?: number; digest?: ContentDigest; target?: string }>;

type ProjectionRecord = Readonly<{
  allocation: ProjectionRootAllocation;
  root: string;
  identity: PreparedTreeIdentity;
}>;

export type RuntimeRootStore = Readonly<{
  ensureDataRoot(input: StableDataRootRequest, signal: AbortSignal): Promise<WritableDataRoot>;
  allocateProjectionRoot(input: ProjectionRootRequest, signal: AbortSignal): Promise<ProjectionRootAllocation>;
  sealProjectionRoot(input: ProjectionRootAllocation, signal: AbortSignal): Promise<ResolvedProjectionRoot>;
  discardProjectionRoot(input: ProjectionRootAllocation, signal: AbortSignal): Promise<void>;
  resolveProjectionRoot(input: ProjectionRootRequest, signal: AbortSignal): Promise<ResolvedProjectionRoot>;
}>;

export type RuntimeRootStoreOptions = Readonly<{
  layout: ContentStoreLayout;
  platform: ContentStorePlatform;
  sha256: Sha256;
  randomBytes?: (size: number) => Uint8Array | Promise<Uint8Array>;
}>;

function rootError(code: "stagingAllocationInvalid" | "contentVerificationFailed" | "storeIdentityCollision" | "durabilityUnavailable" | "adapterFailed", operation: string, message: string, cause?: unknown, cleanup?: "incomplete"): DomainContractError {
  return new DomainContractError({
    code: ErrorCodeRegistry[code],
    operation,
    message,
    details: { operation, ...(cleanup === undefined ? {} : { cleanup }) },
    ...(cause === undefined ? {} : { cause }),
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function isIncompleteCleanup(error: unknown): boolean {
  if (!(error instanceof DomainContractError)) return false;
  const details = error.details;
  return details !== null && typeof details === "object" && !Array.isArray(details) && "cleanup" in details && details.cleanup === "incomplete";
}

function idFromBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new Error("projection allocation id source must return 16 bytes");
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectionMetadataMatches(
  metadata: ProjectionMetadata,
  identity: Readonly<{ scope: ScopeReference; plugin: PluginKey; projectionDigest: ContentDigest; payloadDigest: ContentDigest; projectionRef: ProjectionRootRef }>,
  sha256: Sha256,
): boolean {
  const expectedRef = deriveProjectionRootRef({
    scope: identity.scope,
    plugin: identity.plugin,
    projectionDigest: identity.projectionDigest,
  }, sha256);
  return metadata.projectionRef === identity.projectionRef &&
    metadata.projectionDigest === identity.projectionDigest &&
    metadata.payloadDigest === identity.payloadDigest &&
    metadata.projectionRef === expectedRef &&
    sameJson(metadata.scope, identity.scope) &&
    metadata.plugin === identity.plugin;
}

async function assertProjectionAllocation(
  record: ProjectionRecord,
  layout: ContentStoreLayout,
  operation: string,
): Promise<void> {
  try {
    await assertLayoutRoot(layout, "projectionStagingRoot", operation);
    await assertLayoutRoot(layout, "generatedRoot", operation);
    await assertOwnedDirectory(record.root, operation, record.identity, layout.rootCapabilities.projectionStagingRoot);
  } catch (cause) {
    if (cause instanceof DomainContractError) throw cause;
    throw rootError("stagingAllocationInvalid", operation, "projection allocation identity changed", cause);
  }
}

async function projectionEntriesWithHash(root: string, sha256: Sha256, prefix = ""): Promise<ProjectionEntry[]> {
  const children = (await readdir(root, { withFileTypes: true })).sort((left, right) => comparePath(left.name, right.name));
  const entries: ProjectionEntry[] = [];
  for (const child of children) {
    // READY and metadata are publication controls only at the allocation
    // root. Nested entries with those names are projection payload and must be
    // hashed, sealed, and verified like every other entry.
    if (prefix.length === 0 && (child.name === READY || child.name === READY_TMP || child.name === METADATA)) continue;
    const path = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
    const absolute = join(root, child.name);
    const stat = await lstat(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push({ kind: "directory", path, mode: 0o755 });
      entries.push(...await projectionEntriesWithHash(absolute, sha256, path));
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      const bytes = await readFile(absolute);
      entries.push({ kind: "file", path, mode: stat.mode & 0o111 ? 0o755 : 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) });
    } else if (stat.isSymbolicLink()) {
      throw new Error("projection root contains a symlink");
    } else {
      throw new Error("projection root contains a special file");
    }
  }
  return entries;
}

type BeforeEffect = () => Promise<void>;

async function copyProjectionTree(
  sourceRoot: string,
  destinationRoot: string,
  entries: readonly ProjectionEntry[],
  beforeSourceRead: BeforeEffect,
  beforeDestinationEffect: BeforeEffect,
): Promise<void> {
  for (const entry of [...entries].sort((left, right) => {
    const depth = left.path.split("/").length - right.path.split("/").length;
    return depth || comparePath(left.path, right.path);
  })) {
    const source = join(sourceRoot, ...entry.path.split("/"));
    const destination = join(destinationRoot, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      await beforeDestinationEffect();
      await mkdir(destination, { mode: 0o755 });
      continue;
    }
    if (entry.kind !== "file") throw new Error("projection payload contains an unsupported link");
    await beforeSourceRead();
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("projection source entry changed type");
    await beforeSourceRead();
    const bytes = await readFile(source);
    await beforeDestinationEffect();
    await writeFile(destination, bytes, { flag: "wx", mode: entry.mode });
  }
}

/** Stable digest for generated projection payloads, excluding publication metadata. */
export async function hashProjectionRoot(root: string, sha256: Sha256): Promise<ContentDigest> {
  const entries = await projectionEntriesWithHash(root, sha256);
  return hashContent(new TextEncoder().encode(`projection-root-v1\0${JSON.stringify(entries)}`), sha256);
}

async function sealProjectionTree(
  root: string,
  sha256: Sha256,
  platform: ContentStorePlatform,
  beforeEffect?: BeforeEffect,
): Promise<void> {
  await beforeEffect?.();
  const entries = await projectionEntriesWithHash(root, sha256);
  await beforeEffect?.();
  for (const entry of [...entries].sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
    const path = join(root, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      await beforeEffect?.();
      await chmod(path, 0o555);
      await beforeEffect?.();
      await platform.syncDirectory(path);
    } else if (entry.kind === "file") {
      await beforeEffect?.();
      await chmod(path, entry.mode === 0o755 ? 0o555 : 0o444);
      await beforeEffect?.();
      await platform.syncFile(path);
    }
  }
  // Keep the allocation root writable until publication. The caller performs
  // the final identity-checked chmod after the no-replace rename so the
  // staging parent remains writable for that rename.
  await beforeEffect?.();
  await platform.syncDirectory(root);
}

export function createRuntimeRootStore(options: RuntimeRootStoreOptions): RuntimeRootStore {
  const projectionAllocations = new WeakMap<object, ProjectionRecord>();
  const randomBytes = options.randomBytes ?? ((size: number) => new Uint8Array(nodeRandomBytes(size)));
  let capabilitiesPromise: Promise<ContentStoreCapabilities> | undefined;
  const capabilities = async (): Promise<ContentStoreCapabilities> => {
    await assertLayoutRoot(options.layout, "hostRoot", "probeRuntimeRoots");
    capabilitiesPromise ??= options.platform.probe(options.layout.hostRoot).then((value) => {
      if (!value.atomicNoReplaceDirectory || !value.fileSync || !value.directorySync || value.readOnlyModeEnforcement !== "posix-mode") {
        throw rootError("durabilityUnavailable", "probeRuntimeRoots", "runtime root durability is unavailable");
      }
      return value;
    });
    return capabilitiesPromise;
  };

  async function ensureDataRoot(input: StableDataRootRequest, signal: AbortSignal): Promise<WritableDataRoot> {
    throwIfAborted(signal);
    const scope = ScopeReferenceSchema.parse(input.scope);
    const plugin = PluginKeySchema.parse(input.plugin);
    const dataRef = PluginDataRefSchema.parse(input.dataRef);
    const expected = derivePluginDataRef({ scope, plugin, purpose: "persistent-plugin-data" }, options.sha256);
    if (dataRef !== expected) throw rootError("contentVerificationFailed", "ensureDataRoot", "persistent data reference is not stable for its scope and plugin");
    const root = options.layout.dataPath(dataRef);
    await assertLayoutRoot(options.layout, "dataRoot", "ensureDataRoot");
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw rootError("adapterFailed", "ensureDataRoot", "persistent data root could not be created", error);
    }
    await assertLayoutRoot(options.layout, "dataRoot", "ensureDataRoot");
    const stat = await lstat(root).catch((cause) => { throw rootError("contentVerificationFailed", "ensureDataRoot", "persistent data root is unavailable", cause); });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw rootError("contentVerificationFailed", "ensureDataRoot", "persistent data root is not a private directory");
    const identity = { dev: stat.dev, ino: stat.ino };
    await assertOwnedDirectory(root, "ensureDataRoot", identity, options.layout.rootCapabilities.dataRoot);
    await assertLayoutRoot(options.layout, "dataRoot", "ensureDataRoot");
    await chmod(root, 0o700);
    await assertOwnedDirectory(root, "ensureDataRoot", identity, options.layout.rootCapabilities.dataRoot);
    await assertLayoutRoot(options.layout, "dataRoot", "ensureDataRoot");
    return Object.freeze({ root, scope, plugin, dataRef });
  }

  async function allocateProjectionRoot(input: ProjectionRootRequest, signal: AbortSignal): Promise<ProjectionRootAllocation> {
    throwIfAborted(signal);
    const scope = ScopeReferenceSchema.parse(input.scope);
    const plugin = PluginKeySchema.parse(input.plugin);
    const projectionDigest = ContentDigestSchema.parse(input.projectionDigest);
    // Older lifecycle-only callers did not carry a payload digest. Keep their
    // request shape readable while ensuring every published v1 root stores the
    // two identities separately once a cache supplies the exact payload hash.
    const payloadDigest = ContentDigestSchema.parse(input.payloadDigest ?? projectionDigest);
    const projectionRef = ProjectionRootRefSchema.parse(input.projectionRef);
    const expected = deriveProjectionRootRef({ scope, plugin, projectionDigest }, options.sha256);
    if (projectionRef !== expected) throw rootError("contentVerificationFailed", "allocateProjectionRoot", "projection reference does not match its identity");
    for (let attempt = 0; attempt < 32; attempt += 1) {
      throwIfAborted(signal);
      const id = idFromBytes(await randomBytes(16));
      const root = projectionStagingPath(options.layout, id);
      await assertLayoutRoot(options.layout, "projectionStagingRoot", "allocateProjectionRoot");
      let allocationIdentity: PreparedTreeIdentity | undefined;
      try {
        await mkdir(root, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw rootError("adapterFailed", "allocateProjectionRoot", "projection root allocation failed", error);
      }
      try {
        await assertLayoutRoot(options.layout, "projectionStagingRoot", "allocateProjectionRoot");
        const stat = await lstat(root);
        allocationIdentity = { dev: stat.dev, ino: stat.ino };
        const canonical = await realpath(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== root || (stat.mode & 0o077) !== 0) {
          throw new Error("projection root allocation is not a private real directory");
        }
        await assertOwnedDirectory(root, "allocateProjectionRoot", allocationIdentity, options.layout.rootCapabilities.projectionStagingRoot);
        const allocation = Object.freeze({ root, scope, plugin, projectionDigest, payloadDigest, projectionRef, allocationId: id });
        projectionAllocations.set(allocation, { allocation, root, identity: { dev: stat.dev, ino: stat.ino } });
        return allocation;
      } catch (error) {
        let cleanupFailure: unknown;
        try {
          if (allocationIdentity !== undefined) await removePreparedTree(root, allocationIdentity, options.layout.rootCapabilities.projectionStagingRoot);
        } catch (cause) { cleanupFailure = cause; }
        if (cleanupFailure !== undefined) {
          throw rootError(
            "adapterFailed",
            "allocateProjectionRoot",
            "projection root allocation could not be verified and cleanup was incomplete",
            new AggregateError([error, cleanupFailure], "projection allocation cleanup failed"),
            "incomplete",
          );
        }
        throw rootError("adapterFailed", "allocateProjectionRoot", "projection root allocation could not be verified", error);
      }
    }
    throw rootError("adapterFailed", "allocateProjectionRoot", "projection allocation collision limit exceeded");
  }

  async function sealProjectionRoot(input: ProjectionRootAllocation, signal: AbortSignal): Promise<ResolvedProjectionRoot> {
    throwIfAborted(signal);
    const record = input !== null && typeof input === "object" ? projectionAllocations.get(input) : undefined;
    if (record === undefined || record.allocation.root !== input.root || record.allocation.allocationId !== input.allocationId) {
      throw rootError("stagingAllocationInvalid", "sealProjectionRoot", "projection root allocation capability is invalid");
    }
    // Check the capability before hashing or creating publication controls. A
    // replaced allocation must not turn metadata writes into foreign writes.
    await assertProjectionAllocation(record, options.layout, "sealProjectionRoot");
    await capabilities();
    await assertProjectionAllocation(record, options.layout, "sealProjectionRoot");
    const expected = deriveProjectionRootRef({ scope: input.scope, plugin: input.plugin, projectionDigest: input.projectionDigest }, options.sha256);
    if (expected !== input.projectionRef) throw rootError("contentVerificationFailed", "sealProjectionRoot", "projection root identity changed");
    const payloadDigest = await hashProjectionRoot(record.root, options.sha256).catch((cause) => { throw rootError("contentVerificationFailed", "sealProjectionRoot", "projection payload could not be verified", cause); });
    await assertProjectionAllocation(record, options.layout, "sealProjectionRoot");
    if (payloadDigest !== input.payloadDigest) throw rootError("contentVerificationFailed", "sealProjectionRoot", "projection payload digest does not match its integrity reference");
    const target = options.layout.projectionPath(input.projectionRef);
    await assertLayoutRoot(options.layout, "generatedRoot", "sealProjectionRoot");
    let targetStat;
    try { targetStat = await lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw rootError("adapterFailed", "sealProjectionRoot", "projection target could not be inspected", error);
    }
    if (targetStat !== undefined) {
      await assertLayoutRoot(options.layout, "generatedRoot", "sealProjectionRoot");
      let existing: Awaited<ReturnType<typeof inspectPublishedProjection>> | undefined;
      try { existing = await inspectPublishedProjection(target, options.sha256); }
      catch {
        // A valid immutable marker may outlive a manually removed payload.
        // Rebuild only that exact missing payload name. READY is published last,
        // and metadata is hard-linked back to the canonical marker, so readers
        // still observe either invalid/missing evidence or the complete tree.
        let marker: ProjectionMetadata | undefined;
        try {
          const stat = await lstat(target);
          const parsed = ProjectionMetadataSchema.parse(JSON.parse(await readFile(target, "utf8")));
          const markerMode = stat.mode & 0o777;
          if (!stat.isFile() || stat.isSymbolicLink() || (markerMode !== 0o444 && markerMode !== 0o644) || parsed.version !== 2 ||
              parsed.projectionRef !== `runtime-projection-v1:sha256:${basename(target)}` ||
              !projectionMetadataMatches(parsed, input, options.sha256)) {
            throw new Error("publication marker is not repairable");
          }
          // Recursive owner-write permission used to remove a sealed payload
          // also changes its hard-linked marker inode. Exact authority above
          // is sufficient to restore the marker before rebuilding; group/world
          // writable or otherwise malformed markers remain collisions.
          if (markerMode !== 0o444) {
            await chmod(target, 0o444);
            await options.platform.syncFile(target);
          }
          try {
            await lstat(join(dirname(target), parsed.payload));
            throw new Error("published payload exists but is invalid");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          marker = parsed;
        } catch {
          throw rootError("storeIdentityCollision", "sealProjectionRoot", "projection identity is already occupied by different content");
        }

        const repairRoot = join(dirname(target), marker.payload);
        let repairIdentity: PreparedTreeIdentity | undefined;
        try {
          await assertLayoutRoot(options.layout, "generatedRoot", "sealProjectionRoot");
          await mkdir(repairRoot, { mode: 0o700 });
          const stat = await lstat(repairRoot);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("repair payload is not a real directory");
          repairIdentity = { dev: stat.dev, ino: stat.ino };
          const assertRepair: BeforeEffect = async () => {
            await assertLayoutRoot(options.layout, "generatedRoot", "sealProjectionRoot");
            await assertOwnedDirectory(repairRoot, "sealProjectionRoot", repairIdentity!, options.layout.rootCapabilities.generatedRoot);
          };
          const assertSource: BeforeEffect = () => assertProjectionAllocation(record, options.layout, "sealProjectionRoot");
          const entries = await projectionEntriesWithHash(record.root, options.sha256);
          await copyProjectionTree(record.root, repairRoot, entries, assertSource, assertRepair);
          await assertSource();
          if (await hashProjectionRoot(record.root, options.sha256) !== input.payloadDigest) throw new Error("projection source changed during repair");
          await assertRepair();
          if (await hashProjectionRoot(repairRoot, options.sha256) !== input.payloadDigest) throw new Error("repaired projection differs from its source");
          await assertRepair();
          await link(target, join(repairRoot, METADATA));
          await assertRepair();
          await writeFile(join(repairRoot, READY_TMP), READY_TEXT, { flag: "wx", mode: 0o600 });
          await assertRepair();
          await rename(join(repairRoot, READY_TMP), join(repairRoot, READY));
          await assertRepair();
          await chmod(join(repairRoot, READY), 0o444);
          await sealProjectionTree(repairRoot, options.sha256, options.platform, assertRepair);
          await assertRepair();
          await options.platform.syncFile(join(repairRoot, METADATA));
          await assertRepair();
          await options.platform.syncFile(join(repairRoot, READY));
          await assertRepair();
          await chmod(repairRoot, 0o555);
          await assertRepair();
          await options.platform.syncDirectory(repairRoot);
          await options.platform.syncDirectory(options.layout.generatedRoot);
          existing = await inspectPublishedProjection(target, options.sha256);
        } catch (cause) {
          if (repairIdentity !== undefined) {
            try { await removePreparedTree(repairRoot, repairIdentity, options.layout.rootCapabilities.generatedRoot); }
            catch (cleanup) {
              throw rootError("adapterFailed", "sealProjectionRoot", "projection repair failed and cleanup was incomplete", new AggregateError([cause, cleanup]), "incomplete");
            }
          }
          if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
            try { existing = await inspectPublishedProjection(target, options.sha256); }
            catch { /* a concurrent repair remains incomplete or invalid */ }
          }
          if (existing === undefined) throw rootError("adapterFailed", "sealProjectionRoot", "projection payload repair failed", cause);
        }
      }
      if (existing === undefined || !projectionMetadataMatches(existing.metadata, input, options.sha256)) {
        throw rootError("storeIdentityCollision", "sealProjectionRoot", "projection identity is already occupied by different content");
      }
      try {
        await removePreparedTree(record.root, record.identity, options.layout.rootCapabilities.projectionStagingRoot);
        projectionAllocations.delete(input);
        await assertLayoutRoot(options.layout, "projectionStagingRoot", "sealProjectionRoot");
      } catch (cause) {
        throw rootError("adapterFailed", "sealProjectionRoot", "projection allocation cleanup was incomplete", cause, "incomplete");
      }
      return { root: existing.root, scope: input.scope, plugin: input.plugin, projectionDigest: input.projectionDigest, payloadDigest: input.payloadDigest, projectionRef: input.projectionRef };
    }

    const assertProjectionBeforeEffect: BeforeEffect = async () => {
      await assertProjectionAllocation(record, options.layout, "sealProjectionRoot");
    };
    let published = false;
    let sourceCleanupAttempted = false;
    let sourceCleanupFailure: unknown;
    let prepared: string | undefined;
    let preparedIdentity: PreparedTreeIdentity | undefined;
    let preparedCleanupAttempted = false;
    let preparedCleanupFailure: unknown;
    const tryCleanupSource = async (): Promise<unknown> => {
      if (sourceCleanupAttempted) return sourceCleanupFailure;
      sourceCleanupAttempted = true;
      try {
        await removePreparedTree(record.root, record.identity, options.layout.rootCapabilities.projectionStagingRoot);
        projectionAllocations.delete(input);
        await assertLayoutRoot(options.layout, "projectionStagingRoot", "sealProjectionRoot");
      } catch (cause) { sourceCleanupFailure = cause; }
      return sourceCleanupFailure;
    };
    const tryCleanupPrepared = async (): Promise<unknown> => {
      if (preparedCleanupAttempted || prepared === undefined || preparedIdentity === undefined || published) return preparedCleanupFailure;
      preparedCleanupAttempted = true;
      try { await removePreparedTree(prepared, preparedIdentity, options.layout.rootCapabilities.generatedRoot); }
      catch (cause) { preparedCleanupFailure = cause; }
      return preparedCleanupFailure;
    };
    const cleanupError = (primary: unknown): DomainContractError => rootError(
      "adapterFailed",
      "sealProjectionRoot",
      "projection publication failed and cleanup was incomplete",
      new AggregateError([primary, sourceCleanupFailure, preparedCleanupFailure].filter((value) => value !== undefined), "projection cleanup failed"),
      "incomplete",
    );

    try {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = join(options.layout.generatedRoot, `.payload-${idFromBytes(await randomBytes(16))}`);
        await assertLayoutRoot(options.layout, "generatedRoot", "sealProjectionRoot");
        try {
          await mkdir(candidate, { mode: 0o700 });
          prepared = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (prepared === undefined) throw new Error("projection payload collision limit exceeded");
      const preparedStat = await lstat(prepared);
      if (!preparedStat.isDirectory() || preparedStat.isSymbolicLink()) throw new Error("projection payload is not a real directory");
      preparedIdentity = { dev: preparedStat.dev, ino: preparedStat.ino };
      const assertPreparedBeforeEffect: BeforeEffect = async () => {
        await assertLayoutRoot(options.layout, "generatedRoot", "sealProjectionRoot");
        await assertOwnedDirectory(prepared!, "sealProjectionRoot", preparedIdentity!, options.layout.rootCapabilities.generatedRoot);
      };

      const entries = await projectionEntriesWithHash(record.root, options.sha256);
      await copyProjectionTree(record.root, prepared, entries, assertProjectionBeforeEffect, assertPreparedBeforeEffect);
      await assertProjectionBeforeEffect();
      if (await hashProjectionRoot(record.root, options.sha256) !== input.payloadDigest) throw new Error("projection source changed during publication");
      await assertPreparedBeforeEffect();
      if (await hashProjectionRoot(prepared, options.sha256) !== input.payloadDigest) throw new Error("prepared projection differs from its source");

      const metadata: ProjectionMetadata = {
        version: 2,
        projectionRef: input.projectionRef,
        projectionDigest: input.projectionDigest,
        payloadDigest: input.payloadDigest,
        scope: input.scope,
        plugin: input.plugin,
        payload: basename(prepared),
      };
      await assertPreparedBeforeEffect();
      await writeFile(join(prepared, METADATA), JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      await assertPreparedBeforeEffect();
      await writeFile(join(prepared, READY_TMP), READY_TEXT, { flag: "wx", mode: 0o600 });
      await assertPreparedBeforeEffect();
      await rename(join(prepared, READY_TMP), join(prepared, READY));
      await assertPreparedBeforeEffect();
      await chmod(join(prepared, METADATA), 0o444);
      await assertPreparedBeforeEffect();
      await chmod(join(prepared, READY), 0o444);
      await sealProjectionTree(prepared, options.sha256, options.platform, assertPreparedBeforeEffect);
      await assertPreparedBeforeEffect();
      await options.platform.syncFile(join(prepared, METADATA));
      await assertPreparedBeforeEffect();
      await options.platform.syncFile(join(prepared, READY));
      await assertPreparedBeforeEffect();
      await chmod(prepared, 0o555);
      await assertPreparedBeforeEffect();
      await options.platform.syncDirectory(prepared);
      await inspectProjection(prepared, options.sha256);
      throwIfAborted(signal);
      await assertPreparedBeforeEffect();
      const publication = await options.platform.publishDirectoryNoReplace(prepared, target);
      if (publication === "exists") {
        const existing = await inspectPublishedProjection(target, options.sha256);
        if (!projectionMetadataMatches(existing.metadata, input, options.sha256)) {
          throw rootError("storeIdentityCollision", "sealProjectionRoot", "concurrent projection publication collides with different content");
        }
        await tryCleanupPrepared();
        await tryCleanupSource();
        if (preparedCleanupFailure !== undefined || sourceCleanupFailure !== undefined) {
          throw cleanupError(new Error("identical projection lost publication race"));
        }
        return { root: existing.root, scope: input.scope, plugin: input.plugin, projectionDigest: input.projectionDigest, payloadDigest: input.payloadDigest, projectionRef: input.projectionRef };
      }
      published = true;
      await assertLayoutRoot(options.layout, "generatedRoot", "sealProjectionRoot");
      await options.platform.syncDirectory(options.layout.generatedRoot);
      if (await tryCleanupSource() !== undefined) throw cleanupError(new Error("published projection staging cleanup failed"));
      const visible = await inspectPublishedProjection(target, options.sha256);
      return { root: visible.root, scope: input.scope, plugin: input.plugin, projectionDigest: input.projectionDigest, payloadDigest: input.payloadDigest, projectionRef: input.projectionRef };
    } catch (error) {
      if (!published) {
        await tryCleanupPrepared();
        await tryCleanupSource();
        if (preparedCleanupFailure !== undefined || sourceCleanupFailure !== undefined) {
          if (isIncompleteCleanup(error)) throw error;
          throw cleanupError(error);
        }
      }
      if (signal.aborted) throw error;
      if (error instanceof DomainContractError) throw error;
      throw rootError("adapterFailed", "sealProjectionRoot", "projection root publication failed", error);
    }
  }

  async function discardProjectionRoot(input: ProjectionRootAllocation, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const record = input !== null && typeof input === "object" ? projectionAllocations.get(input) : undefined;
    if (record === undefined || record.allocation.root !== input.root || record.allocation.allocationId !== input.allocationId) {
      throw rootError("stagingAllocationInvalid", "discardProjectionRoot", "projection root allocation capability is invalid");
    }
    await assertProjectionAllocation(record, options.layout, "discardProjectionRoot");
    try {
      await removePreparedTree(record.root, record.identity, options.layout.rootCapabilities.projectionStagingRoot);
      await assertLayoutRoot(options.layout, "projectionStagingRoot", "discardProjectionRoot");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw rootError("adapterFailed", "discardProjectionRoot", "projection root allocation could not be discarded", cause);
    }
  }

  async function resolveProjectionRoot(input: ProjectionRootRequest, signal: AbortSignal): Promise<ResolvedProjectionRoot> {
    throwIfAborted(signal);
    const scope = ScopeReferenceSchema.parse(input.scope);
    const plugin = PluginKeySchema.parse(input.plugin);
    const projectionDigest = ContentDigestSchema.parse(input.projectionDigest);
    const projectionRef = ProjectionRootRefSchema.parse(input.projectionRef);
    const expectedRef = deriveProjectionRootRef({ scope, plugin, projectionDigest }, options.sha256);
    if (projectionRef !== expectedRef) throw rootError("contentVerificationFailed", "resolveProjectionRoot", "projection reference does not match its identity");
    await assertLayoutRoot(options.layout, "generatedRoot", "resolveProjectionRoot");
    const publication = options.layout.projectionPath(projectionRef);
    const { root, metadata } = await inspectPublishedProjection(publication, options.sha256);
    if (!projectionMetadataMatches(metadata, {
      scope,
      plugin,
      projectionDigest,
      payloadDigest: metadata.payloadDigest,
      projectionRef,
    }, options.sha256) || (input.payloadDigest !== undefined && metadata.payloadDigest !== input.payloadDigest)) {
      throw rootError("contentVerificationFailed", "resolveProjectionRoot", "projection root evidence does not match its identity");
    }
    await assertLayoutRoot(options.layout, "generatedRoot", "resolveProjectionRoot");
    return {
      root,
      scope,
      plugin,
      projectionDigest,
      payloadDigest: metadata.payloadDigest,
      projectionRef,
    };
  }

  return Object.freeze({ ensureDataRoot, allocateProjectionRoot, sealProjectionRoot, discardProjectionRoot, resolveProjectionRoot });
}

export async function inspectPublishedProjection(
  publication: string,
  sha256: Sha256,
): Promise<Readonly<{ root: string; metadata: ProjectionMetadata }>> {
  try {
    const publicationStat = await lstat(publication);
    if (publicationStat.isDirectory() && !publicationStat.isSymbolicLink()) {
      return { root: publication, metadata: await inspectProjection(publication, sha256) };
    }
    if (!publicationStat.isFile() || publicationStat.isSymbolicLink() || (publicationStat.mode & 0o777) !== 0o444) {
      throw new Error("projection publication marker is invalid");
    }
    const marker = ProjectionMetadataSchema.parse(JSON.parse(await readFile(publication, "utf8")));
    if (marker.version !== 2 || marker.projectionRef !== `runtime-projection-v1:sha256:${basename(publication)}`) {
      throw new Error("projection publication marker identity is invalid");
    }
    const root = join(dirname(publication), marker.payload);
    const [rootStat, metadataStat, publicationAfter] = await Promise.all([
      lstat(root),
      lstat(join(root, METADATA)),
      lstat(publication),
    ]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root ||
        !metadataStat.isFile() || metadataStat.isSymbolicLink() ||
        publicationStat.dev !== publicationAfter.dev || publicationStat.ino !== publicationAfter.ino ||
        publicationStat.dev !== metadataStat.dev || publicationStat.ino !== metadataStat.ino) {
      throw new Error("projection publication marker changed identity");
    }
    const metadata = await inspectProjection(root, sha256);
    if (!sameJson(metadata, marker)) throw new Error("projection publication marker does not match its payload");
    return { root, metadata };
  } catch (cause) {
    if (cause instanceof DomainContractError) throw cause;
    throw rootError("contentVerificationFailed", "resolveProjectionRoot", "projection publication verification failed", cause);
  }
}

export async function inspectProjection(root: string, sha256: Sha256): Promise<ProjectionMetadata> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error("projection root is not a real directory");
    }
    const markerStat = await lstat(join(root, READY));
    const metadataStat = await lstat(join(root, METADATA));
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.isSymbolicLink()) {
      throw new Error("publication controls are not regular files");
    }
    const marker = await readFile(join(root, READY), "utf8");
    if (marker !== READY_TEXT) throw new Error("ready marker content mismatch");
    const metadata = ProjectionMetadataSchema.parse(JSON.parse(await readFile(join(root, METADATA), "utf8")));
    if ((markerStat.mode & 0o777) !== 0o444 || (metadataStat.mode & 0o777) !== 0o444) {
      throw new Error("publication controls are mutable");
    }
    if ((rootStat.mode & 0o777) !== 0o555) {
      throw new Error("projection root is not read-only");
    }
    const payloadDigest = await hashProjectionRoot(root, sha256);
    if (payloadDigest !== metadata.payloadDigest) throw new Error("projection root payload digest does not match metadata");
    const expectedRef = deriveProjectionRootRef({
      scope: metadata.scope,
      plugin: metadata.plugin,
      projectionDigest: metadata.projectionDigest,
    }, sha256);
    if (metadata.projectionRef !== expectedRef) throw new Error("projection metadata identity is not self-bound");
    return metadata;
  } catch (cause) {
    if (cause instanceof DomainContractError) throw cause;
    throw rootError("contentVerificationFailed", "resolveProjectionRoot", "projection marker or metadata verification failed", cause);
  }
}
