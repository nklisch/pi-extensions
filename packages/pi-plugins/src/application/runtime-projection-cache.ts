import { z } from "zod";
import {
  hashContent,
  type ContentDigest,
} from "../domain/content-manifest.js";
import { ComponentIdSchema } from "../domain/components.js";
import type { Sha256 } from "../domain/source.js";
import {
  createActiveProjectionExpectation,
  PluginRuntimeProjectionSchemaV1,
  type PluginRuntimeProjection,
  type ProjectionExpectation,
  type RuntimeProjectionPort,
} from "./ports/runtime-projection.js";

/** The cache is deliberately one bounded descriptor, not a component store. */
export const RUNTIME_PROJECTION_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const RUNTIME_PROJECTION_CACHE_FILE = "projection.json";
const RUNTIME_PROJECTION_PAYLOAD_PREFIX = "projection-root-v1\0";

export const RuntimeProjectionCacheEnvelopeSchemaV1 = z.object({
  cacheVersion: z.literal(1),
  projection: PluginRuntimeProjectionSchemaV1,
}).strict().readonly();
export type RuntimeProjectionCacheEnvelope = z.infer<typeof RuntimeProjectionCacheEnvelopeSchemaV1>;

export type PreparedRuntimeProjection = Readonly<{
  expectation: Extract<ProjectionExpectation, { kind: "active" }>;
  projection: PluginRuntimeProjection;
  payloadDigest: ContentDigest;
}>;

export type RuntimeProjectionCacheReadResult =
  | Readonly<{ kind: "ready"; value: PreparedRuntimeProjection }>
  | Readonly<{
      kind: "failed";
      code: "CACHE_MISSING" | "CACHE_CORRUPT" | "IDENTITY_COLLISION" | "ADAPTER_FAILED";
    }>
  | Readonly<{ kind: "cancelled" }>;

export interface RuntimeProjectionCacheReaderPort {
  read(
    expectation: Extract<ProjectionExpectation, { kind: "active" }>,
    signal: AbortSignal,
  ): Promise<RuntimeProjectionCacheReadResult>;
}

export interface RuntimeProjectionCachePort extends RuntimeProjectionPort, RuntimeProjectionCacheReaderPort {}

export type RuntimeProjectionCacheEncoding = Readonly<{
  envelope: RuntimeProjectionCacheEnvelope;
  bytes: Uint8Array;
  payloadDigest: ContentDigest;
}>;

class CacheContractFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheContractFailure";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertSha256(sha256: Sha256): void {
  if (typeof sha256 !== "function") throw new TypeError("runtime projection cache requires SHA-256");
}

function payloadEntries(bytes: Uint8Array, sha256: Sha256): readonly [{
  readonly kind: "file";
  readonly path: string;
  readonly mode: 0o644;
  readonly size: number;
  readonly digest: ContentDigest;
}] {
  return [{
    kind: "file",
    path: RUNTIME_PROJECTION_CACHE_FILE,
    mode: 0o644,
    size: bytes.byteLength,
    digest: hashContent(bytes, sha256),
  }];
}

/** Hash the exact generated payload using the root-store's entry-list contract. */
export function hashRuntimeProjectionPayload(bytes: Uint8Array, sha256: Sha256): ContentDigest {
  assertSha256(sha256);
  if (!(bytes instanceof Uint8Array)) throw new TypeError("runtime projection cache payload must be bytes");
  return hashContent(
    new TextEncoder().encode(`${RUNTIME_PROJECTION_PAYLOAD_PREFIX}${JSON.stringify(payloadEntries(bytes, sha256))}`),
    sha256,
  );
}

function assertCanonicalComponentOrder(projection: PluginRuntimeProjection): void {
  for (const components of [projection.components.skills, projection.components.hooks, projection.components.mcpServers]) {
    let previous: string | undefined;
    for (const component of components) {
      ComponentIdSchema.parse(component.id);
      if (previous !== undefined && previous >= component.id) {
        throw new CacheContractFailure("runtime projection component order is not canonical");
      }
      previous = component.id;
    }
  }
}

function canonicalActiveExpectation(projection: PluginRuntimeProjection, sha256: Sha256): Extract<ProjectionExpectation, { kind: "active" }> {
  assertCanonicalComponentOrder(projection);
  try {
    return createActiveProjectionExpectation(projection, sha256);
  } catch {
    throw new CacheContractFailure("runtime projection identity is invalid");
  }
}

function assertExpectedProjection(
  projection: PluginRuntimeProjection,
  expectation: Extract<ProjectionExpectation, { kind: "active" }>,
  sha256: Sha256,
): Extract<ProjectionExpectation, { kind: "active" }> {
  const actualExpectation = canonicalActiveExpectation(projection, sha256);
  if (!sameJson(actualExpectation, expectation)) {
    throw new CacheContractFailure("runtime projection does not match its expected identity");
  }
  return actualExpectation;
}

/** Encode one complete projection. MCP fields are retained as opaque schema data. */
export function encodeRuntimeProjectionCache(
  projectionInput: PluginRuntimeProjection,
  sha256: Sha256,
): RuntimeProjectionCacheEncoding {
  assertSha256(sha256);
  const projection = PluginRuntimeProjectionSchemaV1.parse(projectionInput);
  const expectation = canonicalActiveExpectation(projection, sha256);
  const envelope = RuntimeProjectionCacheEnvelopeSchemaV1.parse({ cacheVersion: 1, projection });
  const bytes = canonicalBytes(envelope);
  if (bytes.byteLength > RUNTIME_PROJECTION_CACHE_MAX_BYTES) {
    throw new CacheContractFailure("runtime projection cache exceeds its size limit");
  }
  return Object.freeze({ envelope, bytes, payloadDigest: hashRuntimeProjectionPayload(bytes, sha256) });
}

/** Decode only canonical bytes and return a complete, independently bound value. */
export function decodeRuntimeProjectionCache(
  bytes: Uint8Array,
  expectation: Extract<ProjectionExpectation, { kind: "active" }>,
  sha256: Sha256,
): PreparedRuntimeProjection {
  assertSha256(sha256);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > RUNTIME_PROJECTION_CACHE_MAX_BYTES) {
    throw new CacheContractFailure("runtime projection cache bytes are invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CacheContractFailure("runtime projection cache encoding is invalid");
  }
  let parsed: RuntimeProjectionCacheEnvelope;
  try {
    parsed = RuntimeProjectionCacheEnvelopeSchemaV1.parse(JSON.parse(text));
  } catch {
    throw new CacheContractFailure("runtime projection cache document is invalid");
  }
  const canonical = canonicalBytes(parsed);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((byte, index) => byte === bytes[index])) {
    throw new CacheContractFailure("runtime projection cache bytes are not canonical");
  }
  const actualExpectation = assertExpectedProjection(parsed.projection, expectation, sha256);
  return Object.freeze({
    expectation: actualExpectation,
    projection: parsed.projection,
    payloadDigest: hashRuntimeProjectionPayload(bytes, sha256),
  });
}
