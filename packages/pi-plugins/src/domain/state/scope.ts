import { z } from "zod";
import {
  SourceHashSchema,
  type Sha256,
  type SourceHash,
} from "../source.js";

const encoder = new TextEncoder();
const PROJECT_KEY_PREFIX = "project-v1:sha256:";
const PROJECT_IDENTITY_TAG = "project-identity-v1\0";
const MAX_UINT32 = 0xffff_ffff;

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

function addIssue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}

function hasMalformedPercentEscape(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") continue;
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) return true;
    index += 2;
  }
  return false;
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function validateCanonicalProjectRoot(value: string, context: z.RefinementCtx): void {
  if (hasLoneSurrogate(value)) {
    addIssue(context, "canonical project root cannot contain lone UTF-16 surrogate code units");
    return;
  }
  if (value.includes("\\") || value.includes("\0")) {
    addIssue(context, "canonical project root must use a file URL without backslashes or NUL");
  }
  if (hasMalformedPercentEscape(value)) {
    addIssue(context, "canonical project root contains a malformed percent escape");
    return;
  }
  if (!value.startsWith("file://")) {
    addIssue(context, "canonical project root must use the file: URL scheme");
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    addIssue(context, "canonical project root must be a valid file URL");
    return;
  }

  if (parsed.protocol !== "file:") {
    addIssue(context, "canonical project root must use the file: URL scheme");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    addIssue(context, "canonical project root cannot contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    addIssue(context, "canonical project root cannot contain a query or fragment");
  }
  // The adapter hands this contract an already-canonical URL. Reject URL
  // spellings that the platform parser would normalize rather than silently
  // allowing two spellings to become one project identity.
  if (parsed.href !== value) {
    addIssue(context, "canonical project root must use canonical file URL spelling");
  }

  const pathStart = value.indexOf("/", "file://".length);
  const rawPath = pathStart === -1 ? "" : value.slice(pathStart);
  if (rawPath.length === 0) {
    addIssue(context, "canonical project root file URL must contain a path");
    return;
  }
  if (!rawPath.startsWith("/")) {
    addIssue(context, "canonical project root file URL path must be absolute");
    return;
  }

  const rawSegments = rawPath.split("/");
  const lastSegment = rawSegments.at(-1);
  for (const [index, rawSegment] of rawSegments.entries()) {
    // The first item is the path's required leading slash. A final empty
    // segment is the conventional directory-root slash and is allowed.
    if (rawSegment.length === 0 && (index === 0 || index === rawSegments.length - 1)) {
      continue;
    }
    if (rawSegment.length === 0) {
      addIssue(context, "canonical project root cannot contain empty path segments");
      continue;
    }
    const decoded = decodePathSegment(rawSegment);
    if (decoded === undefined) {
      addIssue(context, "canonical project root contains an invalid percent escape");
      continue;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      [...decoded].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
      })
    ) {
      addIssue(context, "canonical project root contains an unsafe path segment");
    }
  }
  if (lastSegment === undefined) {
    addIssue(context, "canonical project root file URL must contain a path");
  }
}

/** An adapter-canonical, absolute file URL. It is never persisted in ScopeReference. */
export const CanonicalProjectRootSchema = z
  .string()
  .url()
  .superRefine(validateCanonicalProjectRoot)
  .brand<"CanonicalProjectRoot">();
export type CanonicalProjectRoot = z.infer<typeof CanonicalProjectRootSchema>;

export const ProjectIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository"),
      canonicalRoot: CanonicalProjectRootSchema,
      repositoryFingerprint: SourceHashSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("path-only"),
      canonicalRoot: CanonicalProjectRootSchema,
      limitation: z.literal("identity-changes-with-canonical-root"),
    })
    .strict()
    .readonly(),
]);
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

export const ProjectKeySchema = z
  .string()
  .regex(/^project-v1:sha256:[0-9a-f]{64}$/)
  .brand<"ProjectKey">();
export type ProjectKey = z.infer<typeof ProjectKeySchema>;

export const ScopeReferenceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("user") }).strict().readonly(),
    z
      .object({ kind: z.literal("project"), projectKey: ProjectKeySchema })
      .strict()
      .readonly(),
  ]);
export type ScopeReference = z.infer<typeof ScopeReferenceSchema>;

export const ScopeContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict().readonly(),
  z
    .object({
      kind: z.literal("project"),
      identity: ProjectIdentitySchema,
      projectKey: ProjectKeySchema,
    })
    .strict()
    .readonly(),
]);
export type ScopeContext = z.infer<typeof ScopeContextSchema>;

/** Scope contexts are verified by identity/key recomputation before they cross into application code. */
const verifiedScopeContexts = new WeakSet<object>();

function assertSha256(sha256: Sha256, operation: string): void {
  if (typeof sha256 !== "function") {
    throw new TypeError(`${operation} requires a SHA-256 function`);
  }
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error("project identity field exceeds uint32 length");
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

function field(tag: string, value: string): Uint8Array {
  if (hasLoneSurrogate(tag) || hasLoneSurrogate(value)) {
    throw new TypeError("project identity fields cannot contain lone surrogates");
  }
  const tagBytes = encoder.encode(tag);
  const valueBytes = encoder.encode(value);
  return concat([u32(tagBytes.byteLength), tagBytes, u32(valueBytes.byteLength), valueBytes]);
}

function projectIdentityPreimage(identity: ProjectIdentity): Uint8Array {
  const common = [
    encoder.encode(PROJECT_IDENTITY_TAG),
    field("kind", identity.kind),
    field("canonical-root", identity.canonicalRoot),
  ];
  if (identity.kind === "repository") {
    return concat([...common, field("repository-fingerprint", identity.repositoryFingerprint)]);
  }
  return concat([...common, field("limitation", identity.limitation)]);
}

function formatProjectKey(digest: Uint8Array): ProjectKey {
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new Error("SHA-256 function must return exactly 32 bytes");
  }
  let hexadecimal = "";
  for (const byte of digest) hexadecimal += byte.toString(16).padStart(2, "0");
  return ProjectKeySchema.parse(`${PROJECT_KEY_PREFIX}${hexadecimal}`);
}

/** Derive a root- and repository-bound project key from an injected hash port. */
export function deriveProjectKey(identity: ProjectIdentity, sha256: Sha256): ProjectKey {
  const value = ProjectIdentitySchema.parse(identity);
  assertSha256(sha256, "deriveProjectKey");
  return formatProjectKey(sha256(projectIdentityPreimage(value)));
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * Validate an untrusted context and recompute its project key before exposing
 * it to state code. User context has no identity/key and therefore needs no
 * hash port; project context always proves its supplied key.
 */
export function createScopeContext(input: unknown, sha256: Sha256): ScopeContext {
  const value = ScopeContextSchema.parse(input);
  if (value.kind === "user") {
    verifiedScopeContexts.add(value);
    return value;
  }
  const expected = deriveProjectKey(value.identity, sha256);
  if (!constantTimeEqual(value.projectKey, expected)) {
    throw new Error("project key does not match project identity");
  }
  verifiedScopeContexts.add(value);
  return value;
}

/** True only for a scope object produced by the hash-verifying factory. */
export function isVerifiedScopeContext(value: unknown): value is ScopeContext {
  return typeof value === "object" && value !== null && verifiedScopeContexts.has(value);
}

/** Reduce a runtime context to the path-free reference persisted in records. */
export function toScopeReference(context: ScopeContext): ScopeReference {
  const value = ScopeContextSchema.parse(context);
  return value.kind === "user"
    ? { kind: "user" }
    : ScopeReferenceSchema.parse({ kind: "project", projectKey: value.projectKey });
}

export type { SourceHash };
