import type { ContentManifest } from "../../domain/content-manifest.js";
import type { ContentStoreCapabilities } from "./content-store.js";

/** Filesystem effects required by immutable publication, isolated for probing and tests. */
export interface ContentStorePlatform {
  probe(root: string): Promise<ContentStoreCapabilities>;
  /** Publish a complete hidden directory through one atomic, no-replace visibility edge. */
  publishDirectoryNoReplace(source: string, destination: string): Promise<"published" | "exists">;
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  sealReadOnly(root: string, manifest: ContentManifest): Promise<void>;
}
