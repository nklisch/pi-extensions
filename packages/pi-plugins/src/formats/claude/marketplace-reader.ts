import {
  MarketplaceReadResultSchema,
  NormalizedMarketplaceSchema,
  type MarketplaceReadResult,
  type NormalizedMarketplaceEntry,
} from "../../domain/marketplace.js";
import {
  formatPluginKey,
  MarketplaceNameSchema,
  PluginIdentitySchema,
  PluginNameSchema,
  type MarketplaceName,
  type PluginName,
} from "../../domain/identity.js";
import {
  isValidGitHubRepository,
  PluginSourceSchema,
  type PluginSource,
} from "../../domain/source.js";
import { type JsonValue } from "../../domain/schema.js";
import type { Provenance } from "../../domain/provenance.js";
import {
  MarketplaceEntryDeclarationRegistry,
  MarketplaceEntryError,
  claimAt,
  claimedFrom,
  collectEntryDeclarations,
  collectEntryMetadata,
  collectRootMetadata,
  documentPath,
  entryDiagnostic,
  entryError,
  entryPointerPath,
  isJsonRecord,
  joinCatalogRelativePath,
  jsonPointer,
  readJsonDocument,
  readPluginRoot,
  readRootRecord,
  readInstallationPolicy,
  requireString,
  sourceLocation,
  validateCatalogRelativePath,
  validateRelativeSubdirectoryPath,
  type MarketplaceReaderOptions,
  provenanceAt,
  rootInvalid,
} from "../marketplace-reader-support.js";

export const CLAUDE_MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

const OPERATION = "readClaudeMarketplace";
const JSON_OPERATION = "readClaudeMarketplaceJson";
const RUNTIME_AND_POLICY_FIELDS = new Set<string>([
  "name",
  "source",
  "version",
  "description",
  "policy",
  "strict",
  ...Object.keys(MarketplaceEntryDeclarationRegistry),
]);

function ensureSourceKeys(
  source: { readonly [key: string]: JsonValue },
  allowed: readonly string[],
  pointer: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(source)) {
    if (!allowedSet.has(key)) {
      throw entryError("SOURCE_INVALID", `${pointer}/${jsonPointer(key).slice(1)}`, `source field ${key} is not supported`);
    }
  }
}

function sourceFailure(pointer: string, message: string, details?: JsonValue): MarketplaceEntryError {
  return entryError("SOURCE_INVALID", pointer, message, undefined, details);
}

function parsePluginSource(
  raw: JsonValue,
  pointer: string,
  pluginRoot: string | undefined,
): PluginSource {
  try {
    if (typeof raw === "string") {
      const relative = validateCatalogRelativePath(raw, pointer);
      return PluginSourceSchema.parse({
        kind: "marketplace-path",
        path: joinCatalogRelativePath(pluginRoot, relative, pointer),
      });
    }
    if (!isJsonRecord(raw)) {
      throw sourceFailure(pointer, "Claude source must be a relative path or object");
    }

    const sourceType = raw.source;
    if (typeof sourceType !== "string") {
      throw sourceFailure(`${pointer}/source`, "Claude source.type must be a string");
    }

    let candidate: Record<string, unknown>;
    switch (sourceType) {
      case "github": {
        ensureSourceKeys(raw, ["source", "repo", "ref"], pointer);
        const repository = requireGithubRepository(raw.repo, `${pointer}/repo`);
        candidate = {
          kind: "git",
          url: `https://github.com/${repository}.git`,
          ...(raw.ref === undefined ? {} : { ref: requireSourceString(raw.ref, "ref", `${pointer}/ref`) }),
        };
        break;
      }
      case "url": {
        ensureSourceKeys(raw, ["source", "url", "ref", "sha"], pointer);
        candidate = {
          kind: "git",
          url: requireSourceString(raw.url, "url", `${pointer}/url`),
          ...(raw.ref === undefined ? {} : { ref: requireSourceString(raw.ref, "ref", `${pointer}/ref`) }),
          ...(raw.sha === undefined ? {} : { sha: requireSourceString(raw.sha, "sha", `${pointer}/sha`) }),
        };
        break;
      }
      case "git-subdir": {
        ensureSourceKeys(raw, ["source", "url", "path", "ref", "sha"], pointer);
        const sourcePath = requireSourceString(raw.path, "path", `${pointer}/path`);
        let normalizedPath: string;
        try {
          normalizedPath = validateRelativeSubdirectoryPath(sourcePath, `${pointer}/path`);
        } catch (error) {
          throw sourceFailure(`${pointer}/path`, error instanceof Error ? error.message : "repository path is invalid");
        }
        candidate = {
          kind: "git-subdir",
          url: requireSourceString(raw.url, "url", `${pointer}/url`),
          path: normalizedPath,
          ...(raw.ref === undefined ? {} : { ref: requireSourceString(raw.ref, "ref", `${pointer}/ref`) }),
          ...(raw.sha === undefined ? {} : { sha: requireSourceString(raw.sha, "sha", `${pointer}/sha`) }),
        };
        break;
      }
      case "npm": {
        ensureSourceKeys(raw, ["source", "package", "version", "registry"], pointer);
        candidate = {
          kind: "npm",
          package: requireSourceString(raw.package, "package", `${pointer}/package`),
          ...(raw.version === undefined ? {} : { selector: requireSourceString(raw.version, "version", `${pointer}/version`) }),
          ...(raw.registry === undefined ? {} : { registry: requireSourceString(raw.registry, "registry", `${pointer}/registry`) }),
        };
        break;
      }
      default:
        throw sourceFailure(`${pointer}/source`, `Unsupported Claude source type ${sourceType}`);
    }
    return PluginSourceSchema.parse(candidate);
  } catch (error) {
    if (error instanceof MarketplaceEntryError) {
      throw error;
    }
    if (error instanceof Error) {
      throw sourceFailure(pointer, `Invalid Claude source: ${error.message}`,
        error instanceof Error && "issues" in error ? undefined : undefined);
    }
    throw sourceFailure(pointer, "Invalid Claude source");
  }
}

function requireSourceString(value: JsonValue | undefined, field: string, pointer: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw sourceFailure(pointer, `${field} must be a non-empty string`);
  }
  return value;
}

// GitHub's shorthand grammar is shared with the marketplace source contract
// so catalog URL synthesis and direct source validation cannot drift.

function requireGithubRepository(value: JsonValue | undefined, pointer: string): string {
  const repository = requireSourceString(value, "repo", pointer);
  if (!isValidGitHubRepository(repository)) {
    throw sourceFailure(pointer, "repo must be exactly owner/repository with GitHub owner and repository names, without .git or URL syntax");
  }
  return repository;
}

function validateClaudePresentation(entry: { readonly [key: string]: JsonValue }, entryPointer: string): void {
  if (entry.category !== undefined && (typeof entry.category !== "string" || entry.category.length === 0)) {
    throw entryError("ENTRY_INVALID", entryPointerPath(entryPointer, "category"), "category must be a non-empty string");
  }
  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string")) {
      throw entryError("ENTRY_INVALID", entryPointerPath(entryPointer, "tags"), "tags must be an array of strings");
    }
  }
}

function readClaudeEntry(
  raw: JsonValue,
  rootName: MarketplaceName,
  rootNameValue: JsonValue,
  nativeHost: "claude",
  path: string,
  index: number,
  pluginRoot: string | undefined,
  pluginRootProvenance: Provenance | undefined,
): NormalizedMarketplaceEntry {
  const entryPointer = jsonPointer("plugins", index);
  if (!isJsonRecord(raw)) {
    throw entryError("ENTRY_INVALID", entryPointer, "marketplace entry must be an object");
  }

  const rawName = raw.name;
  if (typeof rawName !== "string" || !PluginNameSchema.safeParse(rawName).success) {
    throw entryError("IDENTITY_INVALID", entryPointerPath(entryPointer, "name"), "marketplace entry name is invalid");
  }
  const pluginName = PluginNameSchema.parse(rawName) as PluginName;
  const key = formatPluginKey(pluginName, rootName);
  const rawSource = raw.source;
  if (rawSource === undefined) {
    throw entryError("SOURCE_INVALID", entryPointerPath(entryPointer, "source"), "marketplace entry source is missing", key);
  }

  const source = parsePluginSource(rawSource, entryPointerPath(entryPointer, "source"), pluginRoot);
  const sourceProvenance = provenanceAt(nativeHost, path, entryPointerPath(entryPointer, "source"), rawSource);
  const sourceClaim = source.kind === "marketplace-path" && pluginRootProvenance !== undefined
    ? claimedFrom(source, [pluginRootProvenance, sourceProvenance])
    : claimedFrom(source, [sourceProvenance]);
  const identity = PluginIdentitySchema.parse({
    key,
    marketplaceName: rootName,
    marketplaceEntryName: pluginName,
  });
  const identityClaim = claimedFrom(identity, [
    provenanceAt(nativeHost, path, jsonPointer("name"), rootNameValue),
    provenanceAt(nativeHost, path, entryPointerPath(entryPointer, "name"), rawName),
  ]);

  const version = raw.version === undefined
    ? undefined
    : claimAt(requireString(raw.version, "version", entryPointerPath(entryPointer, "version"), { nonEmpty: true }), nativeHost, path, entryPointerPath(entryPointer, "version"), raw.version);
  const description = raw.description === undefined
    ? undefined
    : claimAt(requireString(raw.description, "description", entryPointerPath(entryPointer, "description")), nativeHost, path, entryPointerPath(entryPointer, "description"), raw.description);

  validateClaudePresentation(raw, entryPointer);
  const policy = raw.policy === undefined
    ? undefined
    : readInstallationPolicy(raw.policy, nativeHost, path, entryPointerPath(entryPointer, "policy"));

  const strictValue = raw.strict === undefined ? true : raw.strict;
  if (typeof strictValue !== "boolean") {
    throw entryError("ENTRY_INVALID", entryPointerPath(entryPointer, "strict"), "strict must be a boolean", key);
  }
  const strictPointer = raw.strict === undefined
    ? entryPointer
    : entryPointerPath(entryPointer, "strict");
  const strictDeclaration = raw.strict === undefined ? raw : raw.strict;
  const strictProvenance = provenanceAt(nativeHost, path, strictPointer, strictDeclaration);
  const authority = {
    nativeHost,
    strict: claimedFrom(strictValue, [strictProvenance]),
    manifest: claimedFrom(strictValue ? "required" as const : "optional" as const, [strictProvenance]),
    catalogRuntime: claimedFrom(strictValue ? "supplemental" as const : "authoritative" as const, [strictProvenance]),
  };

  const declarations = collectEntryDeclarations(raw, nativeHost, path, entryPointer);
  const metadata = collectEntryMetadata(
    raw,
    nativeHost,
    path,
    entryPointer,
    RUNTIME_AND_POLICY_FIELDS,
  );

  return {
    identity: identityClaim,
    source: sourceClaim,
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
    ...(policy === undefined ? {} : { policy }),
    authorities: [authority],
    declarations,
    metadata,
    rawDeclaration: claimAt(raw, nativeHost, path, entryPointer, raw),
  };
}

function readMarketplaceInput(
  input: unknown,
  options: MarketplaceReaderOptions | undefined,
  operation: string,
): MarketplaceReadResult {
  const path = documentPath(options, CLAUDE_MARKETPLACE_PATH);
  const root = readRootRecord(input, operation, "claude", path);
  const rawName = root.name;
  if (typeof rawName !== "string" || !MarketplaceNameSchema.safeParse(rawName).success) {
    throw rootInvalid(operation, "claude", path, "Marketplace root name is missing or invalid", {
      pointer: jsonPointer("name"),
    }, undefined, jsonPointer("name"));
  }
  const marketplaceName = MarketplaceNameSchema.parse(rawName) as MarketplaceName;
  const rawPlugins = root.plugins;
  if (!Array.isArray(rawPlugins)) {
    throw rootInvalid(operation, "claude", path, "Marketplace root plugins must be an array", {
      pointer: jsonPointer("plugins"),
    }, undefined, jsonPointer("plugins"));
  }
  const {
    root: pluginRoot,
    pluginRootProvenance,
    metadata: nestedMetadata,
  } = readPluginRoot(root, "claude", path, operation);
  const entries: NormalizedMarketplaceEntry[] = [];
  const entryIndexes: number[] = [];
  const diagnostics = [] as ReturnType<typeof entryDiagnostic>[];

  for (const [index, rawEntry] of rawPlugins.entries()) {
    try {
      entries.push(readClaudeEntry(
        rawEntry,
        marketplaceName,
        rawName,
        "claude",
        path,
        index,
        pluginRoot,
        pluginRootProvenance,
      ));
      entryIndexes.push(index);
    } catch (error) {
      const entryFailure = error instanceof MarketplaceEntryError
        ? error
        : new MarketplaceEntryError({
            code: "ENTRY_INVALID",
            pointer: jsonPointer("plugins", index),
            message: error instanceof Error ? error.message : "Marketplace entry is invalid",
          });
      diagnostics.push(entryDiagnostic(entryFailure, operation, "claude", path));
    }
  }

  const seen = new Map<string, number>();
  for (const [parsedIndex, entry] of entries.entries()) {
    const originalIndex = entryIndexes[parsedIndex] as number;
    const key = entry.identity.value.key;
    const first = seen.get(key);
    if (first !== undefined) {
      throw rootInvalid(operation, "claude", path, `Duplicate surviving marketplace entry ${key}`, {
        key,
        first: jsonPointer("plugins", first),
        duplicate: jsonPointer("plugins", originalIndex),
      }, undefined, jsonPointer("plugins", originalIndex));
    }
    seen.set(key, originalIndex);
  }

  const marketplace = NormalizedMarketplaceSchema.parse({
    name: claimAt(marketplaceName, "claude", path, jsonPointer("name"), rawName),
    entries,
    metadata: [...collectRootMetadata(root, "claude", path), ...nestedMetadata],
    sourceDocuments: [
      {
        location: sourceLocation("claude", path, jsonPointer()),
        declaration: root,
      },
    ],
  });
  return MarketplaceReadResultSchema.parse({ marketplace, diagnostics });
}

export function readClaudeMarketplace(
  input: unknown,
  options?: MarketplaceReaderOptions,
): MarketplaceReadResult {
  return readMarketplaceInput(input, options, OPERATION);
}

export function readClaudeMarketplaceJson(
  json: string,
  options?: MarketplaceReaderOptions,
): MarketplaceReadResult {
  const path = documentPath(options, CLAUDE_MARKETPLACE_PATH);
  const input = readJsonDocument(json, JSON_OPERATION, "claude", path);
  return readMarketplaceInput(input, options, JSON_OPERATION);
}
