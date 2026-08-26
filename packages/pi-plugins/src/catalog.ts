import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { assertSafeName, assertSafeRelativePath } from "./paths.js";
import type {
  CatalogPlugin,
  MarketplaceCatalog,
  PluginDiagnostic,
  PluginSource,
} from "./types.js";

export const MARKETPLACE_CATALOG_PATHS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const;

export interface MarketplaceCatalogRead {
  readonly catalog: MarketplaceCatalog;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export class MarketplaceCatalogError extends Error {
  readonly diagnostics: readonly PluginDiagnostic[];

  constructor(message: string, diagnostics: readonly PluginDiagnostic[] = []) {
    super(message);
    this.name = "MarketplaceCatalogError";
    this.diagnostics = diagnostics;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sourceKey(source: PluginSource): string {
  return source.kind === "local"
    ? `local:${source.path.replace(/^\.\//u, "")}`
    : `${source.kind}:${source.url}:${source.path ?? ""}:${source.ref ?? ""}`;
}

function parsePluginSource(value: unknown, scope: string): PluginSource {
  if (typeof value === "string") {
    return { kind: "local", path: assertSafeRelativePath(value, `${scope}.source`) };
  }
  if (!record(value) || typeof value.source !== "string") {
    throw new Error(`${scope}.source must be a relative path or source object`);
  }
  if (value.source === "local") {
    if (!stringValue(value.path)) throw new Error(`${scope}.source.path must be a relative path`);
    return { kind: "local", path: assertSafeRelativePath(value.path, `${scope}.source.path`) };
  }
  if (value.source === "git" || value.source === "git-subdir") {
    if (!stringValue(value.url)) throw new Error(`${scope}.source.url must be a git URL`);
    const result: PluginSource = {
      kind: value.source,
      url: value.url,
      ...(value.path === undefined ? {} : { path: assertSafeRelativePath(String(value.path), `${scope}.source.path`) }),
      ...(value.ref === undefined ? {} : { ref: String(value.ref) }),
    };
    return result;
  }
  throw new Error(`${scope}.source type is unsupported: ${value.source}`);
}

function parsePlugin(value: unknown, index: number): CatalogPlugin {
  const scope = `plugins[${index}]`;
  if (typeof value === "string") {
    const path = assertSafeRelativePath(value, scope);
    const name = assertSafeName(basename(path), `${scope} name`);
    return Object.freeze({ name, source: Object.freeze({ kind: "local", path }), raw: value });
  }
  if (!record(value) || !stringValue(value.name)) throw new Error(`${scope}.name must be a string`);
  const name = assertSafeName(value.name, `${scope}.name`);
  const source = parsePluginSource(value.source, scope);
  return Object.freeze({
    name,
    source: Object.freeze(source),
    ...(stringValue(value.description) ? { description: value.description } : {}),
    ...(stringValue(value.version) ? { version: value.version } : {}),
    raw: Object.freeze({ ...value }),
  });
}

interface ParsedDocument {
  readonly name: string;
  readonly plugins: readonly CatalogPlugin[];
  readonly path: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

function parseDocument(value: unknown, path: string): ParsedDocument {
  if (!record(value)) throw new Error("catalog root must be an object");
  if (!stringValue(value.name)) throw new Error("catalog name must be a string");
  const name = assertSafeName(value.name, "catalog name");
  if (!Array.isArray(value.plugins)) throw new Error("catalog plugins must be an array");
  const plugins: CatalogPlugin[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  for (const [index, entry] of value.plugins.entries()) {
    try {
      plugins.push(parsePlugin(entry, index));
    } catch (error) {
      // One bad entry should not hide all of the useful catalog. The diagnostic
      // is returned to the caller, while root identity errors remain fatal.
      diagnostics.push({ scope: `${path}:plugins[${index}]`, message: error instanceof Error ? error.message : String(error), cause: error });
    }
  }
  return Object.freeze({ name, plugins: Object.freeze(plugins), path, diagnostics: Object.freeze(diagnostics) });
}

export function mergeMarketplaceCatalogs(documents: readonly ParsedDocumentLike[]): MarketplaceCatalogRead {
  if (documents.length === 0) throw new MarketplaceCatalogError("no marketplace catalog was found");
  const first = documents[0]!;
  const diagnostics: PluginDiagnostic[] = [];
  for (const document of documents.slice(1)) {
    if (document.name !== first.name) {
      throw new MarketplaceCatalogError(
        `marketplace catalog names disagree: ${first.name} and ${document.name}`,
        documents.map((item) => ({ scope: item.path, message: `declared marketplace name ${item.name}` })),
      );
    }
  }
  const plugins = new Map<string, CatalogPlugin>();
  for (const document of documents) {
    for (const plugin of document.plugins) {
      const previous = plugins.get(plugin.name);
      if (previous === undefined) {
        plugins.set(plugin.name, plugin);
      } else if (sourceKey(previous.source) !== sourceKey(plugin.source)) {
        diagnostics.push({
          scope: `${document.path}:${plugin.name}`,
          message: `duplicate plugin declaration conflicts with ${first.name}; using the first declaration`,
        });
      }
    }
  }
  return Object.freeze({
    catalog: Object.freeze({
      name: first.name,
      plugins: Object.freeze([...plugins.values()]),
      sources: Object.freeze(documents.map((document) => document.path)),
    }),
    diagnostics: Object.freeze([...documents.flatMap((document) => document.diagnostics ?? []), ...diagnostics]),
  });
}

export interface ParsedDocumentLike {
  readonly name: string;
  readonly plugins: readonly CatalogPlugin[];
  readonly path: string;
  readonly diagnostics?: readonly PluginDiagnostic[];
}

export async function readMarketplaceCatalog(checkout: string): Promise<MarketplaceCatalogRead> {
  const documents: ParsedDocument[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  for (const relativePath of MARKETPLACE_CATALOG_PATHS) {
    try {
      const text = await readFile(`${checkout}/${relativePath}`, "utf8");
      try {
        documents.push(parseDocument(JSON.parse(text) as unknown, relativePath));
      } catch (error) {
        diagnostics.push({ scope: relativePath, message: error instanceof Error ? error.message : String(error), cause: error });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({ scope: relativePath, message: error instanceof Error ? error.message : String(error), cause: error });
      }
    }
  }
  if (documents.length === 0) {
    throw new MarketplaceCatalogError("marketplace catalog is missing or invalid", diagnostics);
  }
  const merged = mergeMarketplaceCatalogs(documents);
  return Object.freeze({
    catalog: merged.catalog,
    diagnostics: Object.freeze([...diagnostics, ...merged.diagnostics]),
  });
}
