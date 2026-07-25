import { z } from "zod";
import { schemaValues } from "./schema.js";

/** A registry entry owns both the display metadata and its runtime schema. */
type SourceVariantRegistry = Record<
  string,
  { readonly label: string; readonly schema: z.ZodTypeAny }
>;

type RegistrySchemas<T extends SourceVariantRegistry> = {
  [K in keyof T]: T[K]["schema"];
};

function schemasFor<T extends SourceVariantRegistry>(
  registry: T,
): [T[keyof T]["schema"], ...T[keyof T]["schema"][]] {
  const schemas = Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [key, entry.schema]),
  ) as RegistrySchemas<T>;
  return schemaValues(schemas);
}

const HexByte = /^[0-9A-Fa-f]{2}$/;
const CanonicalSourceKinds = new Set([
  "github",
  "git",
  "local-git",
  "marketplace-path",
  "git-subdir",
  "npm",
]);
const ScpGitUrl = /^(?:(?<user>[A-Za-z0-9._-]+)@)?(?<host>[A-Za-z0-9.-]+):(?<path>[^/\\\s:][^\s]*)$/;
const CanonicalScpGitUrl = /^scp:\/\/(?:(?<user>[A-Za-z0-9._-]+)@)?(?<host>[A-Za-z0-9.-]+)\/(?<path>[^/\\\s:][^\s]*)$/;
const GitHubOwner = /^(?=.{1,39}$)(?!-)(?!.*--)[A-Za-z0-9-]+(?<!-)$/;
const GitHubRepositoryName = /^(?=.{1,100}$)(?!\.{1,2}$)(?!.*\.$)[A-Za-z0-9._-]+$/;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function issue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}

function rejectLoneSurrogates(value: string, context: z.RefinementCtx): void {
  if (hasLoneSurrogate(value)) {
    issue(context, "source strings cannot contain lone UTF-16 surrogate code units");
  }
}

const SourceStringSchema = z.string().superRefine(rejectLoneSurrogates);
const NonEmptySourceStringSchema = SourceStringSchema.min(1);

/**
 * Validate GitHub's shorthand grammar without turning source validation into a
 * network lookup. Repository names may begin with a dot (for example,
 * `.github`), but `.` and `..` are path segments rather than repository names.
 */
export function isValidGitHubRepository(value: string): boolean {
  const slash = value.indexOf("/");
  if (slash <= 0 || value.indexOf("/", slash + 1) !== -1) {
    return false;
  }
  const owner = value.slice(0, slash);
  const repository = value.slice(slash + 1);
  return GitHubOwner.test(owner) &&
    GitHubRepositoryName.test(repository) &&
    !repository.toLowerCase().endsWith(".git");
}

const GitHubRepositorySchema = SourceStringSchema.refine(
  isValidGitHubRepository,
  "GitHub repository must be exactly owner/repository with valid GitHub names",
);

function hasValidPercentEscapes(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") {
      continue;
    }
    const escape = value.slice(index + 1, index + 3);
    if (!HexByte.test(escape)) {
      return false;
    }
    index += 2;
  }
  return true;
}

function isScpGitUrl(value: string): boolean {
  const match = ScpGitUrl.exec(value);
  if (match === null) {
    return false;
  }
  const host = match.groups?.host ?? "";
  // Require the conventional user@host form or a host-like name. This keeps
  // data:text/... and other URI schemes from being mistaken for SCP syntax.
  return match.groups?.user !== undefined || host.includes(".") || host === "localhost";
}

function validateGitUrl(value: string, context: z.RefinementCtx): void {
  // SCP is not a URI: its path is remote-home-relative and `%` is literal
  // path text, so URL percent-escape validation must not rewrite its meaning.
  if (isScpGitUrl(value)) {
    return;
  }

  if (!hasValidPercentEscapes(value)) {
    issue(context, "Git URL contains a malformed percent escape");
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issue(context, "Git URL must be an HTTPS or SSH URL");
    return;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    issue(context, "Git URL protocol must be HTTPS or SSH");
  }
  if (parsed.hostname.length === 0) {
    issue(context, "Git URL must contain a host");
  }
  if (parsed.protocol === "https:" && (parsed.username !== "" || parsed.password !== "")) {
    issue(context, "HTTPS Git URLs cannot contain embedded credentials");
  }
  if (parsed.protocol === "ssh:" && parsed.password !== "") {
    issue(context, "SSH Git URLs cannot contain embedded passwords");
  }
}

const GitUrlSchema = NonEmptySourceStringSchema.superRefine(validateGitUrl);

function validateNpmRegistry(value: string, context: z.RefinementCtx): void {
  if (!hasValidPercentEscapes(value)) {
    issue(context, "npm registry contains a malformed percent escape");
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issue(context, "npm registry must be an HTTPS URL");
    return;
  }

  if (parsed.protocol !== "https:") {
    issue(context, "npm registry must use HTTPS");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    issue(context, "npm registry cannot contain embedded credentials");
  }
}

const NpmRegistrySchema = NonEmptySourceStringSchema.url().superRefine(validateNpmRegistry);
const GitRevisionInputSchema = NonEmptySourceStringSchema
  .regex(/^[0-9a-f]{40}$/, "Git revision must be a full 40-character lowercase SHA-1")
  .brand<"GitRevision">();

export const MarketplaceSourceVariantRegistry = {
  github: {
    label: "GitHub repository",
    schema: z
      .object({
        kind: z.literal("github"),
        repository: GitHubRepositorySchema,
        ref: NonEmptySourceStringSchema.optional(),
      })
      .strict(),
  },
  git: {
    label: "Git repository",
    schema: z
      .object({
        kind: z.literal("git"),
        url: GitUrlSchema,
        ref: NonEmptySourceStringSchema.optional(),
      })
      .strict(),
  },
  localGit: {
    label: "Local Git checkout",
    schema: z
      .object({
        kind: z.literal("local-git"),
        path: NonEmptySourceStringSchema,
        ref: NonEmptySourceStringSchema.optional(),
      })
      .strict(),
  },
} as const;

export const MarketplaceSourceSchema = z.discriminatedUnion(
  "kind",
  schemasFor(MarketplaceSourceVariantRegistry),
);
export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;

export const PluginSourceVariantRegistry = {
  marketplacePath: {
    label: "Marketplace path",
    schema: z
      .object({
        kind: z.literal("marketplace-path"),
        path: NonEmptySourceStringSchema,
      })
      .strict(),
  },
  git: {
    label: "Git repository",
    schema: z
      .object({
        kind: z.literal("git"),
        url: GitUrlSchema,
        ref: NonEmptySourceStringSchema.optional(),
        sha: GitRevisionInputSchema.optional(),
      })
      .strict(),
  },
  gitSubdir: {
    label: "Git repository subdirectory",
    schema: z
      .object({
        kind: z.literal("git-subdir"),
        url: GitUrlSchema,
        path: NonEmptySourceStringSchema,
        ref: NonEmptySourceStringSchema.optional(),
        sha: GitRevisionInputSchema.optional(),
      })
      .strict(),
  },
  npm: {
    label: "npm package",
    schema: z
      .object({
        kind: z.literal("npm"),
        package: NonEmptySourceStringSchema,
        selector: NonEmptySourceStringSchema.optional(),
        registry: NpmRegistrySchema.optional(),
      })
      .strict(),
  },
} as const;

export const PluginSourceSchema = z.discriminatedUnion(
  "kind",
  schemasFor(PluginSourceVariantRegistry),
);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

export const GitRevisionSchema = GitRevisionInputSchema;

/**
 * Git declarations have one selector authority: an explicit SHA, then a
 * SHA-shaped ref, then the immutable revision resolved from a named ref.
 * Keeping this predicate in the source domain prevents acquisition and
 * inspection from developing different handoff rules.
 */
export function isFullGitRevision(value: unknown): value is GitRevision {
  return GitRevisionSchema.safeParse(value).success;
}

export function matchesGitRevisionSelector(
  declared: Readonly<{ readonly ref?: string | undefined; readonly sha?: string | undefined }>,
  revision: string,
): boolean {
  if (declared.sha !== undefined) return revision === declared.sha;
  if (declared.ref !== undefined && isFullGitRevision(declared.ref)) return revision === declared.ref;
  return true;
}

export const NpmIntegritySchema = SourceStringSchema
  // A SHA-512 digest is exactly 64 bytes, represented by 86 data characters
  // and two padding characters. The final data character also has only two
  // meaningful bits; rejecting non-canonical pad bits avoids alternate text
  // encodings of the same digest.
  .regex(/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/, "SHA-512 integrity must be a canonical 64-byte base64 digest")
  .brand<"NpmIntegrity">();
export type GitRevision = z.infer<typeof GitRevisionSchema>;
export type NpmIntegrity = z.infer<typeof NpmIntegritySchema>;

function readUtf8Value(
  input: string,
  start: number,
  byteLength: number,
): { readonly value: string; readonly next: number } | undefined {
  let next = start;
  let consumed = 0;
  while (next < input.length && consumed < byteLength) {
    const codePoint = input.codePointAt(next);
    if (codePoint === undefined) {
      return undefined;
    }
    const character = String.fromCodePoint(codePoint);
    consumed += new TextEncoder().encode(character).byteLength;
    next += character.length;
    if (consumed > byteLength) {
      return undefined;
    }
  }
  return consumed === byteLength
    ? { value: input.slice(start, next), next }
    : undefined;
}

const CanonicalFieldSignatures: Record<
  string,
  readonly (readonly string[])[]
> = {
  github: [["repository"], ["repository", "ref"], ["repository", "revision"]],
  git: [
    ["url"],
    ["url", "ref"],
    ["url", "sha"],
    ["url", "ref", "sha"],
    ["url", "revision"],
  ],
  "local-git": [["path"], ["path", "ref"], ["path", "revision"]],
  "marketplace-path": [["path"], ["path", "marketplaceRevision"]],
  "git-subdir": [
    ["url", "path"],
    ["url", "path", "ref"],
    ["url", "path", "sha"],
    ["url", "path", "ref", "sha"],
    ["url", "path", "revision"],
  ],
  npm: [
    ["package"],
    ["package", "selector"],
    ["package", "registry"],
    ["package", "selector", "registry"],
    ["package", "version", "integrity", "registry"],
  ],
};

type ParsedCanonicalField = readonly [name: string, value: string];

function canonicalSignatureIsAllowed(
  kind: string,
  fields: readonly ParsedCanonicalField[],
): boolean {
  return (CanonicalFieldSignatures[kind] ?? []).some((signature) =>
    signature.length === fields.length &&
    signature.every((name, index) => name === fields[index]?.[0])
  );
}

function isCanonicalFieldValue(
  kind: string,
  name: string,
  value: string,
): boolean {
  if (hasLoneSurrogate(value)) {
    return false;
  }

  switch (name) {
    case "url":
      return kind === "git" || kind === "git-subdir"
        ? isCanonicalGitUrl(value)
        : false;
    case "registry":
      return kind === "npm" && isCanonicalNpmRegistry(value);
    case "path":
      return isCanonicalEncodedPath(value);
    case "repository":
      return GitHubRepositorySchema.safeParse(value).success;
    case "sha":
    case "revision":
    case "marketplaceRevision":
      return GitRevisionInputSchema.safeParse(value).success;
    case "integrity":
      return NpmIntegritySchema.safeParse(value).success;
    case "ref":
    case "selector":
    case "package":
    case "version":
      return NonEmptySourceStringSchema.safeParse(value).success;
    default:
      return false;
  }
}

function parseCanonicalSource(value: string): boolean {
  if (!value.startsWith("source-v1|") || hasLoneSurrogate(value)) {
    return false;
  }

  const kindStart = "source-v1|".length;
  const kindEnd = value.indexOf("|", kindStart);
  if (kindEnd === -1) {
    return false;
  }
  const kind = value.slice(kindStart, kindEnd);
  if (!/^[a-z][a-z0-9-]*$/.test(kind) || !CanonicalSourceKinds.has(kind)) {
    return false;
  }

  let cursor = kindEnd + 1;
  const fieldNames = new Set<string>();
  const fields: ParsedCanonicalField[] = [];
  while (cursor < value.length) {
    const nameEnd = value.indexOf(":", cursor);
    if (nameEnd === -1 || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(value.slice(cursor, nameEnd))) {
      return false;
    }
    const fieldName = value.slice(cursor, nameEnd);
    if (fieldNames.has(fieldName)) {
      return false;
    }
    fieldNames.add(fieldName);

    const lengthStart = nameEnd + 1;
    const lengthEnd = value.indexOf(":", lengthStart);
    const lengthText = lengthEnd === -1
      ? ""
      : value.slice(lengthStart, lengthEnd);
    if (lengthEnd === -1 || !/^[1-9]\d*$/.test(lengthText)) {
      return false;
    }
    const byteLength = Number(lengthText);
    if (!Number.isSafeInteger(byteLength)) {
      return false;
    }

    const parsed = readUtf8Value(value, lengthEnd + 1, byteLength);
    if (parsed === undefined || parsed.value.length === 0) {
      return false;
    }
    fields.push([fieldName, parsed.value]);
    cursor = parsed.next;
    if (cursor === value.length) {
      break;
    }
    if (value[cursor] !== "|") {
      return false;
    }
    cursor += 1;
    if (cursor === value.length) {
      return false;
    }
  }

  return fields.length > 0 &&
    canonicalSignatureIsAllowed(kind, fields) &&
    fields.every(([name, fieldValue]) => isCanonicalFieldValue(kind, name, fieldValue));
}

export const CanonicalSourceSchema = z
  .string()
  .refine(parseCanonicalSource, "canonical source has an invalid source-v1 encoding")
  .brand<"CanonicalSource">();
export const SourceHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .brand<"SourceHash">();
export type CanonicalSource = z.infer<typeof CanonicalSourceSchema>;
export type SourceHash = z.infer<typeof SourceHashSchema>;

function isCanonicalScpUrl(value: string): boolean {
  const match = CanonicalScpGitUrl.exec(value);
  if (match === null) {
    return false;
  }
  const host = match.groups?.host ?? "";
  // Mirror declared SCP eligibility exactly: a user-qualified host, a
  // DNS-like host, or localhost. Canonical validation must not admit values
  // that no accepted declaration can produce.
  return match.groups?.user !== undefined || host.includes(".") || host === "localhost";
}

function normalizeScpUrl(value: string): string {
  const match = ScpGitUrl.exec(value);
  if (match !== null && isScpGitUrl(value)) {
    const user = match.groups?.user;
    const prefix = user === undefined ? "" : `${user}@`;
    return `scp://${prefix}${(match.groups?.host ?? "").toLowerCase()}/${match.groups?.path ?? ""}`;
  }

  const canonicalMatch = CanonicalScpGitUrl.exec(value);
  if (canonicalMatch !== null) {
    const user = canonicalMatch.groups?.user;
    const prefix = user === undefined ? "" : `${user}@`;
    return `scp://${prefix}${(canonicalMatch.groups?.host ?? "").toLowerCase()}/${canonicalMatch.groups?.path ?? ""}`;
  }

  return value;
}

function decodeUrlSegment(value: string): string {
  // Validation happens before URL normalization. Do not fall back to treating
  // malformed percent escapes as literals: `%zz` and `%25zz` would otherwise
  // become the same canonical path bytes.
  if (!hasValidPercentEscapes(value)) {
    throw new TypeError("URL contains a malformed percent escape");
  }
  const decoded = decodeURIComponent(value);
  if (hasLoneSurrogate(decoded)) {
    throw new TypeError("URL contains a lone UTF-16 surrogate code unit");
  }
  return decoded;
}

const encoder = new TextEncoder();
const hex = "0123456789ABCDEF";

function assertWellFormedUtf16(value: string): void {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("source canonicalization cannot encode a lone UTF-16 surrogate code unit");
  }
}

function utf8ByteLength(value: string): number {
  assertWellFormedUtf16(value);
  return encoder.encode(value).byteLength;
}

function encodePathSegment(value: string): string {
  let encoded = "";
  for (const byte of encoder.encode(value)) {
    // RFC 3986 unreserved bytes are safe inside a path segment. Encoding all
    // other bytes avoids delimiter aliases and gives one representation for
    // Unicode and punctuation in declared paths.
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e
    ) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${hex[byte >> 4]}${hex[byte & 0x0f]}`;
    }
  }
  return encoded;
}

function encodePath(value: string): string {
  assertWellFormedUtf16(value);
  return value.split("/").map(encodePathSegment).join("/");
}

function encodeUrlPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodePathSegment(decodeUrlSegment(segment)))
    .join("/");
}

/**
 * Normalize only URL syntax that is safe at this contract boundary. URL does
 * not resolve redirects, refs, filesystem paths, symlinks, or semver; those
 * are acquisition concerns. The authority is rebuilt because URL does not
 * lowercase hosts consistently for every scheme (notably SSH).
 */
function normalizeUrl(value: string): string {
  assertWellFormedUtf16(value);
  if (isScpGitUrl(value) || isCanonicalScpUrl(value)) {
    return normalizeScpUrl(value);
  }
  if (!hasValidPercentEscapes(value)) {
    throw new TypeError("URL contains a malformed percent escape");
  }
  const parsed = new URL(value);
  const suffix = `${parsed.search}${parsed.hash}`;
  const hierarchicalPrefix = `${parsed.protocol.toLowerCase()}//`;
  const credentials = parsed.username
    ? `${parsed.username}@`
    : "";
  // WHATWG URL strips known defaults such as HTTPS 443 but does not know
  // SSH's conventional port. Normalize it explicitly so equivalent Git
  // remotes do not fragment cache and trust identities.
  const port = parsed.protocol === "ssh:" && parsed.port === "22"
    ? ""
    : parsed.port
      ? `:${parsed.port}`
      : "";
  const authority = `${hierarchicalPrefix}${credentials}${parsed.hostname.toLowerCase()}${port}`;
  return `${authority}${encodeUrlPath(parsed.pathname)}${suffix}`;
}

function isCanonicalGitUrl(value: string): boolean {
  if (isCanonicalScpUrl(value)) {
    return normalizeScpUrl(value) === value;
  }
  if (!GitUrlSchema.safeParse(value).success) {
    return false;
  }
  try {
    return normalizeUrl(value) === value;
  } catch {
    return false;
  }
}

function isCanonicalNpmRegistry(value: string): boolean {
  if (!NpmRegistrySchema.safeParse(value).success) {
    return false;
  }
  try {
    return normalizeUrl(value) === value;
  } catch {
    return false;
  }
}

function isCanonicalEncodedPath(value: string): boolean {
  if (!NonEmptySourceStringSchema.safeParse(value).success || !hasValidPercentEscapes(value)) {
    return false;
  }
  try {
    return encodePath(decodeURIComponent(value)) === value;
  } catch {
    return false;
  }
}

type CanonicalField = readonly [name: string, value: string | undefined];

function canonicalSource(
  kind: string,
  fields: readonly CanonicalField[],
): CanonicalSource {
  const encodedFields = fields
    .filter((field): field is readonly [string, string] => field[1] !== undefined)
    .map(([name, value]) => `${name}:${utf8ByteLength(value)}:${value}`);
  return CanonicalSourceSchema.parse(
    ["source-v1", kind, ...encodedFields].join("|"),
  );
}

export function serializeMarketplaceSource(
  source: MarketplaceSource,
): CanonicalSource {
  const value = MarketplaceSourceSchema.parse(source);
  switch (value.kind) {
    case "github":
      return canonicalSource("github", [
        ["repository", value.repository],
        ["ref", value.ref],
      ]);
    case "git":
      return canonicalSource("git", [
        ["url", normalizeUrl(value.url)],
        ["ref", value.ref],
      ]);
    case "local-git":
      return canonicalSource("local-git", [
        ["path", encodePath(value.path)],
        ["ref", value.ref],
      ]);
    default:
      return assertNever(value);
  }
}

export function serializePluginSource(source: PluginSource): CanonicalSource {
  const value = PluginSourceSchema.parse(source);
  switch (value.kind) {
    case "marketplace-path":
      return canonicalSource("marketplace-path", [
        ["path", encodePath(value.path)],
      ]);
    case "git":
      return canonicalSource("git", [
        ["url", normalizeUrl(value.url)],
        ["ref", value.ref],
        ["sha", value.sha],
      ]);
    case "git-subdir":
      return canonicalSource("git-subdir", [
        ["url", normalizeUrl(value.url)],
        // Foreign marketplace readers accept both `plugin` and `./plugin`.
        // Canonical source bytes must not let that spelling split identity.
        ["path", encodePath(value.path.startsWith("./") ? value.path.slice(2) : value.path)],
        ["ref", value.ref],
        ["sha", value.sha],
      ]);
    case "npm":
      return canonicalSource("npm", [
        ["package", value.package],
        ["selector", value.selector],
        ["registry", value.registry === undefined ? undefined : normalizeUrl(value.registry)],
      ]);
    default:
      return assertNever(value);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled source variant: ${String(value)}`);
}

export type Sha256 = (bytes: Uint8Array) => Uint8Array;

export function hashCanonicalSource(
  source: CanonicalSource,
  sha256: Sha256,
): SourceHash {
  const canonical = CanonicalSourceSchema.parse(source);
  if (typeof sha256 !== "function") {
    throw new TypeError("hashCanonicalSource requires a SHA-256 function");
  }

  const digest = sha256(encoder.encode(canonical));
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new Error("SHA-256 function must return exactly 32 bytes");
  }

  let digestHex = "";
  for (const byte of digest) {
    digestHex += `${hex[byte >> 4]}${hex[byte & 0x0f]}`.toLowerCase();
  }
  return SourceHashSchema.parse(`sha256:${digestHex}`);
}

function serializeResolvedMarketplaceSource(
  source: MarketplaceSource,
  revision: GitRevision,
): CanonicalSource {
  switch (source.kind) {
    case "github":
      return canonicalSource("github", [
        ["repository", source.repository],
        ["revision", revision],
      ]);
    case "git":
      return canonicalSource("git", [
        ["url", normalizeUrl(source.url)],
        ["revision", revision],
      ]);
    case "local-git":
      return canonicalSource("local-git", [
        ["path", encodePath(source.path)],
        ["revision", revision],
      ]);
    default:
      return assertNever(source);
  }
}

const ResolvedMarketplaceSourceIdentitySchema = z
  .object({
    declared: MarketplaceSourceSchema,
    revision: GitRevisionSchema,
  })
  .strict();

export const ResolvedMarketplaceSourceSchema = ResolvedMarketplaceSourceIdentitySchema
  .extend({
    canonical: CanonicalSourceSchema,
    hash: SourceHashSchema,
  })
  .strict()
  .readonly()
  .superRefine((value, context) => {
    const expected = serializeResolvedMarketplaceSource(value.declared, value.revision);
    if (value.canonical !== expected) {
      context.addIssue({
        code: "custom",
        path: ["canonical"],
        message: "canonical source does not match the declared kind and immutable revision",
      });
    }
  });
export type ResolvedMarketplaceSource = z.infer<
  typeof ResolvedMarketplaceSourceSchema
>;

const ResolvedPluginSourceIdentityVariantRegistry = {
  marketplacePath: {
    label: "Marketplace path",
    schema: z
      .object({
        kind: z.literal("marketplace-path"),
        marketplaceRevision: GitRevisionSchema,
        path: NonEmptySourceStringSchema,
      })
      .strict(),
  },
  git: {
    label: "Git repository",
    schema: z
      .object({
        kind: z.literal("git"),
        url: GitUrlSchema,
        revision: GitRevisionSchema,
      })
      .strict(),
  },
  gitSubdir: {
    label: "Git repository subdirectory",
    schema: z
      .object({
        kind: z.literal("git-subdir"),
        url: GitUrlSchema,
        revision: GitRevisionSchema,
        path: NonEmptySourceStringSchema,
      })
      .strict(),
  },
  npm: {
    label: "npm package",
    schema: z
      .object({
        kind: z.literal("npm"),
        package: NonEmptySourceStringSchema,
        version: NonEmptySourceStringSchema,
        integrity: NpmIntegritySchema,
        registry: NpmRegistrySchema,
      })
      .strict(),
  },
} as const;

const resolvedSourceMetadata = {
  canonical: CanonicalSourceSchema,
  hash: SourceHashSchema,
} as const;

export const ResolvedPluginSourceVariantRegistry = {
  marketplacePath: {
    label: ResolvedPluginSourceIdentityVariantRegistry.marketplacePath.label,
    schema: ResolvedPluginSourceIdentityVariantRegistry.marketplacePath.schema
      .extend(resolvedSourceMetadata)
      .strict()
      .readonly(),
  },
  git: {
    label: ResolvedPluginSourceIdentityVariantRegistry.git.label,
    schema: ResolvedPluginSourceIdentityVariantRegistry.git.schema
      .extend(resolvedSourceMetadata)
      .strict()
      .readonly(),
  },
  gitSubdir: {
    label: ResolvedPluginSourceIdentityVariantRegistry.gitSubdir.label,
    schema: ResolvedPluginSourceIdentityVariantRegistry.gitSubdir.schema
      .extend(resolvedSourceMetadata)
      .strict()
      .readonly(),
  },
  npm: {
    label: ResolvedPluginSourceIdentityVariantRegistry.npm.label,
    schema: ResolvedPluginSourceIdentityVariantRegistry.npm.schema
      .extend(resolvedSourceMetadata)
      .strict()
      .readonly(),
  },
} as const;

const ResolvedPluginSourceIdentitySchema = z.discriminatedUnion(
  "kind",
  schemasFor(ResolvedPluginSourceIdentityVariantRegistry),
);

type ResolvedPluginSourceIdentity = z.infer<
  typeof ResolvedPluginSourceIdentitySchema
>;

function serializeResolvedPluginSource(
  source: ResolvedPluginSourceIdentity,
): CanonicalSource {
  switch (source.kind) {
    case "marketplace-path":
      return canonicalSource("marketplace-path", [
        ["path", encodePath(source.path)],
        ["marketplaceRevision", source.marketplaceRevision],
      ]);
    case "git":
      return canonicalSource("git", [
        ["url", normalizeUrl(source.url)],
        ["revision", source.revision],
      ]);
    case "git-subdir":
      return canonicalSource("git-subdir", [
        ["url", normalizeUrl(source.url)],
        ["path", encodePath(source.path)],
        ["revision", source.revision],
      ]);
    case "npm":
      return canonicalSource("npm", [
        ["package", source.package],
        ["version", source.version],
        ["integrity", source.integrity],
        ["registry", normalizeUrl(source.registry)],
      ]);
    default:
      return assertNever(source);
  }
}

export const ResolvedPluginSourceSchema = z
  .discriminatedUnion("kind", schemasFor(ResolvedPluginSourceVariantRegistry))
  .superRefine((value, context) => {
    const expected = serializeResolvedPluginSource(value);
    if (value.canonical !== expected) {
      context.addIssue({
        code: "custom",
        path: ["canonical"],
        message: "canonical source does not match the kind and immutable source fields",
      });
    }
  });
export type ResolvedPluginSource = z.infer<
  typeof ResolvedPluginSourceSchema
>;

const ResolvedMarketplaceSourceInputSchema = z
  .object({
    declared: MarketplaceSourceSchema,
    revision: GitRevisionSchema,
    canonical: CanonicalSourceSchema.optional(),
    hash: SourceHashSchema.optional(),
  })
  .strict();

/**
 * Build the immutable marketplace contract from a declaration and resolved
 * revision. The domain computes canonical bytes; an adapter supplies only the
 * SHA-256 port. Optional supplied canonical/hash claims are checked rather
 * than trusted.
 */
export function createResolvedMarketplaceSource(
  input: unknown,
  sha256: Sha256,
): ResolvedMarketplaceSource {
  const value = ResolvedMarketplaceSourceInputSchema.parse(input);
  const canonical = serializeResolvedMarketplaceSource(value.declared, value.revision);
  const hash = hashCanonicalSource(canonical, sha256);
  if (value.canonical !== undefined && value.canonical !== canonical) {
    throw new Error("resolved marketplace canonical source does not match its identity");
  }
  if (value.hash !== undefined && value.hash !== hash) {
    throw new Error("resolved marketplace source hash does not match its canonical source");
  }
  return ResolvedMarketplaceSourceSchema.parse({
    ...value,
    canonical,
    hash,
  });
}

/** Verify both the canonical identity and the injected source hash. */
export function verifyResolvedMarketplaceSource(
  input: unknown,
  sha256: Sha256,
): ResolvedMarketplaceSource {
  const value = ResolvedMarketplaceSourceSchema.parse(input);
  const expectedHash = hashCanonicalSource(value.canonical, sha256);
  if (value.hash !== expectedHash) {
    throw new Error("resolved marketplace source hash does not match its canonical source");
  }
  return value;
}

const ResolvedPluginSourceInputSchema = z.discriminatedUnion("kind", [
  ResolvedPluginSourceIdentityVariantRegistry.marketplacePath.schema
    .extend({
      canonical: CanonicalSourceSchema.optional(),
      hash: SourceHashSchema.optional(),
    })
    .strict(),
  ResolvedPluginSourceIdentityVariantRegistry.git.schema
    .extend({
      canonical: CanonicalSourceSchema.optional(),
      hash: SourceHashSchema.optional(),
    })
    .strict(),
  ResolvedPluginSourceIdentityVariantRegistry.gitSubdir.schema
    .extend({
      canonical: CanonicalSourceSchema.optional(),
      hash: SourceHashSchema.optional(),
    })
    .strict(),
  ResolvedPluginSourceIdentityVariantRegistry.npm.schema
    .extend({
      canonical: CanonicalSourceSchema.optional(),
      hash: SourceHashSchema.optional(),
    })
    .strict(),
]);

/** Build a resolved plugin source while binding all immutable fields together. */
export function createResolvedPluginSource(
  input: unknown,
  sha256: Sha256,
): ResolvedPluginSource {
  const value = ResolvedPluginSourceInputSchema.parse(input) as ResolvedPluginSourceIdentity & {
    readonly canonical?: CanonicalSource;
    readonly hash?: SourceHash;
  };
  const canonical = serializeResolvedPluginSource(value);
  const hash = hashCanonicalSource(canonical, sha256);
  if (value.canonical !== undefined && value.canonical !== canonical) {
    throw new Error("resolved plugin canonical source does not match its identity");
  }
  if (value.hash !== undefined && value.hash !== hash) {
    throw new Error("resolved plugin source hash does not match its canonical source");
  }
  return ResolvedPluginSourceSchema.parse({
    ...value,
    canonical,
    hash,
  });
}

/** Verify kind, immutable fields, canonical bytes, and the injected hash. */
export function verifyResolvedPluginSource(
  input: unknown,
  sha256: Sha256,
): ResolvedPluginSource {
  const value = ResolvedPluginSourceSchema.parse(input);
  const expectedHash = hashCanonicalSource(value.canonical, sha256);
  if (value.hash !== expectedHash) {
    throw new Error("resolved plugin source hash does not match its canonical source");
  }
  return value;
}
