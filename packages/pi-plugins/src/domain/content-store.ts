import { z } from "zod";
import {
  ContentDigestSchema,
  createMaterializationBinding,
  verifyContentManifest,
  type ContentDigest,
  type ContentManifest,
} from "./content-manifest.js";
import {
  verifyResolvedMarketplaceSource,
  verifyResolvedPluginSource,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
  type Sha256,
  type SourceHash,
} from "./source.js";

/**
 * Physical store variants are a closed set. The tag is part of the key
 * preimage as well as its wire spelling, so a key cannot be reinterpreted by
 * another store adapter.
 */
export const ContentStoreKindRegistry = {
  marketplace: { tag: "marketplace-store-v1" },
  plugin: { tag: "plugin-store-v1" },
} as const;

export type ContentStoreKind = keyof typeof ContentStoreKindRegistry;

const StoreKeySchema = z.string().regex(/^[-a-z0-9]+-v[1-9][0-9]*:sha256:[0-9a-f]{64}$/).brand<"ContentStoreKey">();
export type ContentStoreKey = z.infer<typeof StoreKeySchema>;

export const MarketplaceStoreKeySchema = z
  .string()
  .regex(/^marketplace-store-v1:sha256:[0-9a-f]{64}$/)
  .brand<"MarketplaceStoreKey">();
export const PluginStoreKeySchema = z
  .string()
  .regex(/^plugin-store-v1:sha256:[0-9a-f]{64}$/)
  .brand<"PluginStoreKey">();

export const MarketplaceStoreIdentitySchema = z.object({
  kind: z.literal("marketplace"),
  sourceHash: z.custom<SourceHash>((value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  binding: ContentDigestSchema,
  key: MarketplaceStoreKeySchema,
}).strict().readonly();
export type MarketplaceStoreKey = z.infer<typeof MarketplaceStoreKeySchema>;
export type PluginStoreKey = z.infer<typeof PluginStoreKeySchema>;
export type MarketplaceStoreIdentity = z.infer<typeof MarketplaceStoreIdentitySchema>;

export const PluginStoreIdentitySchema = z.object({
  kind: z.literal("plugin"),
  sourceHash: z.custom<SourceHash>((value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)),
  binding: ContentDigestSchema,
  key: PluginStoreKeySchema,
}).strict().readonly();
export type PluginStoreIdentity = z.infer<typeof PluginStoreIdentitySchema>;

export const ContentStoreIdentitySchema = z.discriminatedUnion("kind", [
  MarketplaceStoreIdentitySchema,
  PluginStoreIdentitySchema,
]);
export type ContentStoreIdentity = z.infer<typeof ContentStoreIdentitySchema>;

const encoder = new TextEncoder();

function assertSha256(sha256: Sha256, operation: string): void {
  if (typeof sha256 !== "function") throw new TypeError(`${operation} requires a SHA-256 function`);
}

function lengthPrefixed(value: string): string {
  return `${encoder.encode(value).byteLength}:${value}`;
}

function digestHex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new Error("SHA-256 function must return exactly 32 bytes");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deriveStoreKey(
  tag: string,
  fields: readonly (readonly [string, string])[],
  sha256: Sha256,
): string {
  assertSha256(sha256, "deriveContentStoreKey");
  const preimage = [tag, ...fields.map(([name, value]) => `${name}=${lengthPrefixed(value)}`)].join("\0");
  return `${tag}:sha256:${digestHex(sha256(encoder.encode(preimage)))}`;
}

function verifyBinding(
  sourceHash: SourceHash,
  manifest: ContentManifest,
  binding: ContentDigest,
  sha256: Sha256,
): ContentManifest {
  const verifiedManifest = verifyContentManifest(manifest, sha256);
  const expected = createMaterializationBinding(sourceHash, verifiedManifest.rootDigest, sha256);
  if (binding !== expected) throw new Error("materialization binding does not match source and manifest");
  return verifiedManifest;
}

/** Derive the immutable marketplace revision identity from verified evidence. */
export function createMarketplaceStoreIdentity(
  source: ResolvedMarketplaceSource,
  manifest: ContentManifest,
  binding: ContentDigest,
  sha256: Sha256,
): MarketplaceStoreIdentity {
  const verifiedSource = verifyResolvedMarketplaceSource(source, sha256);
  const verifiedManifest = verifyBinding(verifiedSource.hash, manifest, binding, sha256);
  const key = deriveStoreKey(ContentStoreKindRegistry.marketplace.tag, [
    ["source-hash", verifiedSource.hash],
    ["revision", verifiedSource.revision],
    ["binding", binding],
  ], sha256);
  return MarketplaceStoreIdentitySchema.parse({
    kind: "marketplace",
    sourceHash: verifiedSource.hash,
    revision: verifiedSource.revision,
    binding: verifiedManifest.rootDigest === manifest.rootDigest ? binding : createMaterializationBinding(verifiedSource.hash, verifiedManifest.rootDigest, sha256),
    key,
  });
}

/** Reconstruct a marketplace locator from the safe fields retained in state. */
export function createMarketplaceStoreIdentityFromEvidence(
  evidence: Readonly<{ sourceHash: SourceHash; revision: string; binding: ContentDigest }>,
  sha256: Sha256,
): MarketplaceStoreIdentity {
  const sourceHash = z.custom<SourceHash>((value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)).parse(evidence.sourceHash);
  const revision = z.string().regex(/^[0-9a-f]{40}$/).parse(evidence.revision);
  const binding = ContentDigestSchema.parse(evidence.binding);
  const key = deriveStoreKey(ContentStoreKindRegistry.marketplace.tag, [
    ["source-hash", sourceHash],
    ["revision", revision],
    ["binding", binding],
  ], sha256);
  return MarketplaceStoreIdentitySchema.parse({ kind: "marketplace", sourceHash, revision, binding, key });
}

/** Reconstruct a plugin locator from the safe fields retained in state. */
export function createPluginStoreIdentityFromEvidence(
  evidence: Readonly<{ sourceHash: SourceHash; binding: ContentDigest }>,
  sha256: Sha256,
): PluginStoreIdentity {
  const sourceHash = z.custom<SourceHash>((value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)).parse(evidence.sourceHash);
  const binding = ContentDigestSchema.parse(evidence.binding);
  const key = deriveStoreKey(ContentStoreKindRegistry.plugin.tag, [
    ["source-hash", sourceHash],
    ["binding", binding],
  ], sha256);
  return PluginStoreIdentitySchema.parse({ kind: "plugin", sourceHash, binding, key });
}

/** Derive the immutable plugin revision identity from verified evidence. */
export function createPluginStoreIdentity(
  source: ResolvedPluginSource,
  manifest: ContentManifest,
  binding: ContentDigest,
  sha256: Sha256,
): PluginStoreIdentity {
  const verifiedSource = verifyResolvedPluginSource(source, sha256);
  verifyBinding(verifiedSource.hash, manifest, binding, sha256);
  const key = deriveStoreKey(ContentStoreKindRegistry.plugin.tag, [
    ["source-hash", verifiedSource.hash],
    ["binding", binding],
  ], sha256);
  return PluginStoreIdentitySchema.parse({
    kind: "plugin",
    sourceHash: verifiedSource.hash,
    binding,
    key,
  });
}

export function verifyContentStoreIdentity(
  candidate: unknown,
  source: ResolvedMarketplaceSource | ResolvedPluginSource,
  manifest: ContentManifest,
  binding: ContentDigest,
  sha256: Sha256,
): ContentStoreIdentity {
  const value = ContentStoreIdentitySchema.parse(candidate);
  if (value.kind === "marketplace" && !("declared" in source)) {
    throw new Error("marketplace identity requires resolved marketplace evidence");
  }
  if (value.kind === "plugin" && ("declared" in source)) {
    throw new Error("plugin identity requires resolved plugin evidence");
  }
  const expected = value.kind === "marketplace"
    ? createMarketplaceStoreIdentity(source as ResolvedMarketplaceSource, manifest, binding, sha256)
    : createPluginStoreIdentity(source as ResolvedPluginSource, manifest, binding, sha256);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("content store identity does not match verified source evidence");
  }
  return value;
}

/** Decode only a validated key into a path-safe lowercase digest segment. */
export function contentStoreKeyDigest(identity: ContentStoreIdentity): string {
  const value = ContentStoreIdentitySchema.parse(identity);
  const prefix = ContentStoreKindRegistry[value.kind].tag + ":sha256:";
  if (!value.key.startsWith(prefix)) throw new Error("content store key does not match its kind");
  return value.key.slice(prefix.length);
}

export function contentStoreKeySchema(kind: ContentStoreKind): z.ZodTypeAny {
  return kind === "marketplace"
    ? MarketplaceStoreKeySchema
    : PluginStoreKeySchema;
}

export { StoreKeySchema as ContentStoreKeySchema };
export type { SourceHash };
