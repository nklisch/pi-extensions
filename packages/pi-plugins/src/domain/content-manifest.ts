import { z } from "zod";
import type { Sha256 } from "./source.js";

const encoder = new TextEncoder();
const ZERO_DIGEST = new Uint8Array(32);
const CONTENT_PREFIX = new Uint8Array([0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x2d, 0x76, 0x31, 0x00]);
const MAX_SAFE_UINT64 = BigInt(Number.MAX_SAFE_INTEGER);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Limits for the public manifest verifier. They protect callers even when a
 * manifest did not come from the filesystem writer. */
export const DEFAULT_CONTENT_MANIFEST_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxPathBytes: 1_024,
  maxSegmentBytes: 255,
  maxTotalPathBytes: 16 * 1024 * 1024,
});
export type ContentManifestLimits = Readonly<{
  [K in keyof typeof DEFAULT_CONTENT_MANIFEST_LIMITS]: number;
}>;

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

export const ContentDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .brand<"ContentDigest">();
export type ContentDigest = z.infer<typeof ContentDigestSchema>;

function invalidPath(path: string): boolean {
  if (path.length === 0 || path.includes("\\") || path.includes("\0")) return true;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return true;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return true;
  for (const segment of segments) {
    if ([...segment].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })) return true;
    if (segment.includes(":") || /[. ]$/.test(segment) || WINDOWS_DEVICE.test(segment)) return true;
    if (segment.toLowerCase() === ".git") return true;
  }
  return hasLoneSurrogate(path);
}

/**
 * Content paths are a format-level contract rather than a host path. Keeping
 * this check here lets manifest verification reject a forged tree without
 * importing a platform path module.
 */
export function normalizeContentPath(path: string): string {
  if (typeof path !== "string" || invalidPath(path)) {
    throw new TypeError("content path is not a safe relative path");
  }
  const normalized = path.normalize("NFC");
  // NFC normalization of an already-valid path can only merge code points;
  // it cannot introduce separators, dots, or control characters. Revalidate
  // only when normalization actually changed the string.
  if (normalized !== path && invalidPath(normalized)) {
    throw new TypeError("normalized content path is not safe");
  }
  return normalized;
}

function collisionKey(path: string): string {
  return normalizeContentPath(path).toLowerCase();
}

const ContentPathSchema = z.string().min(1).superRefine((value, context) => {
  try {
    if (normalizeContentPath(value) !== value) {
      context.addIssue({ code: "custom", message: "content path is not canonical" });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "content path is unsafe",
    });
  }
});

const ContentFileModeSchema = z.union([z.literal(0o644), z.literal(0o755)]);

export const ContentManifestEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("directory"),
    path: ContentPathSchema,
    mode: z.literal(0o755),
  }).strict().readonly(),
  z.object({
    kind: z.literal("file"),
    path: ContentPathSchema,
    mode: ContentFileModeSchema,
    size: z.number().int().nonnegative().safe(),
    digest: ContentDigestSchema,
  }).strict().readonly(),
  z.object({
    kind: z.literal("symlink"),
    path: ContentPathSchema,
    mode: z.literal(0o777),
    target: z.string().min(1).superRefine((value, context) => {
      if (hasLoneSurrogate(value) || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
        context.addIssue({ code: "custom", message: "symlink target is not a relative slash path" });
      }
      if ([...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20 || (character.codePointAt(0) ?? 0) === 0x7f)) {
        context.addIssue({ code: "custom", message: "symlink target contains a control character" });
      }
    }),
    digest: ContentDigestSchema,
  }).strict().readonly(),
]);
export type ContentManifestEntry = z.infer<typeof ContentManifestEntrySchema>;

function pathBytes(path: string): Uint8Array {
  return encoder.encode(normalizeContentPath(path));
}

function compareRawBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.byteLength - b.byteLength;
}

function compareEntries(left: ContentManifestEntry, right: ContentManifestEntry): number {
  // Schema refinements may invoke ordering while another entry is already
  // invalid. Compare raw NFC bytes here so safeParse reports issues instead of
  // leaking a path-normalization exception; create/verify validate first.
  return compareRawBytes(encoder.encode(left.path.normalize("NFC")), encoder.encode(right.path.normalize("NFC")));
}

function digestBytes(digest: ContentDigest): Uint8Array {
  const hex = digest.slice("sha256:".length);
  const result = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function assertDigest(digest: Uint8Array): void {
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new Error("SHA-256 function must return exactly 32 bytes");
  }
}

function formatDigest(digest: Uint8Array): ContentDigest {
  assertDigest(digest);
  let value = "sha256:";
  for (const byte of digest) value += byte.toString(16).padStart(2, "0");
  return ContentDigestSchema.parse(value);
}

export function hashContent(bytes: Uint8Array, sha256: Sha256): ContentDigest {
  if (typeof sha256 !== "function") throw new TypeError("hashContent requires a SHA-256 function");
  if (!(bytes instanceof Uint8Array)) throw new TypeError("hashContent requires bytes");
  return formatDigest(sha256(bytes));
}

/** Bind a verified source identity to the exact retained tree digest. */
export function createMaterializationBinding(
  sourceHash: string,
  contentRootDigest: ContentDigest,
  sha256: Sha256,
): ContentDigest {
  if (typeof sourceHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(sourceHash)) throw new TypeError("materialization source hash is invalid");
  ContentDigestSchema.parse(contentRootDigest);
  const preimage = encoder.encode(`materialization-v1\0${sourceHash.length}:${sourceHash}${contentRootDigest.length}:${contentRootDigest}`);
  return formatDigest(sha256(preimage));
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error("manifest field exceeds uint32");
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX_SAFE_UINT64) throw new Error("manifest size is not a safe uint64");
  let current = BigInt(value);
  const result = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    result[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return result;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function entryDigest(entry: ContentManifestEntry): Uint8Array {
  switch (entry.kind) {
    case "directory": return ZERO_DIGEST;
    case "file": return digestBytes(entry.digest);
    case "symlink": return digestBytes(entry.digest);
  }
}

function entryPreimage(entry: ContentManifestEntry, path: Uint8Array = pathBytes(entry.path)): Uint8Array {
  const size = entry.kind === "file" ? entry.size : 0;
  return concat([
    Uint8Array.from([entry.kind === "directory" ? 0x44 : entry.kind === "file" ? 0x46 : 0x4c]),
    u32(path.byteLength),
    path,
    u32(entry.mode),
    u64(size),
    entryDigest(entry),
  ]);
}

function manifestLimits(input?: Partial<ContentManifestLimits>): ContentManifestLimits {
  const limits = { ...DEFAULT_CONTENT_MANIFEST_LIMITS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`content manifest limit ${name} must be positive`);
  }
  return Object.freeze(limits);
}

/**
 * Apply cheap structural bounds before Zod constructs a full manifest tree.
 * This is intentionally a best-effort preflight: malformed entries still go
 * through the authoritative schema so callers receive the normal contract
 * error, while valid oversized input is rejected before digest work/allocation.
 */
function preflightManifestEntries(entries: readonly unknown[], limits: ContentManifestLimits): void {
  if (entries.length > limits.maxEntries) throw new Error("content manifest entry limit exceeded");
  let totalPathBytes = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const path = (entry as { readonly path?: unknown }).path;
    if (typeof path !== "string") continue;
    const pathLength = encoder.encode(path).byteLength;
    totalPathBytes += pathLength;
    if (totalPathBytes > limits.maxTotalPathBytes) throw new Error("content manifest aggregate path limit exceeded");
    if (pathLength > limits.maxPathBytes) throw new Error(`content manifest path length limit exceeded: ${path}`);
    for (const segment of path.split("/")) {
      if (encoder.encode(segment).byteLength > limits.maxSegmentBytes) {
        throw new Error(`content manifest path segment length limit exceeded: ${path}`);
      }
    }
  }
}

function preflightManifestInput(input: unknown, limits: ContentManifestLimits): void {
  if (input === null || typeof input !== "object") return;
  const entries = (input as { readonly entries?: unknown }).entries;
  if (Array.isArray(entries)) preflightManifestEntries(entries, limits);
}

/**
 * Structural checks over entries that already passed ContentManifestEntrySchema.
 * The schema's superRefine proves each path is canonical NFC, so re-normalizing
 * here would be pure waste: lowercase keys and ancestor prefixes are derived
 * directly from the canonical path. This loop dominates read-path latency for
 * large manifests and must stay allocation-lean.
 */
function checkParsedEntries(
  parsed: readonly ContentManifestEntry[],
  limits: ContentManifestLimits,
  sha256?: Sha256,
): void {
  const byPath = new Map<string, ContentManifestEntry>();
  let totalPathBytes = 0;
  for (const entry of parsed) {
    const pathLength = encoder.encode(entry.path).byteLength;
    totalPathBytes += pathLength;
    if (totalPathBytes > limits.maxTotalPathBytes) throw new Error("content manifest aggregate path limit exceeded");
    if (pathLength > limits.maxPathBytes) throw new Error(`content manifest path length limit exceeded: ${entry.path}`);
    for (const segment of entry.path.split("/")) {
      if (encoder.encode(segment).byteLength > limits.maxSegmentBytes) {
        throw new Error(`content manifest path segment length limit exceeded: ${entry.path}`);
      }
    }
    const key = entry.path.toLowerCase();
    if (byPath.has(key)) throw new Error(`content manifest path collision: ${entry.path}`);
    byPath.set(key, entry);
  }
  for (const entry of parsed) {
    let ancestor = entry.path;
    while (true) {
      const slash = ancestor.lastIndexOf("/");
      if (slash < 0) break;
      ancestor = ancestor.slice(0, slash);
      const ancestorEntry = byPath.get(ancestor.toLowerCase());
      if (ancestorEntry?.kind !== "directory") {
        throw new Error(`content manifest is missing directory ancestor: ${ancestor}`);
      }
    }
    if (entry.kind === "directory" && entry.mode !== 0o755) throw new Error("directory mode must be 0755");
    if (entry.kind === "symlink") {
      let link: Readonly<{ resolvedPath: string }>;
      try {
        link = normalizeContentLinkTarget(entry.path, entry.target);
      } catch (error) {
        throw new Error(`symlink target is unsafe: ${entry.path}`, { cause: error });
      }
      if (!byPath.has(link.resolvedPath.toLowerCase())) {
        throw new Error(`symlink target is not a retained entry: ${entry.path}`);
      }
      if (sha256 !== undefined && hashContent(encoder.encode(entry.target.normalize("NFC")), sha256) !== entry.digest) {
        throw new Error(`symlink digest does not match target: ${entry.path}`);
      }
    }
  }
}

function validateEntries(
  entries: readonly ContentManifestEntry[],
  sha256?: Sha256,
  inputLimits?: Partial<ContentManifestLimits>,
): ContentManifestEntry[] {
  const limits = manifestLimits(inputLimits);
  preflightManifestEntries(entries, limits);
  const parsed = entries.map((entry) => ContentManifestEntrySchema.parse(entry));
  checkParsedEntries(parsed, limits, sha256);
  return parsed;
}

function computeRootDigest(entries: readonly ContentManifestEntry[], sha256: Sha256): ContentDigest {
  // Encode each canonical path once: sort keys and preimages share the bytes.
  const encoded = entries.map((entry) => ({ entry, path: encoder.encode(entry.path) }));
  encoded.sort((left, right) => {
    const length = Math.min(left.path.byteLength, right.path.byteLength);
    for (let index = 0; index < length; index += 1) {
      const difference = (left.path[index] ?? 0) - (right.path[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return left.path.byteLength - right.path.byteLength;
  });
  const preimage = concat([CONTENT_PREFIX, ...encoded.map(({ entry, path }) => entryPreimage(entry, path))]);
  return formatDigest(sha256(preimage));
}

export const ContentManifestSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("sha256"),
  entries: z.array(ContentManifestEntrySchema).readonly(),
  rootDigest: ContentDigestSchema,
}).strict().readonly().superRefine((manifest, context) => {
  const seen = new Set<string>();
  let previousBytes: Uint8Array | undefined;
  for (const entry of manifest.entries) {
    let key: string;
    try { key = collisionKey(entry.path); } catch { key = entry.path; }
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["entries"], message: `duplicate or colliding path: ${entry.path}` });
    seen.add(key);
    const bytes = encoder.encode(entry.path.normalize("NFC"));
    if (previousBytes !== undefined && compareRawBytes(previousBytes, bytes) >= 0) {
      context.addIssue({ code: "custom", path: ["entries"], message: "manifest entries must be in unsigned UTF-8 path order" });
    }
    previousBytes = bytes;
  }
});
export type ContentManifest = z.infer<typeof ContentManifestSchema>;

export function createContentManifest(
  entries: readonly ContentManifestEntry[],
  sha256: Sha256,
  limits?: Partial<ContentManifestLimits>,
): ContentManifest {
  if (typeof sha256 !== "function") throw new TypeError("createContentManifest requires a SHA-256 function");
  const validated = validateEntries(entries, sha256, limits).sort(compareEntries);
  return ContentManifestSchema.parse({
    version: 1,
    algorithm: "sha256",
    entries: validated,
    rootDigest: computeRootDigest(validated, sha256),
  });
}

export function verifyContentManifest(
  input: unknown,
  sha256: Sha256,
  inputLimits?: Partial<ContentManifestLimits>,
): ContentManifest {
  if (typeof sha256 !== "function") throw new TypeError("verifyContentManifest requires a SHA-256 function");
  const limits = manifestLimits(inputLimits);
  preflightManifestInput(input, limits);
  const manifest = ContentManifestSchema.parse(input);
  // The schema parse already validated every entry; re-parsing them through
  // validateEntries would duplicate the entire refinement cost per read.
  checkParsedEntries(manifest.entries, limits, sha256);
  const expected = computeRootDigest(manifest.entries, sha256);
  if (manifest.rootDigest !== expected) throw new Error("content manifest root digest does not match entries");
  return manifest;
}

/** Used by the filesystem adapter to validate an archive or source link target. */
export function normalizeContentLinkTarget(path: string, target: string): Readonly<{ target: string; resolvedPath: string }> {
  if (typeof target !== "string" || target.length === 0 || hasLoneSurrogate(target) || target.includes("\\") || target.includes("\0") || target.startsWith("/") || /^[A-Za-z]:/.test(target)) {
    throw new TypeError("link target is not a safe relative path");
  }
  const normalizedTarget = target.normalize("NFC");
  const base = normalizeContentPath(path).split("/");
  base.pop();
  for (const segment of normalizedTarget.split("/")) {
    if (segment === "") throw new TypeError("link target contains an empty path segment");
    if (segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) throw new TypeError("link target escapes the content root");
      base.pop();
    } else {
      if ([...segment].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x20 || code === 0x7f;
      })) throw new TypeError("link target contains a control character");
      if (segment.includes(":") || /[. ]$/.test(segment) || WINDOWS_DEVICE.test(segment) || segment.toLowerCase() === ".git") {
        throw new TypeError("link target contains a platform-reserved segment");
      }
      base.push(segment);
    }
  }
  if (base.length === 0) throw new TypeError("link target must name a retained entry");
  const resolvedPath = normalizeContentPath(base.join("/"));
  return { target: normalizedTarget, resolvedPath };
}
