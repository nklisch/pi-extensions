import { readFile } from "node:fs/promises";
import { resolveContainedExistingPath } from "./paths.js";
import type { InstalledPluginInfo } from "./types.js";

export interface PluginMetadata {
  readonly version?: string;
  readonly description?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Read the bundle's own release metadata, without requiring catalog duplication. */
export async function readPluginMetadata(root: string): Promise<PluginMetadata> {
  let version: string | undefined;
  let description: string | undefined;
  for (const relative of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"]) {
    try {
      // Catalog-controlled manifest links must not read files outside the bundle.
      const path = await resolveContainedExistingPath(root, relative, "plugin metadata");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const manifest = value as Record<string, unknown>;
      version ??= nonEmptyString(manifest.version);
      description ??= nonEmptyString(manifest.description);
    } catch {
      // Optional or malformed presentation metadata must not hide an otherwise
      // usable plugin. Runtime discovery reports malformed executable manifests.
    }
    if (version !== undefined && description !== undefined) break;
  }
  return Object.freeze({
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
  });
}

/** Old installs may have only a catalog receipt; never borrow a newer catalog version. */
export function installedPluginVersion(plugin: InstalledPluginInfo | undefined): string | undefined {
  return nonEmptyString(plugin?.version) ?? nonEmptyString(plugin?.receipt?.version);
}
