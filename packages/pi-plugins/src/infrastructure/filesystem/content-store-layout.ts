import { lstat, mkdir, chmod, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  contentStoreKeyDigest,
  ContentStoreIdentitySchema,
  type ContentStoreIdentity,
} from "../../domain/content-store.js";
import {
  PluginDataRefSchema,
  ProjectionRootRefSchema,
  type PluginDataRef,
  type ProjectionRootRef,
} from "../../domain/state/references.js";
import { DomainContractError, ErrorCodeRegistry } from "../../domain/errors.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const STAGING_VERSION = "v1";
const STORE_VERSION = "v1";
const DATA_VERSION = "v1";
const GENERATED_VERSION = "v1";

export type RootIdentity = Readonly<{
  path: string;
  realpath: string;
  dev: number;
  ino: number;
}>;

/**
 * A persistent path capability. `ancestors` is deliberately retained rather
 * than recomputed: checking only the leaf lets a swapped parent redirect a
 * perfectly real leaf into a foreign tree.
 */
export type RootCapability = Readonly<RootIdentity & {
  ancestors: readonly RootIdentity[];
}>;

export type ContentStoreRootCapabilities = Readonly<{
  hostRoot: RootCapability;
  stagingRoot: RootCapability;
  storesRoot: RootCapability;
  marketplaceStoreRoot: RootCapability;
  pluginStoreRoot: RootCapability;
  dataRoot: RootCapability;
  generatedRoot: RootCapability;
  projectionStagingRoot: RootCapability;
}>;

export type ContentStoreLayout = Readonly<{
  hostRoot: string;
  stagingRoot: string;
  storesRoot: string;
  marketplaceStoreRoot: string;
  pluginStoreRoot: string;
  dataRoot: string;
  generatedRoot: string;
  projectionStagingRoot: string;
  rootCapabilities: ContentStoreRootCapabilities;
  marketplacePath(identity: ContentStoreIdentity): string;
  pluginPath(identity: ContentStoreIdentity): string;
  dataPath(dataRef: PluginDataRef): string;
  projectionPath(projectionRef: ProjectionRootRef): string;
}>;

function layoutError(message: string, cause?: unknown, operation = "bootstrapContentStoreLayout"): DomainContractError {
  return new DomainContractError({
    code: ErrorCodeRegistry.stagingAllocationInvalid,
    operation,
    message,
    details: { operation },
    ...(cause === undefined ? {} : { cause }),
  });
}

function assertAbsoluteHostRoot(hostRoot: string): string {
  if (typeof hostRoot !== "string" || hostRoot.length === 0 || !isAbsolute(hostRoot)) {
    throw layoutError("content store host root must be absolute");
  }
  const resolved = resolve(hostRoot);
  if (resolved !== parse(resolved).root && resolved.endsWith("/")) {
    // `resolve` normally strips the trailing slash. This branch documents that
    // a root is a directory identity, not a path segment supplied by callers.
    return resolved.slice(0, -1);
  }
  return resolved;
}

async function mkdirPrivate(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    // Concurrent clean-host startup may create the same component after our
    // ENOENT observation. EEXIST is safe to re-inspect below; files and
    // symlinks are still rejected by the existing lstat/capability checks.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function ensurePrivateDirectory(path: string, operation: string): Promise<string> {
  try {
    await captureRootCapability(dirname(resolve(path)), operation);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdirPrivate(path);
      stat = await lstat(path);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("content store path component is not a real directory");
    }
    await captureRootCapability(dirname(resolve(path)), operation);
    await chmod(path, PRIVATE_DIRECTORY_MODE);
    const verified = await lstat(path);
    if (!verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o077) !== 0) {
      throw new Error("content store directory is not private");
    }
    return await realpath(path);
  } catch (error) {
    if (error instanceof DomainContractError) throw error;
    throw new DomainContractError({
      code: ErrorCodeRegistry.stagingAllocationInvalid,
      operation,
      message: "content store root is unavailable or not private",
      details: { operation },
      cause: error,
    });
  }
}

/** Create every parent below an adapter-owned absolute root without following symlinks. */
async function bootstrapRoot(hostRoot: string): Promise<string> {
  const absolute = assertAbsoluteHostRoot(hostRoot);
  const parsed = parse(absolute);
  let current = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    await captureRootCapability(dirname(current), "bootstrapContentStoreLayout");
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw layoutError("content store host root cannot be inspected", error);
      await mkdirPrivate(current);
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw layoutError("content store host root contains a symlink or non-directory");
  }
  return ensurePrivateDirectory(absolute, "bootstrapContentStoreLayout");
}

function digestSegment(value: string, schema: { parse(input: unknown): string }, prefix: string): string {
  const parsed = schema.parse(value);
  if (!parsed.startsWith(prefix)) throw layoutError("logical reference has the wrong kind");
  const digest = parsed.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw layoutError("logical reference digest is invalid");
  return digest;
}

function storePath(layout: ContentStoreLayout, identity: ContentStoreIdentity): string {
  const value = ContentStoreIdentitySchema.parse(identity);
  const digest = contentStoreKeyDigest(value);
  return join(value.kind === "marketplace" ? layout.marketplaceStoreRoot : layout.pluginStoreRoot, digest);
}

/**
 * Bootstrap and return the path codec. Only validated digest/reference values
 * can become a path segment; source URLs, aliases, plugin names, and project
 * roots never reach this module's joins.
 */
async function captureRootCapability(path: string, operation: string): Promise<RootCapability> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const rootStat = await lstat(current).catch((cause) => { throw layoutError("owned root cannot be inspected", cause); });
  const rootCanonical = await realpath(current).catch((cause) => { throw layoutError("owned root cannot be canonicalized", cause); });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootCanonical !== current) throw layoutError("owned root contains a symlink or non-directory");
  const ancestors: RootIdentity[] = [Object.freeze({ path: current, realpath: rootCanonical, dev: rootStat.dev, ino: rootStat.ino })];
  for (const segment of absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    const stat = await lstat(current).catch((cause) => { throw layoutError("owned root cannot be inspected", cause); });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw layoutError("owned root contains a symlink or non-directory");
    const canonical = await realpath(current).catch((cause) => { throw layoutError("owned root cannot be canonicalized", cause); });
    if (canonical !== current) throw layoutError("owned root resolves through a symlink");
    ancestors.push(Object.freeze({ path: current, realpath: canonical, dev: stat.dev, ino: stat.ino }));
  }
  const identity = ancestors.at(-1)!;
  return Object.freeze({ ...identity, ancestors: Object.freeze(ancestors) });
}

/** Revalidate every no-follow component of a retained root capability. */
export async function assertRootCapability(capability: RootCapability, operation: string): Promise<void> {
  for (const expected of capability.ancestors) {
    const stat = await lstat(expected.path).catch((cause) => { throw layoutError("owned root is unavailable", cause); });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw layoutError("owned root identity changed");
    }
    const canonical = await realpath(expected.path).catch((cause) => { throw layoutError("owned root cannot be canonicalized", cause); });
    if (canonical !== expected.realpath || canonical !== expected.path) throw layoutError("owned root containment changed");
  }
  const leaf = capability.ancestors.at(-1);
  if (leaf === undefined || leaf.path !== capability.path || leaf.dev !== capability.dev || leaf.ino !== capability.ino || leaf.realpath !== capability.realpath) {
    throw layoutError("owned root capability is malformed");
  }
  void operation;
}

export async function assertLayoutRoot(
  layout: ContentStoreLayout,
  root: keyof ContentStoreRootCapabilities,
  operation: string,
): Promise<void> {
  await assertRootCapability(layout.rootCapabilities[root], operation);
}

export async function createContentStoreLayout(hostRoot: string): Promise<ContentStoreLayout> {
  const root = await bootstrapRoot(hostRoot);
  const stagingParent = await ensurePrivateDirectory(join(root, "staging"), "bootstrapContentStoreLayout");
  const stagingRoot = await ensurePrivateDirectory(join(stagingParent, STAGING_VERSION), "bootstrapContentStoreLayout");
  const storesParent = await ensurePrivateDirectory(join(root, "stores"), "bootstrapContentStoreLayout");
  const storesRoot = await ensurePrivateDirectory(join(storesParent, STORE_VERSION), "bootstrapContentStoreLayout");
  const marketplaceParent = await ensurePrivateDirectory(join(storesRoot, "marketplaces"), "bootstrapContentStoreLayout");
  const marketplaceStoreRoot = await ensurePrivateDirectory(marketplaceParent, "bootstrapContentStoreLayout");
  const pluginParent = await ensurePrivateDirectory(join(storesRoot, "plugins"), "bootstrapContentStoreLayout");
  const pluginStoreRoot = await ensurePrivateDirectory(pluginParent, "bootstrapContentStoreLayout");
  const dataParent = await ensurePrivateDirectory(join(root, "data"), "bootstrapContentStoreLayout");
  const dataRoot = await ensurePrivateDirectory(join(dataParent, DATA_VERSION), "bootstrapContentStoreLayout");
  const generatedParent = await ensurePrivateDirectory(join(root, "generated"), "bootstrapContentStoreLayout");
  const generatedRoot = await ensurePrivateDirectory(join(generatedParent, GENERATED_VERSION), "bootstrapContentStoreLayout");
  const projectionStagingRoot = await ensurePrivateDirectory(join(generatedRoot, ".staging"), "bootstrapContentStoreLayout");
  const rootCapabilities: ContentStoreRootCapabilities = Object.freeze({
    hostRoot: await captureRootCapability(root, "bootstrapContentStoreLayout"),
    stagingRoot: await captureRootCapability(stagingRoot, "bootstrapContentStoreLayout"),
    storesRoot: await captureRootCapability(storesRoot, "bootstrapContentStoreLayout"),
    marketplaceStoreRoot: await captureRootCapability(marketplaceStoreRoot, "bootstrapContentStoreLayout"),
    pluginStoreRoot: await captureRootCapability(pluginStoreRoot, "bootstrapContentStoreLayout"),
    dataRoot: await captureRootCapability(dataRoot, "bootstrapContentStoreLayout"),
    generatedRoot: await captureRootCapability(generatedRoot, "bootstrapContentStoreLayout"),
    projectionStagingRoot: await captureRootCapability(projectionStagingRoot, "bootstrapContentStoreLayout"),
  });

  const layout: ContentStoreLayout = {
    hostRoot: root,
    stagingRoot,
    storesRoot,
    marketplaceStoreRoot,
    pluginStoreRoot,
    dataRoot,
    generatedRoot,
    projectionStagingRoot,
    rootCapabilities,
    marketplacePath(identity) {
      const value = ContentStoreIdentitySchema.parse(identity);
      if (value.kind !== "marketplace") throw layoutError("marketplace path requires a marketplace identity");
      return storePath(layout, value);
    },
    pluginPath(identity) {
      const value = ContentStoreIdentitySchema.parse(identity);
      if (value.kind !== "plugin") throw layoutError("plugin path requires a plugin identity");
      return storePath(layout, value);
    },
    dataPath(dataRef) {
      return join(layout.dataRoot, digestSegment(dataRef, PluginDataRefSchema, "plugin-data-v1:sha256:"));
    },
    projectionPath(projectionRef) {
      return join(layout.generatedRoot, digestSegment(projectionRef, ProjectionRootRefSchema, "runtime-projection-v1:sha256:"));
    },
  };
  return Object.freeze(layout);
}

export function stagingAllocationPath(layout: ContentStoreLayout, allocationId: string): string {
  if (typeof allocationId !== "string" || !/^[0-9a-f]{32}$/u.test(allocationId)) {
    throw layoutError("staging allocation id is invalid");
  }
  return join(layout.stagingRoot, allocationId);
}

export function projectionStagingPath(layout: ContentStoreLayout, allocationId: string): string {
  if (typeof allocationId !== "string" || !/^[0-9a-f]{32}$/u.test(allocationId)) {
    throw layoutError("projection allocation id is invalid");
  }
  return join(layout.projectionStagingRoot, allocationId);
}

export async function assertOwnedDirectory(
  path: string,
  operation: string,
  expected?: Readonly<{ realpath?: string; dev: number; ino: number }>,
  parent?: RootCapability,
): Promise<{ readonly realpath: string; readonly dev: number; readonly ino: number }> {
  if (parent !== undefined) await assertRootCapability(parent, operation);
  const stat = await lstat(path).catch((cause) => {
    throw new DomainContractError({
      code: ErrorCodeRegistry.stagingAllocationInvalid,
      operation,
      message: "owned directory is unavailable",
      details: { operation },
      cause,
    });
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainContractError({
      code: ErrorCodeRegistry.stagingAllocationInvalid,
      operation,
      message: "owned path is not a real directory",
      details: { operation },
    });
  }
  if (expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino)) {
    throw new DomainContractError({
      code: ErrorCodeRegistry.stagingAllocationInvalid,
      operation,
      message: "owned directory identity changed",
      details: { operation },
    });
  }
  const canonical = await realpath(path).catch((cause) => {
    throw new DomainContractError({
      code: ErrorCodeRegistry.stagingAllocationInvalid,
      operation,
      message: "owned directory cannot be canonicalized",
      details: { operation },
      cause,
    });
  });
  if (canonical !== path || (expected !== undefined && expected.realpath !== undefined && canonical !== expected.realpath)) {
    throw new DomainContractError({
      code: ErrorCodeRegistry.stagingAllocationInvalid,
      operation,
      message: "owned path changed identity",
      details: { operation },
    });
  }
  return { realpath: canonical, dev: stat.dev, ino: stat.ino };
}
