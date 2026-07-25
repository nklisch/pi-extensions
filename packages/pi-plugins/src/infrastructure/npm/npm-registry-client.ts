import { createHash, timingSafeEqual } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { z } from "zod";
import {
  NpmIntegritySchema,
  PluginSourceSchema,
  type NpmIntegrity,
  type PluginSource,
} from "../../domain/source.js";
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  type MaterializationLimits,
} from "../../application/ports/source-acquisition.js";
import { SourceMaterializationError } from "../../application/source-materialization.js";
import {
  BoundedFetchError,
  collectBoundedBytes,
  decodeUtf8,
  type BoundedFetch,
  type NpmCredentialProvider,
} from "../http/bounded-fetch.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const semver = require("semver") as Readonly<{
  valid(version: string): string | null;
  validRange(range: string): string | null;
  satisfies(version: string, range: string, options?: Readonly<{ includePrerelease?: boolean }>): boolean;
  maxSatisfying(versions: readonly string[], range: string, options?: Readonly<{ includePrerelease?: boolean }>): string | null;
}>;

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const NO_FOLLOW = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

export type NpmVersionRecord = Readonly<{
  version: string;
  tarball: string;
  integrity: NpmIntegrity;
}>;

export interface NpmRegistryClient {
  resolve(
    source: Extract<PluginSource, { kind: "npm" }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    package: string;
    registry: string;
    selected: NpmVersionRecord;
  }>>;
  downloadVerified(
    record: NpmVersionRecord,
    destinationFile: string,
    limits: MaterializationLimits,
    signal: AbortSignal,
  ): Promise<void>;
}

type RegistryClientOptions = Readonly<{
  fetch: BoundedFetch;
  credentials: NpmCredentialProvider;
  limits?: Partial<MaterializationLimits>;
}>;

type ParsedVersion = Readonly<{
  version: string;
  tarball: string;
  integrity: string | undefined;
}>;

// Parse through a strict projection: metadata is validated at the boundary,
// then unknown packument fields are discarded before selector logic sees it.
const VersionMetadataSchema = z.object({
  version: z.string().min(1),
  dist: z.object({
    tarball: z.string().min(1),
    integrity: z.string().optional(),
  }).strip(),
}).strip();

const PackumentSchema = z.object({
  "dist-tags": z.record(z.string(), z.string().min(1)),
  versions: z.record(z.string(), VersionMetadataSchema),
}).strip();

function safeFailure(
  code: "SOURCE_RESOLUTION_FAILED" | "PATH_CONTAINMENT_FAILED" | "ADAPTER_FAILED",
  classification: "security" | "permanent" | "transient",
  operation: string,
  message: string,
  cause?: unknown,
): SourceMaterializationError {
  return new SourceMaterializationError({
    code,
    classification,
    operation,
    message,
    details: { operation },
    cause,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function limitsWithDefaults(input: Partial<MaterializationLimits> = {}): MaterializationLimits {
  const limits = { ...DEFAULT_MATERIALIZATION_LIMITS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`materialization limit ${name} must be positive`);
  }
  if (limits.maxExpansionRatio < 1) throw new TypeError("maxExpansionRatio must be at least one");
  return Object.freeze(limits);
}

function validatePackageName(value: string): string {
  // npm package names are one document key. Deliberately do not accept URL
  // paths, encoded separators, whitespace, or uppercase aliases.
  const unscoped = /^[a-z0-9][a-z0-9._~-]*$/u;
  const scoped = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/u;
  if ((!unscoped.test(value) && !scoped.test(value)) || value.includes("%")) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm package name is invalid");
  }
  return value;
}

function packageDocumentUrl(registry: string, packageName: string): string {
  let base: URL;
  try {
    base = new URL(registry);
  } catch (error) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm registry is invalid", error);
  }
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "") {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm registry must be credential-free HTTPS");
  }
  if (base.search !== "" || base.hash !== "") {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm registry must not contain query or fragment data");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const encoded = encodeURIComponent(packageName).replace(/%2F/gu, "%2f");
  return new URL(encoded, base).toString();
}

function safeTarballUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm tarball URL is invalid", error);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm tarball URL must be credential-free HTTPS");
  }
  if (url.search !== "" || url.hash !== "") {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm tarball URL must not contain query or fragment data");
  }
  return url.toString();
}

function canonicalVersion(key: string, value: string): string {
  const parsed = semver.valid(value);
  if (parsed === null || parsed !== value || key !== value) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm packument contains a non-canonical version");
  }
  return value;
}

function parseVersions(input: z.infer<typeof PackumentSchema>): Map<string, ParsedVersion> {
  const versions = new Map<string, ParsedVersion>();
  for (const [key, value] of Object.entries(input.versions)) {
    const version = canonicalVersion(key, value.version);
    if (versions.has(version)) {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm packument contains duplicate versions");
    }
    versions.set(version, {
      version,
      tarball: value.dist.tarball,
      integrity: value.dist.integrity,
    });
  }
  return versions;
}

function parseSelected(record: ParsedVersion): NpmVersionRecord {
  const integrity = record.integrity;
  if (integrity === undefined) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm package has no SHA-512 integrity");
  }
  let canonicalIntegrity: NpmIntegrity;
  try {
    canonicalIntegrity = NpmIntegritySchema.parse(integrity);
  } catch (error) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm package integrity is not canonical SHA-512", error);
  }
  const tarball = safeTarballUrl(record.tarball);
  return Object.freeze({ version: record.version, tarball, integrity: canonicalIntegrity });
}

function selectVersion(
  selector: string | undefined,
  tags: Readonly<Record<string, string>>,
  versions: ReadonlyMap<string, ParsedVersion>,
): ParsedVersion {
  let selected: string | undefined;
  if (selector === undefined) {
    selected = tags.latest;
    if (selected === undefined) {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm package has no latest dist-tag");
    }
  } else if (semver.valid(selector) !== null) {
    // Exact selectors are key lookups, not loose semver aliases.
    selected = selector;
  } else if (Object.prototype.hasOwnProperty.call(tags, selector)) {
    selected = tags[selector];
  } else {
    const range = semver.validRange(selector);
    if (range === null) {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm selector is unknown or invalid");
    }
    const candidates = [...versions.keys()];
    selected = semver.maxSatisfying(candidates, range, { includePrerelease: false }) ?? undefined;
    if (selected === undefined) {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm selector matches no stable version");
    }
    // Keep this explicit: semver's prerelease rule is part of the contract,
    // and this check prevents a future resolver change from widening it.
    if (!semver.satisfies(selected, range, { includePrerelease: false })) {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm selector result is not satisfying");
    }
  }
  if (selected === undefined || versions.get(selected) === undefined) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm selector resolves to a missing version");
  }
  return versions.get(selected)!;
}

function statusFailure(operation: string, status: number): SourceMaterializationError {
  const transient = status === 408 || status === 429 || status >= 500;
  return safeFailure(
    "SOURCE_RESOLUTION_FAILED",
    transient ? "transient" : "permanent",
    operation,
    transient ? "npm registry is temporarily unavailable" : "npm registry rejected the request",
  );
}

function requestFailure(operation: string, error: unknown): SourceMaterializationError {
  if (error instanceof SourceMaterializationError) return error;
  if (error instanceof BoundedFetchError) {
    if (error.kind === "limit") {
      return safeFailure("PATH_CONTAINMENT_FAILED", "security", operation, "HTTP response exceeded its byte limit");
    }
    if (error.kind === "network") {
      return safeFailure("SOURCE_RESOLUTION_FAILED", "transient", operation, "npm registry network request failed");
    }
    if (error.kind === "policy") {
      return safeFailure("SOURCE_RESOLUTION_FAILED", "security", operation, "npm registry destination is not permitted");
    }
    if (error.kind === "credential") {
      return safeFailure("ADAPTER_FAILED", "permanent", operation, "npm credential adapter failed");
    }
    return safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", operation, "npm registry response was invalid");
  }
  return safeFailure("ADAPTER_FAILED", "permanent", operation, "npm HTTP adapter failed", error);
}

async function responseBytes(
  client: BoundedFetch,
  credentials: NpmCredentialProvider,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  operation: string,
): Promise<{ readonly status: number; readonly body: Uint8Array }> {
  throwIfAborted(signal);
  let response;
  try {
    response = await client.request({ url, maxBytes, signal, credentials });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw requestFailure(operation, error);
  }
  if (response.status < 200 || response.status >= 300) {
    try { await collectBoundedBytes(response.body, Math.min(maxBytes, 64 * 1024), signal); } catch { /* body is never diagnostic */ }
    throw statusFailure(operation, response.status);
  }
  try {
    return { status: response.status, body: await collectBoundedBytes(response.body, maxBytes, signal) };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof BoundedFetchError && error.kind === "limit") {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", operation, "npm packument exceeded its byte limit");
    }
    throw requestFailure(operation, error);
  }
}

async function writePersisted(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  digest: ReturnType<typeof createHash>,
): Promise<number> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    const written = result.bytesWritten;
    if (!Number.isSafeInteger(written) || written <= 0 || written > chunk.byteLength - offset) throw new Error("file write made no progress");
    digest.update(chunk.subarray(offset, offset + written));
    offset += written;
  }
  return offset;
}

async function rehashPersisted(path: string): Promise<Uint8Array> {
  const digest = createHash("sha512");
  const stream = createReadStream(path) as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new Error("persisted tarball yielded a non-byte value");
    digest.update(chunk);
  }
  return new Uint8Array(digest.digest());
}

async function writeAndVerify(
  client: BoundedFetch,
  credentials: NpmCredentialProvider,
  record: NpmVersionRecord,
  destinationFile: string,
  limits: MaterializationLimits,
  signal: AbortSignal,
): Promise<void> {
  let response;
  try {
    response = await client.request({
      url: record.tarball,
      maxBytes: limits.maxArchiveBytes,
      signal,
      credentials,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw requestFailure("downloadNpmTarball", error);
  }
  if (response.status < 200 || response.status >= 300) {
    try { await collectBoundedBytes(response.body, Math.min(limits.maxArchiveBytes, 64 * 1024), signal); } catch { /* never diagnostic */ }
    throw statusFailure("downloadNpmTarball", response.status);
  }

  const expected = Buffer.from(record.integrity.slice("sha512-".length), "base64");
  if (expected.byteLength !== 64) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "downloadNpmTarball", "npm integrity is not a SHA-512 digest");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let written = 0;
  const digest = createHash("sha512");
  try {
    const parent = dirname(destinationFile);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("npm tarball scratch parent is not a real directory");
    if (basename(await realpath(parent)) !== ".work") throw new Error("npm tarball destination is outside private scratch work");
    handle = await open(destinationFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
    for await (const chunk of response.body) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) throw safeFailure("ADAPTER_FAILED", "permanent", "downloadNpmTarball", "HTTP response body was not bytes");
      if (written + chunk.byteLength > limits.maxArchiveBytes) {
        throw safeFailure("PATH_CONTAINMENT_FAILED", "security", "downloadNpmTarball", "npm tarball byte limit exceeded");
      }
      written += await writePersisted(handle, chunk, digest);
    }
    throwIfAborted(signal);
    const actual = new Uint8Array(digest.digest());
    await handle.close();
    handle = undefined;
    const diskDigest = await rehashPersisted(destinationFile);
    const equal = actual.byteLength === expected.byteLength
      && diskDigest.byteLength === expected.byteLength
      && timingSafeEqual(actual, expected)
      && timingSafeEqual(diskDigest, expected);
    if (!equal) {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "downloadNpmTarball", "npm tarball integrity mismatch");
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    let cleanupError: unknown;
    try { await rm(destinationFile, { force: true }); } catch (failure) { cleanupError = failure; }
    if (cleanupError !== undefined) {
      throw safeFailure("ADAPTER_FAILED", "permanent", "abortMaterialization", "failed to remove npm tarball scratch data", new AggregateError([error, cleanupError]));
    }
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof SourceMaterializationError) throw error;
    throw requestFailure("downloadNpmTarball", error);
  }
}

export function createNpmRegistryClient(options: RegistryClientOptions): NpmRegistryClient {
  if (options === null || typeof options !== "object") throw new TypeError("npm registry client options are required");
  if (typeof options.fetch?.request !== "function") throw new TypeError("npm registry client requires bounded fetch");
  if (options.credentials === null || options.credentials === undefined) throw new TypeError("npm registry client requires credentials");

  return {
    async resolve(input, signal) {
      throwIfAborted(signal);
      let source: Extract<PluginSource, { kind: "npm" }>;
      try {
        const parsed = PluginSourceSchema.parse(input);
        if (parsed.kind !== "npm") throw new Error("source is not npm");
        source = parsed;
      } catch (error) {
        throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm source declaration is invalid", error);
      }
      const packageName = validatePackageName(source.package);
      const registry = source.registry ?? DEFAULT_REGISTRY;
      const url = packageDocumentUrl(registry, packageName);
      const limits = limitsWithDefaults(options.limits ?? {});
      const result = await responseBytes(options.fetch, options.credentials, url, limits.maxPackumentBytes, signal, "resolveNpmSource");
      throwIfAborted(signal);
      let parsed: z.infer<typeof PackumentSchema>;
      try {
        parsed = PackumentSchema.parse(JSON.parse(decodeUtf8(result.body)));
      } catch (error) {
        if (error instanceof BoundedFetchError) throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm packument is not valid UTF-8", error);
        throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveNpmSource", "npm packument metadata is malformed", error);
      }
      const versions = parseVersions(parsed);
      const selected = selectVersion(source.selector, parsed["dist-tags"], versions);
      const record = parseSelected(selected);
      return Object.freeze({ package: packageName, registry, selected: record });
    },

    async downloadVerified(record, destinationFile, limitsInput, signal) {
      throwIfAborted(signal);
      let selected: NpmVersionRecord;
      try {
        selected = {
          version: canonicalVersion(record.version, record.version),
          tarball: safeTarballUrl(record.tarball),
          integrity: NpmIntegritySchema.parse(record.integrity),
        };
      } catch (error) {
        if (error instanceof SourceMaterializationError) throw error;
        throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "downloadNpmTarball", "npm tarball record is invalid", error);
      }
      if (typeof destinationFile !== "string" || destinationFile.length === 0) throw new TypeError("npm tarball destination is required");
      if (basename(dirname(destinationFile)) !== ".work") {
        throw safeFailure("ADAPTER_FAILED", "permanent", "downloadNpmTarball", "npm tarball destination must be inside private scratch work");
      }
      const limits = limitsWithDefaults(limitsInput);
      await writeAndVerify(options.fetch, options.credentials, selected, destinationFile, limits, signal);
    },
  };
}

export type { RegistryClientOptions as NpmRegistryClientOptions };
export type { BoundedFetch, NpmCredentialProvider } from "../http/bounded-fetch.js";
export { DEFAULT_REGISTRY };
