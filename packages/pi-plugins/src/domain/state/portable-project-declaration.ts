import { z } from "zod";
import {
  MarketplaceNameSchema,
  PluginKeySchema,
} from "../identity.js";
import { schemaValues } from "../schema.js";
import {
  MarketplaceSourceVariantRegistry,
  PluginSourceSchema,
} from "../source.js";

/** Portable marketplace sources intentionally omit local-git. */
export const PortableMarketplaceSourceSchema = z
  .discriminatedUnion(
    "kind",
    schemaValues({
      github: MarketplaceSourceVariantRegistry.github.schema,
      git: MarketplaceSourceVariantRegistry.git.schema,
    }),
  )
  .readonly();
export type PortableMarketplaceSource = z.infer<
  typeof PortableMarketplaceSourceSchema
>;

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

function hasValidPercentEscapes(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") continue;
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) return false;
    index += 2;
  }
  return true;
}

/**
 * A path in a portable declaration is a declaration relative to a materialized
 * marketplace/plugin root. Decode each segment once before checking it so an
 * encoded dot, separator, or NUL cannot become traversal after this boundary.
 */
export function isSafePortableRelativePath(value: string): boolean {
  if (
    hasLoneSurrogate(value) ||
    !value.startsWith("./") ||
    value.length === 2 ||
    value.includes("\\") ||
    value.includes("\0") ||
    /(?:^|\/)\s*[A-Za-z]:\//.test(value.slice(2))
  ) {
    return false;
  }

  const segments = value.slice(2).split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return false;
  }

  return segments.every((segment) => {
    if (!hasValidPercentEscapes(segment)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      return false;
    }
    return [...decoded].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    });
  });
}

function addIssue(
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path: [...path], message });
}

/**
 * Git repository subdirectories accept the existing source spelling with or
 * without `./`; marketplace paths are stricter because they are resolved by a
 * marketplace catalog and must carry the explicit relative marker.
 */
function isSafePortableRepositorySubdirectory(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\") || value.startsWith("~")) {
    return false;
  }
  return isSafePortableRelativePath(value.startsWith("./") ? value : `./${value}`);
}

function validatePortablePluginSource(
  source: z.infer<typeof PluginSourceSchema>,
  context: z.RefinementCtx,
): void {
  if (source.kind === "marketplace-path" && !isSafePortableRelativePath(source.path)) {
    addIssue(
      context,
      ["path"],
      "portable marketplace paths must be safe ./ relative paths",
    );
  }
  if (source.kind === "git-subdir" && !isSafePortableRepositorySubdirectory(source.path)) {
    addIssue(
      context,
      ["path"],
      "portable Git subdirectories must be safe relative paths",
    );
  }
}

export const PortablePluginSourceSchema = PluginSourceSchema.superRefine(
  validatePortablePluginSource,
);
export type PortablePluginSource = z.infer<typeof PortablePluginSourceSchema>;

export const PortablePluginConstraintSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("declared-version"),
        value: z.string().min(1),
      })
      .strict()
      .readonly(),
    z
      .object({
        kind: z.literal("source"),
        source: PortablePluginSourceSchema,
      })
      .strict()
      .readonly(),
  ])
  .readonly();
export type PortablePluginConstraint = z.infer<
  typeof PortablePluginConstraintSchema
>;

export const PortableMarketplaceDeclarationSchema = z
  .object({
    marketplace: MarketplaceNameSchema,
    source: PortableMarketplaceSourceSchema,
  })
  .strict()
  .readonly();
export type PortableMarketplaceDeclaration = z.infer<
  typeof PortableMarketplaceDeclarationSchema
>;

export const PortablePluginDeclarationSchema = z
  .object({
    plugin: PluginKeySchema,
    enabled: z.boolean(),
    constraint: PortablePluginConstraintSchema.optional(),
  })
  .strict()
  .readonly();
export type PortablePluginDeclaration = z.infer<
  typeof PortablePluginDeclarationSchema
>;

const prohibitedKeyNames = new Set([
  "absolute",
  "absolutepath",
  "active",
  "activation",
  "blob",
  "blobref",
  "cache",
  "cachepath",
  "cacheref",
  "canonical",
  "configuration",
  "configurationref",
  "credential",
  "credentials",
  "data",
  "datapath",
  "dataref",
  "diagnostic",
  "diagnostics",
  "digest",
  "environment",
  "generated",
  "generation",
  "hash",
  "header",
  "headers",
  "immutable",
  "install",
  "installed",
  "integrity",
  "installpath",
  "journal",
  "operation",
  "operations",
  "pathref",
  "pending",
  "pendingoperation",
  "pendingtransition",
  "project",
  "projectidentity",
  "projectkey",
  "projection",
  "projections",
  "reload",
  "resolved",
  "revision",
  "root",
  "rootpath",
  "secret",
  "secrets",
  "state",
  "stateblob",
  "statepath",
  "stateref",
  "timestamp",
  "timestamps",
  "token",
  "tokens",
  "trust",
  "trustsubject",
  "trusted",
  "updatedat",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isProhibitedKey(compact: string): boolean {
  if (prohibitedKeyNames.has(compact)) return true;
  return [
    "absolute",
    "cache",
    "canonical",
    "config",
    "credential",
    "data",
    "digest",
    "diagnostic",
    "environment",
    "generated",
    "immutable",
    "install",
    "integrity",
    "journal",
    "machine",
    "operation",
    "pending",
    "physical",
    "projection",
    "projectidentity",
    "projectkey",
    "resolved",
    "revision",
    "root",
    "secret",
    "state",
    "timestamp",
    "token",
    "trust",
  ].some((fragment) => compact.includes(fragment));
}

function isEmbeddedCredential(value: string): boolean {
  // A normal SSH user is part of the existing Git source grammar. A password
  // is not portable intent, regardless of whether it appears in a URI or SCP
  // spelling.
  if (/^[^/\\\s:@]+:[^/\\\s@]+@/.test(value)) return true;
  if (!value.includes("://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.username !== "" && parsed.password !== "";
  } catch {
    return false;
  }
}

function isMachinePathLike(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("//") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value === "~" ||
    value.startsWith("~/") ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.includes("\\..") ||
    value.startsWith("./") ||
    /^file:/i.test(value)
  );
}

function isAllowedUrlKey(key: string): boolean {
  return key === "url" || key === "registry";
}

function assertPortableValue(
  input: unknown,
  path: readonly (string | number)[],
  seen: WeakSet<object>,
): void {
  if (typeof input === "string") {
    if (hasLoneSurrogate(input)) {
      throw new Error(`portable declaration contains a lone surrogate at ${formatPath(path)}`);
    }
    if (isEmbeddedCredential(input)) {
      throw new Error(`portable declaration contains embedded credentials at ${formatPath(path)}`);
    }
    const key = typeof path.at(-1) === "string" ? String(path.at(-1)) : "";
    if (key !== "path" && !isAllowedUrlKey(key) && isMachinePathLike(input)) {
      throw new Error(`portable declaration contains a machine path at ${formatPath(path)}`);
    }
    return;
  }
  if (input === null || typeof input !== "object") return;
  if (seen.has(input)) {
    throw new Error(`portable declaration contains a cyclic value at ${formatPath(path)}`);
  }
  seen.add(input);

  if (Array.isArray(input)) {
    for (const [index, value] of input.entries()) {
      assertPortableValue(value, [...path, index], seen);
    }
    seen.delete(input);
    return;
  }

  let keys: string[];
  try {
    if (Object.getOwnPropertySymbols(input).length > 0) {
      throw new Error(`portable declaration contains a symbol key at ${formatPath(path)}`);
    }
    keys = Object.keys(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("portable declaration")) {
      throw error;
    }
    throw new Error(`portable declaration contains an unreadable object at ${formatPath(path)}`);
  }

  for (const key of keys) {
    const compact = normalizedKey(key);
    if (isProhibitedKey(compact)) {
      throw new Error(`portable declaration prohibits field ${formatPath([...path, key])}`);
    }
    const value = (input as Record<string, unknown>)[key];
    if (key === "path") {
      if (typeof value !== "string" || !isSafePortableRelativePath(value)) {
        throw new Error(`portable declaration path is not safely relative at ${formatPath([...path, key])}`);
      }
    }
    assertPortableValue(value, [...path, key], seen);
  }
  seen.delete(input);
}

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "<root>";
  return path.reduce<string>(
    (result, segment) => typeof segment === "number"
      ? `${result}[${segment}]`
      : `${result}.${segment}`,
    "$",
  );
}

/**
 * Run the recursive defense-in-depth guard used by the portable decoder. The
 * public schema remains useful on its own; this function is the fail-fast
 * whole-file entry point for JSON parsed from `.pi/plugins.json`.
 */
export function assertPortableProjectDeclarationSafe(input: unknown): void {
  assertPortableValue(input, [], new WeakSet<object>());
}

function addDuplicateIssues<T extends { readonly [key: string]: unknown }>(
  values: readonly T[],
  key: keyof T,
  path: readonly PropertyKey[],
  context: z.RefinementCtx,
  label: string,
): void {
  const firstByValue = new Map<unknown, number>();
  for (const [index, value] of values.entries()) {
    const fieldValue = value[key];
    const firstIndex = firstByValue.get(fieldValue);
    if (firstIndex !== undefined) {
      addIssue(
        context,
        [...path, index, String(key)],
        `duplicate ${label}; first declared at index ${firstIndex}`,
      );
    } else {
      firstByValue.set(fieldValue, index);
    }
  }
}

/**
 * The only fields that can cross the portable project declaration boundary.
 * The literal version remains so a future clean cut-over can recognize stale
 * documents; stale versions are reinitialized by the state codec, never
 * migrated.
 */
export const PortableProjectDeclarationSchema = z
  .object({
    schemaVersion: z.literal(1),
    marketplaces: z.array(PortableMarketplaceDeclarationSchema).max(256).readonly(),
    plugins: z.array(PortablePluginDeclarationSchema).max(256).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((document, context) => {
    addDuplicateIssues(document.marketplaces, "marketplace", ["marketplaces"], context, "marketplace declaration");
    addDuplicateIssues(document.plugins, "plugin", ["plugins"], context, "plugin declaration");

    // Marketplace registrations are host-global. A project may declare a
    // marketplace source as a portable prerequisite, but installed plugin
    // intent does not duplicate or own that registration.

    try {
      assertPortableProjectDeclarationSafe(document);
    } catch (error) {
      addIssue(
        context,
        [],
        error instanceof Error ? error.message : "portable declaration contains prohibited state",
      );
    }
  });
export type PortableProjectDeclaration = z.infer<
  typeof PortableProjectDeclarationSchema
>;

/**
 * Decode one complete `.pi/plugins.json` value. No partial collection result is
 * returned: either the whole declaration validates or the boundary throws.
 */
export function parsePortableProjectDeclaration(
  input: unknown,
): PortableProjectDeclaration {
  assertPortableProjectDeclarationSafe(input);
  return PortableProjectDeclarationSchema.parse(input);
}

/** Explicit decoder spelling for callers that model JSON boundaries as codecs. */
export const decodePortableProjectDeclaration = parsePortableProjectDeclaration;
