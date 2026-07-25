import { z } from "zod";
import { JsonValueSchema, type JsonValue } from "../schema.js";
import { PluginKeySchema, type PluginKey } from "../identity.js";
import { ContentDigestSchema, type ContentDigest } from "../content-manifest.js";
import { ScopeReferenceSchema, type ScopeReference } from "./scope.js";
import type { Sha256 } from "../source.js";

/**
 * All logical state references are opaque, versioned values. Keeping the tag
 * registry here prevents one family from accidentally accepting another
 * family's digest or inventing a second spelling of a reference kind.
 */
export const StateReferenceKindRegistry = {
  stateBlob: { tag: "state-blob-v1" },
  marketplaceContent: { tag: "marketplace-content-v1" },
  pluginContent: { tag: "plugin-content-v1" },
  pluginData: { tag: "plugin-data-v1" },
  pluginConfiguration: { tag: "plugin-configuration-v1" },
  trustSubject: { tag: "trust-subject-v1" },
  pendingTransition: { tag: "pending-transition-v1" },
  runtimeProjection: { tag: "runtime-projection-v1" },
} as const;

export type StateReferenceKind = keyof typeof StateReferenceKindRegistry;
export type StateReferenceTag =
  (typeof StateReferenceKindRegistry)[StateReferenceKind]["tag"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build one strict schema for one registry-owned versioned digest tag. */
export function taggedSha256<Brand extends string>(tag: string) {
  if (!/^[a-z][a-z0-9-]*-v[1-9][0-9]*$/.test(tag)) {
    throw new Error(`invalid versioned state reference tag: ${tag}`);
  }
  return z
    .string()
    .regex(new RegExp(`^${escapeRegExp(tag)}:sha256:[0-9a-f]{64}$`))
    .brand<Brand>();
}

export const StateBlobRefSchema = taggedSha256<"StateBlobRef">(
  StateReferenceKindRegistry.stateBlob.tag,
);
export type StateBlobRef = z.infer<typeof StateBlobRefSchema>;

export const MarketplaceContentRefSchema = taggedSha256<"MarketplaceContentRef">(
  StateReferenceKindRegistry.marketplaceContent.tag,
);
export type MarketplaceContentRef = z.infer<typeof MarketplaceContentRefSchema>;

export const PluginContentRefSchema = taggedSha256<"PluginContentRef">(
  StateReferenceKindRegistry.pluginContent.tag,
);
export type PluginContentRef = z.infer<typeof PluginContentRefSchema>;

export const PluginDataRefSchema = taggedSha256<"PluginDataRef">(
  StateReferenceKindRegistry.pluginData.tag,
);
export type PluginDataRef = z.infer<typeof PluginDataRefSchema>;

export const PluginConfigurationRefSchema = taggedSha256<"PluginConfigurationRef">(
  StateReferenceKindRegistry.pluginConfiguration.tag,
);
export type PluginConfigurationRef = z.infer<typeof PluginConfigurationRefSchema>;

export const TrustSubjectRefSchema = taggedSha256<"TrustSubjectRef">(
  StateReferenceKindRegistry.trustSubject.tag,
);
export type TrustSubjectRef = z.infer<typeof TrustSubjectRefSchema>;

export const PendingTransitionRefSchema = taggedSha256<"PendingTransitionRef">(
  StateReferenceKindRegistry.pendingTransition.tag,
);
export type PendingTransitionRef = z.infer<typeof PendingTransitionRefSchema>;

export const ProjectionRootRefSchema = taggedSha256<"ProjectionRootRef">(
  StateReferenceKindRegistry.runtimeProjection.tag,
);
export type ProjectionRootRef = z.infer<typeof ProjectionRootRefSchema>;

export const StateReferenceSchema = z.union([
  StateBlobRefSchema,
  MarketplaceContentRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
  PluginConfigurationRefSchema,
  TrustSubjectRefSchema,
  PendingTransitionRefSchema,
  ProjectionRootRefSchema,
]);
export type StateReference = z.infer<typeof StateReferenceSchema>;

export type ReferenceIdentity = JsonValue;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("reference identity field exceeds uint32 length");
  }
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function stringBytes(value: string): Uint8Array {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("reference identity strings cannot contain lone surrogates");
  }
  return new TextEncoder().encode(value);
}

function lengthPrefixed(value: string): Uint8Array {
  const bytes = stringBytes(value);
  return concat([u32(bytes.byteLength), bytes]);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = stringBytes(left);
  const rightBytes = stringBytes(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

/** Encode JSON values injectively and independently of object insertion order. */
function encodeIdentity(value: JsonValue): Uint8Array {
  if (value === null) return Uint8Array.of(0x00);
  if (typeof value === "boolean") return Uint8Array.of(0x01, value ? 0x01 : 0x00);
  if (typeof value === "number") return concat([Uint8Array.of(0x02), lengthPrefixed(value === 0 ? "0" : value.toString())]);
  if (typeof value === "string") return concat([Uint8Array.of(0x03), lengthPrefixed(value)]);
  if (Array.isArray(value)) {
    return concat([
      Uint8Array.of(0x04),
      u32(value.length),
      ...value.map(encodeIdentity),
    ]);
  }

  const objectValue = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(objectValue).sort(compareUtf8);
  return concat([
    Uint8Array.of(0x05),
    u32(keys.length),
    ...keys.flatMap((key) => [lengthPrefixed(key), encodeIdentity(objectValue[key]!)]),
  ]);
}

function assertSha256(sha256: Sha256, operation: string): void {
  if (typeof sha256 !== "function") throw new TypeError(`${operation} requires a SHA-256 function`);
}

function isWellFormedJsonValue(value: unknown): boolean {
  if (typeof value === "string") return !hasLoneSurrogate(value);
  if (Array.isArray(value)) return value.every(isWellFormedJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([key, entry]) =>
      !hasLoneSurrogate(key) && isWellFormedJsonValue(entry),
    );
  }
  return true;
}

export const ReferenceIdentitySchema = JsonValueSchema.pipe(
  z.custom<JsonValue>(isWellFormedJsonValue, {
    message: "reference identity strings cannot contain lone surrogates",
  }),
);

function deriveTaggedReference(
  tag: string,
  schema: z.ZodTypeAny,
  identity: unknown,
  sha256: Sha256,
  operation: string,
): string {
  const validIdentity = ReferenceIdentitySchema.parse(identity) as JsonValue;
  assertSha256(sha256, operation);
  const preimage = concat([
    stringBytes(`${tag}\0`),
    encodeIdentity(validIdentity),
  ]);
  const digest = sha256(preimage);
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new Error("SHA-256 function must return exactly 32 bytes");
  }
  let hexadecimal = "";
  for (const byte of digest) hexadecimal += byte.toString(16).padStart(2, "0");
  return schema.parse(`${tag}:sha256:${hexadecimal}`) as string;
}

export function deriveStateBlobRef(identity: ReferenceIdentity, sha256: Sha256): StateBlobRef {
  return deriveTaggedReference(StateReferenceKindRegistry.stateBlob.tag, StateBlobRefSchema, identity, sha256, "deriveStateBlobRef") as StateBlobRef;
}

export function deriveMarketplaceContentRef(identity: ReferenceIdentity, sha256: Sha256): MarketplaceContentRef {
  return deriveTaggedReference(StateReferenceKindRegistry.marketplaceContent.tag, MarketplaceContentRefSchema, identity, sha256, "deriveMarketplaceContentRef") as MarketplaceContentRef;
}

export function derivePluginContentRef(identity: ReferenceIdentity, sha256: Sha256): PluginContentRef {
  return deriveTaggedReference(StateReferenceKindRegistry.pluginContent.tag, PluginContentRefSchema, identity, sha256, "derivePluginContentRef") as PluginContentRef;
}

export function derivePluginDataRef(identity: ReferenceIdentity, sha256: Sha256): PluginDataRef {
  return deriveTaggedReference(StateReferenceKindRegistry.pluginData.tag, PluginDataRefSchema, identity, sha256, "derivePluginDataRef") as PluginDataRef;
}

export function derivePluginConfigurationRef(identity: ReferenceIdentity, sha256: Sha256): PluginConfigurationRef {
  return deriveTaggedReference(StateReferenceKindRegistry.pluginConfiguration.tag, PluginConfigurationRefSchema, identity, sha256, "derivePluginConfigurationRef") as PluginConfigurationRef;
}

export function deriveTrustSubjectRef(identity: ReferenceIdentity, sha256: Sha256): TrustSubjectRef {
  return deriveTaggedReference(StateReferenceKindRegistry.trustSubject.tag, TrustSubjectRefSchema, identity, sha256, "deriveTrustSubjectRef") as TrustSubjectRef;
}

export function derivePendingTransitionRef(identity: ReferenceIdentity, sha256: Sha256): PendingTransitionRef {
  return deriveTaggedReference(StateReferenceKindRegistry.pendingTransition.tag, PendingTransitionRefSchema, identity, sha256, "derivePendingTransitionRef") as PendingTransitionRef;
}

export function deriveProjectionRootRef(
  identity: Readonly<{ scope: ScopeReference; plugin: PluginKey; projectionDigest: ContentDigest }>,
  sha256: Sha256,
): ProjectionRootRef {
  const value = {
    scope: ScopeReferenceSchema.parse(identity.scope),
    plugin: PluginKeySchema.parse(identity.plugin),
    projectionDigest: ContentDigestSchema.parse(identity.projectionDigest),
  };
  return deriveTaggedReference(
    StateReferenceKindRegistry.runtimeProjection.tag,
    ProjectionRootRefSchema,
    value,
    sha256,
    "deriveProjectionRootRef",
  ) as ProjectionRootRef;
}

function verifyReference<T extends string>(
  schema: z.ZodType<T>,
  candidate: unknown,
  identity: ReferenceIdentity,
  sha256: Sha256,
  derive: (identity: ReferenceIdentity, sha256: Sha256) => T,
  message: string,
): T {
  const value = schema.parse(candidate);
  if (value !== derive(identity, sha256)) throw new Error(message);
  return value;
}

export function verifyStateBlobRef(candidate: unknown, identity: ReferenceIdentity, sha256: Sha256): StateBlobRef {
  return verifyReference(StateBlobRefSchema, candidate, identity, sha256, deriveStateBlobRef, "state blob reference does not match its identity") as StateBlobRef;
}

export function verifyMarketplaceContentRef(candidate: unknown, identity: ReferenceIdentity, sha256: Sha256): MarketplaceContentRef {
  return verifyReference(MarketplaceContentRefSchema, candidate, identity, sha256, deriveMarketplaceContentRef, "marketplace content reference does not match its identity") as MarketplaceContentRef;
}

export function verifyPluginContentRef(candidate: unknown, identity: ReferenceIdentity, sha256: Sha256): PluginContentRef {
  return verifyReference(PluginContentRefSchema, candidate, identity, sha256, derivePluginContentRef, "plugin content reference does not match its identity") as PluginContentRef;
}

export function verifyPluginDataRef(candidate: unknown, identity: ReferenceIdentity, sha256: Sha256): PluginDataRef {
  return verifyReference(PluginDataRefSchema, candidate, identity, sha256, derivePluginDataRef, "plugin data reference does not match its identity") as PluginDataRef;
}

export function verifyPluginConfigurationRef(candidate: unknown, identity: ReferenceIdentity, sha256: Sha256): PluginConfigurationRef {
  return verifyReference(PluginConfigurationRefSchema, candidate, identity, sha256, derivePluginConfigurationRef, "plugin configuration reference does not match its identity") as PluginConfigurationRef;
}

export function verifyTrustSubjectRef(candidate: unknown, identity: ReferenceIdentity, sha256: Sha256): TrustSubjectRef {
  return verifyReference(TrustSubjectRefSchema, candidate, identity, sha256, deriveTrustSubjectRef, "trust subject reference does not match its identity") as TrustSubjectRef;
}

export function verifyPendingTransitionRef(candidate: unknown, identity: ReferenceIdentity, sha256: Sha256): PendingTransitionRef {
  return verifyReference(PendingTransitionRefSchema, candidate, identity, sha256, derivePendingTransitionRef, "pending transition reference does not match its identity") as PendingTransitionRef;
}

export function verifyProjectionRootRef(
  candidate: unknown,
  identity: Readonly<{ scope: ScopeReference; plugin: PluginKey; projectionDigest: ContentDigest }>,
  sha256: Sha256,
): ProjectionRootRef {
  return verifyReference(
    ProjectionRootRefSchema,
    candidate,
    identity,
    sha256,
    (value, hash) => deriveProjectionRootRef(value as {
      scope: ScopeReference;
      plugin: PluginKey;
      projectionDigest: ContentDigest;
    }, hash),
    "projection root reference does not match its identity",
  ) as ProjectionRootRef;
}
