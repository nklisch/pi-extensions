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
import { PluginSourceSchema, type PluginSource } from "../../domain/source.js";
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
  readInstallationPolicy,
  readJsonDocument,
  readPluginRoot,
  readRootRecord,
  rootInvalid,
  sourceLocation,
  validateCatalogRelativePath,
  validateRelativeSubdirectoryPath,
  type MarketplaceReaderOptions,
  provenanceAt,
} from "../marketplace-reader-support.js";

export const CODEX_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";

const OPERATION = "readCodexMarketplace";
const JSON_OPERATION = "readCodexMarketplaceJson";
const ENTRY_FIELDS = new Set<string>([
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

function sourceFailure(pointer: string, message: string): MarketplaceEntryError {
  return entryError("SOURCE_INVALID", pointer, message);
}

function requireSourceString(value: JsonValue | undefined, field: string, pointer: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw sourceFailure(pointer, `${field} must be a non-empty string`);
  }
  return value;
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
      throw sourceFailure(pointer, "Codex source must be a relative path or object");
    }

    const sourceType = raw.source;
    if (typeof sourceType !== "string") {
      throw sourceFailure(`${pointer}/source`, "Codex source.type must be a string");
    }

    let candidate: Record<string, unknown>;
    switch (sourceType) {
      case "local": {
        ensureSourceKeys(raw, ["source", "path"], pointer);
        const localPath = requireSourceString(raw.path, "path", `${pointer}/path`);
        try {
          validateCatalogRelativePath(localPath, `${pointer}/path`);
        } catch (error) {
          throw sourceFailure(`${pointer}/path`, error instanceof Error ? error.message : "local path is invalid");
        }
        candidate = {
          kind: "marketplace-path",
          path: joinCatalogRelativePath(pluginRoot, localPath, `${pointer}/path`),
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
      default:
        throw sourceFailure(`${pointer}/source`, `Unsupported Codex source type ${sourceType}`);
    }
    return PluginSourceSchema.parse(candidate);
  } catch (error) {
    if (error instanceof MarketplaceEntryError) {
      throw error;
    }
    if (error instanceof Error) {
      throw sourceFailure(pointer, `Invalid Codex source: ${error.message}`);
    }
    throw sourceFailure(pointer, "Invalid Codex source");
  }
}

function validateCodexPresentation(
  entry: { readonly [key: string]: JsonValue },
  entryPointer: string,
): void {
  if (entry.category !== undefined && (typeof entry.category !== "string" || entry.category.length === 0)) {
    throw entryError("ENTRY_INVALID", entryPointerPath(entryPointer, "category"), "category must be a non-empty string");
  }
  if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string"))) {
    throw entryError("ENTRY_INVALID", entryPointerPath(entryPointer, "tags"), "tags must be an array of strings");
  }
  if (entry.interface !== undefined && !isJsonRecord(entry.interface)) {
    throw entryError("ENTRY_INVALID", entryPointerPath(entryPointer, "interface"), "interface must be an object");
  }
}

function readCodexEntry(
  raw: JsonValue,
  rootName: MarketplaceName,
  rootNameValue: JsonValue,
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
  if (raw.strict !== undefined) {
    throw entryError("ENTRY_INVALID", entryPointerPath(entryPointer, "strict"), "Codex entries cannot carry Claude strictness", key);
  }
  const rawSource = raw.source;
  if (rawSource === undefined) {
    throw entryError("SOURCE_INVALID", entryPointerPath(entryPointer, "source"), "marketplace entry source is missing", key);
  }

  const source = parsePluginSource(rawSource, entryPointerPath(entryPointer, "source"), pluginRoot);
  const sourceProvenance = provenanceAt("codex", path, entryPointerPath(entryPointer, "source"), rawSource);
  const sourceClaim = source.kind === "marketplace-path" && pluginRootProvenance !== undefined
    ? claimedFrom(source, [pluginRootProvenance, sourceProvenance])
    : claimedFrom(source, [sourceProvenance]);
  const identity = PluginIdentitySchema.parse({
    key,
    marketplaceName: rootName,
    marketplaceEntryName: pluginName,
  });
  const identityClaim = claimedFrom(identity, [
    provenanceAt("codex", path, jsonPointer("name"), rootNameValue),
    provenanceAt("codex", path, entryPointerPath(entryPointer, "name"), rawName),
  ]);

  const version = raw.version === undefined
    ? undefined
    : claimAt(requireString(raw.version, "version", entryPointerPath(entryPointer, "version"), true), "codex", path, entryPointerPath(entryPointer, "version"), raw.version);
  const description = raw.description === undefined
    ? undefined
    : claimAt(requireString(raw.description, "description", entryPointerPath(entryPointer, "description")), "codex", path, entryPointerPath(entryPointer, "description"), raw.description);

  validateCodexPresentation(raw, entryPointer);
  if (raw.policy === undefined) {
    throw entryError("ENTRY_INVALID", entryPointerPath(entryPointer, "policy"), "Codex marketplace entry policy is required", key);
  }
  const policy = readInstallationPolicy(raw.policy, "codex", path, entryPointerPath(entryPointer, "policy"));
  const entryProvenance = provenanceAt("codex", path, entryPointer, raw);
  const authority = {
    nativeHost: "codex" as const,
    manifest: claimedFrom("required" as const, [entryProvenance]),
    catalogRuntime: claimedFrom("supplemental" as const, [entryProvenance]),
  };

  const declarations = collectEntryDeclarations(raw, "codex", path, entryPointer);
  const metadata = collectEntryMetadata(
    raw,
    "codex",
    path,
    entryPointer,
    ENTRY_FIELDS,
  );

  return {
    identity: identityClaim,
    source: sourceClaim,
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
    policy,
    authorities: [authority],
    declarations,
    metadata,
    rawDeclaration: claimAt(raw, "codex", path, entryPointer, raw),
  };
}

function requireString(
  value: JsonValue | undefined,
  field: string,
  pointer: string,
  nonEmpty = false,
): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
    throw entryError("ENTRY_INVALID", pointer, `${field} must be a${nonEmpty ? " non-empty" : ""} string`);
  }
  return value;
}

function readMarketplaceInput(
  input: unknown,
  options: MarketplaceReaderOptions | undefined,
  operation: string,
): MarketplaceReadResult {
  const path = documentPath(options, CODEX_MARKETPLACE_PATH);
  const root = readRootRecord(input, operation, "codex", path);
  const rawName = root.name;
  if (typeof rawName !== "string" || !MarketplaceNameSchema.safeParse(rawName).success) {
    throw rootInvalid(operation, "codex", path, "Marketplace root name is missing or invalid", {
      pointer: jsonPointer("name"),
    }, undefined, jsonPointer("name"));
  }
  const marketplaceName = MarketplaceNameSchema.parse(rawName) as MarketplaceName;
  const rawPlugins = root.plugins;
  if (!Array.isArray(rawPlugins)) {
    throw rootInvalid(operation, "codex", path, "Marketplace root plugins must be an array", {
      pointer: jsonPointer("plugins"),
    }, undefined, jsonPointer("plugins"));
  }
  const {
    root: pluginRoot,
    pluginRootProvenance,
    metadata: nestedMetadata,
  } = readPluginRoot(root, "codex", path, operation);
  const entries: NormalizedMarketplaceEntry[] = [];
  const entryIndexes: number[] = [];
  const diagnostics = [] as ReturnType<typeof entryDiagnostic>[];

  for (const [index, rawEntry] of rawPlugins.entries()) {
    try {
      entries.push(readCodexEntry(
        rawEntry,
        marketplaceName,
        rawName,
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
      diagnostics.push(entryDiagnostic(entryFailure, operation, "codex", path));
    }
  }

  const seen = new Map<string, number>();
  for (const [parsedIndex, entry] of entries.entries()) {
    const originalIndex = entryIndexes[parsedIndex] as number;
    const key = entry.identity.value.key;
    const first = seen.get(key);
    if (first !== undefined) {
      throw rootInvalid(operation, "codex", path, `Duplicate surviving marketplace entry ${key}`, {
        key,
        first: jsonPointer("plugins", first),
        duplicate: jsonPointer("plugins", originalIndex),
      }, undefined, jsonPointer("plugins", originalIndex));
    }
    seen.set(key, originalIndex);
  }

  const marketplace = NormalizedMarketplaceSchema.parse({
    name: claimAt(marketplaceName, "codex", path, jsonPointer("name"), rawName),
    entries,
    metadata: [...collectRootMetadata(root, "codex", path), ...nestedMetadata],
    sourceDocuments: [
      {
        location: sourceLocation("codex", path, jsonPointer()),
        declaration: root,
      },
    ],
  });
  return MarketplaceReadResultSchema.parse({ marketplace, diagnostics });
}

export function readCodexMarketplace(
  input: unknown,
  options?: MarketplaceReaderOptions,
): MarketplaceReadResult {
  return readMarketplaceInput(input, options, OPERATION);
}

export function readCodexMarketplaceJson(
  json: string,
  options?: MarketplaceReaderOptions,
): MarketplaceReadResult {
  const path = documentPath(options, CODEX_MARKETPLACE_PATH);
  const input = readJsonDocument(json, JSON_OPERATION, "codex", path);
  return readMarketplaceInput(input, options, JSON_OPERATION);
}
