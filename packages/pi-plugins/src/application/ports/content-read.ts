import type { ContentManifestEntry } from "../../domain/content-manifest.js";

export type ManifestFileEntry = Extract<ContentManifestEntry, { kind: "file" }>;

/**
 * An exact file handoff. The caller supplies the verified root and the
 * manifest entry; an adapter must not reinterpret this as an arbitrary path.
 */
export type ManifestFileRef = Readonly<{
  root: string;
  entry: ManifestFileEntry;
}>;

/**
 * The sole content I/O port used by bundle inspection. Listing, globbing, and
 * root-relative arbitrary reads are intentionally absent from this contract.
 */
export interface ContentReadPort {
  readFile(
    file: ManifestFileRef,
    limitBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}
