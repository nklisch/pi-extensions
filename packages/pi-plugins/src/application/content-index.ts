import {
  ContentManifestSchema,
  normalizeContentPath,
  type ContentManifest,
  type ContentManifestEntry,
} from "../domain/content-manifest.js";
import { DomainContractError } from "../domain/domain-error.js";
import { ErrorCodeRegistry } from "../domain/error-contract.js";
import { ProvenanceSchema, type Provenance } from "../domain/provenance.js";

export type ManifestFileEntry = Extract<ContentManifestEntry, { kind: "file" }>;
export type ManifestDirectoryEntry = Extract<ContentManifestEntry, { kind: "directory" }>;

function normalizeQuery(path: string): string | undefined {
  try {
    // Foreign manifests spell explicit paths as `./foo`, while the verified
    // content manifest stores canonical `foo`. Normalize that one safe prefix
    // without admitting dot segments, traversal, or platform separators.
    const declaredPath = path.startsWith("./") ? path.slice(2) : path;
    return normalizeContentPath(declaredPath);
  } catch {
    return undefined;
  }
}

function normalizeDirectoryQuery(path: string): string | undefined {
  if (path === "") return "";
  return normalizeQuery(path);
}

function invalidTarget(
  operation: string,
  path: string,
  expected: "file" | "directory",
  provenance: Provenance,
  actual?: ContentManifestEntry["kind"],
): DomainContractError {
  const location = ProvenanceSchema.parse(provenance).location;
  const actualDetail = actual === undefined ? {} : { actual };
  return new DomainContractError({
    code: ErrorCodeRegistry.pathContainmentFailed,
    operation,
    message: actual === undefined
      ? `explicit ${expected} target is not present in the content manifest: ${path}`
      : `explicit ${expected} target has manifest kind ${actual}: ${path}`,
    location,
    details: { path, expected, ...actualDetail },
  });
}

/** A finite, validated view over the supplied content manifest. */
export interface ContentIndex {
  readonly manifest: ContentManifest;
  get(path: string): ContentManifestEntry | undefined;
  requireFile(path: string, provenance: Provenance): ManifestFileEntry;
  requireDirectory(path: string, provenance: Provenance): ManifestDirectoryEntry;
  filesBelow(directory: string, basename?: string): readonly ManifestFileEntry[];
}

/**
 * Validate the manifest once, then answer all discovery questions from its
 * entries. This deliberately has no filesystem dependency and cannot discover
 * a path that was not present in the materialization handoff.
 */
export function createContentIndex(manifest: ContentManifest): ContentIndex {
  const validated = ContentManifestSchema.parse(manifest);
  const entries = new Map<string, ContentManifestEntry>();
  for (const entry of validated.entries) {
    // ContentManifestSchema already enforces canonical paths and collisions.
    entries.set(entry.path, entry);
  }

  const index: ContentIndex = {
    manifest: validated,
    get(path: string): ContentManifestEntry | undefined {
      const normalized = normalizeQuery(path);
      return normalized === undefined ? undefined : entries.get(normalized);
    },

    requireFile(path: string, provenance: Provenance): ManifestFileEntry {
      const normalized = normalizeQuery(path);
      const entry = normalized === undefined ? undefined : entries.get(normalized);
      if (entry?.kind !== "file") {
        throw invalidTarget(
          "contentIndex.requireFile",
          path,
          "file",
          provenance,
          entry?.kind,
        );
      }
      return entry;
    },

    requireDirectory(path: string, provenance: Provenance): ManifestDirectoryEntry {
      const normalized = normalizeQuery(path);
      const entry = normalized === undefined ? undefined : entries.get(normalized);
      if (entry?.kind !== "directory") {
        throw invalidTarget(
          "contentIndex.requireDirectory",
          path,
          "directory",
          provenance,
          entry?.kind,
        );
      }
      return entry;
    },

    filesBelow(directory: string, basename?: string): readonly ManifestFileEntry[] {
      const normalizedDirectory = normalizeDirectoryQuery(directory);
      if (normalizedDirectory === undefined) return [];
      const prefix = normalizedDirectory === "" ? "" : `${normalizedDirectory}/`;
      return validated.entries.filter((entry): entry is ManifestFileEntry => {
        if (entry.kind !== "file") return false;
        if (prefix !== "" && !entry.path.startsWith(prefix)) return false;
        if (basename === undefined) return true;
        return entry.path.slice(prefix.length).split("/").at(-1) === basename;
      });
    },
  };

  return Object.freeze(index);
}
