import { z } from "zod";
import {
  ComponentIdSchema,
  ComponentKindRegistry,
  HookHandlerSchema,
  type ComponentId,
  type HookHandler,
} from "./components.js";
import { PluginKeySchema, type PluginKey } from "./identity.js";
import { NativeHostSchema, type NativeHost } from "./provenance.js";
import { type Sha256 } from "./source.js";

/**
 * Component identities are persisted in trust and installation state. A new
 * identity grammar therefore gets a new version instead of silently changing
 * the bytes hashed by an existing version.
 */
export const ComponentIdVersionRegistry = {
  v1: "component-v1",
} as const;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const identityString = z.string().superRefine((value, context) => {
  if (hasLoneSurrogate(value)) {
    context.addIssue({ code: "custom", message: "identity strings cannot contain lone surrogates" });
  }
});
const nonEmptyIdentityString = identityString.min(1);

const SkillLogicalIdentitySchema = z
  .object({
    kind: z.literal(ComponentKindRegistry.skill.tag),
    root: nonEmptyIdentityString,
  })
  .strict()
  .readonly();

const HookLogicalIdentitySchema = z
  .object({
    kind: z.literal(ComponentKindRegistry.hook.tag),
    event: nonEmptyIdentityString,
    matcher: identityString.optional(),
    handler: HookHandlerSchema,
  })
  .strict()
  .readonly();

const McpLogicalIdentitySchema = z
  .object({
    kind: z.literal(ComponentKindRegistry.mcpServer.tag),
    nativeKey: nonEmptyIdentityString,
  })
  .strict()
  .readonly();

const ForeignLogicalIdentitySchema = z
  .object({
    kind: z.literal(ComponentKindRegistry.foreign.tag),
    nativeHost: NativeHostSchema,
    nativeKind: nonEmptyIdentityString,
    declarationSubkey: nonEmptyIdentityString,
  })
  .strict()
  .readonly();

/** The stable logical keys from which component ids are derived. */
export const ComponentLogicalIdentitySchema = z.discriminatedUnion("kind", [
  SkillLogicalIdentitySchema,
  HookLogicalIdentitySchema,
  McpLogicalIdentitySchema,
  ForeignLogicalIdentitySchema,
]);
export type ComponentLogicalIdentity = z.infer<typeof ComponentLogicalIdentitySchema>;

const encoder = new TextEncoder();
const identityPrefix = encoder.encode(`${ComponentIdVersionRegistry.v1}\0`);
const MAX_UINT32 = 0xffff_ffff;

function assertSha256(sha256: Sha256): void {
  if (typeof sha256 !== "function") {
    throw new TypeError("deriveComponentId requires a SHA-256 function");
  }
}

function assertDigest(digest: Uint8Array): void {
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new Error("SHA-256 function must return exactly 32 bytes");
  }
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error("component identity field exceeds uint32 length");
  }
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((length, part) => length + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Encode one Unicode string by its UTF-8 byte length, not UTF-16 length. */
function field(value: string): Uint8Array {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("component identity strings cannot contain lone surrogates");
  }
  const bytes = encoder.encode(value);
  return concat([u32(bytes.byteLength), bytes]);
}

function optionalField(value: string | undefined): Uint8Array {
  return value === undefined
    ? Uint8Array.of(0)
    : concat([Uint8Array.of(1), field(value)]);
}

function handlerFields(handler: HookHandler): Uint8Array {
  switch (handler.kind) {
    case "shell":
      return concat([
        field(handler.kind),
        field(handler.command),
        ...(handler.shell === undefined ? [] : [field("shell"), field(handler.shell)]),
        optionalNumber(handler.timeoutMs),
      ]);
    case "exec":
      return concat([
        field(handler.kind),
        field(handler.command),
        u32(handler.args.length),
        ...handler.args.map(field),
        optionalNumber(handler.timeoutMs),
      ]);
  }
}

function optionalNumber(value: number | undefined): Uint8Array {
  if (value === undefined) return Uint8Array.of(0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("component identity numeric field must be a non-negative safe integer");
  }
  const bytes = new Uint8Array(8);
  let remaining = BigInt(value);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return concat([Uint8Array.of(1), bytes]);
}

/**
 * Build the injective v1 preimage. The prefix is versioned and NUL terminated;
 * every subsequent string is length-prefixed in UTF-8. Optional hook matchers
 * and timeouts carry an explicit presence byte so absent and empty/zero values
 * cannot collide.
 */
function identityPreimage(plugin: PluginKey, identity: ComponentLogicalIdentity): Uint8Array {
  const common = [identityPrefix, field(plugin), field(identity.kind)] as Uint8Array[];

  switch (identity.kind) {
    case "skill":
      return concat([...common, field(identity.root)]);
    case "hook":
      return concat([
        ...common,
        field(identity.event),
        optionalField(identity.matcher),
        handlerFields(identity.handler),
      ]);
    case "mcp-server":
      return concat([...common, field(identity.nativeKey)]);
    case "foreign":
      return concat([
        ...common,
        field(identity.nativeHost),
        field(identity.nativeKind),
        field(identity.declarationSubkey),
      ]);
  }
}

function formatDigest(digest: Uint8Array, kind: ComponentLogicalIdentity["kind"]): ComponentId {
  assertDigest(digest);
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return ComponentIdSchema.parse(`${ComponentIdVersionRegistry.v1}:${kind}:${hex}`);
}

/** Derive the persisted id for one validated logical component identity. */
export function deriveComponentId(
  plugin: PluginKey,
  identity: ComponentLogicalIdentity,
  sha256: Sha256,
): ComponentId {
  const validPlugin = PluginKeySchema.parse(plugin);
  const validIdentity = ComponentLogicalIdentitySchema.parse(identity);
  assertSha256(sha256);
  return formatDigest(sha256(identityPreimage(validPlugin, validIdentity)), validIdentity.kind);
}

/** Verify a persisted id against the current versioned logical identity. */
export function verifyComponentId(
  value: unknown,
  plugin: PluginKey,
  identity: ComponentLogicalIdentity,
  sha256: Sha256,
): ComponentId {
  const candidate = ComponentIdSchema.parse(value);
  const expected = deriveComponentId(plugin, identity, sha256);
  if (candidate !== expected) {
    throw new Error("component id does not match its logical identity");
  }
  return candidate;
}

export type { NativeHost };
