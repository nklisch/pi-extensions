import type {
  MarketplaceSource,
  PluginSource,
  ResolvedMarketplaceSource,
  ResolvedPluginSource,
  Sha256,
} from "../../domain/source.js";
import type {
  ContentManifest,
  ContentDigest,
} from "../../domain/content-manifest.js";

export const DEFAULT_MATERIALIZATION_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxPathBytes: 1_024,
  maxSegmentBytes: 255,
  maxTotalPathBytes: 16 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxArchiveBytes: 128 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxPackumentBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
});
export type MaterializationLimits = Readonly<{
  [K in keyof typeof DEFAULT_MATERIALIZATION_LIMITS]: number;
}>;

/** A caller-owned, pre-created empty directory. No adapter may select it. */
export type StagingSlot = Readonly<{ root: string }>;

export type ContentEntry =
  | Readonly<{ kind: "directory"; path: string; mode: number }>
  | Readonly<{ kind: "file"; path: string; mode: number; body: AsyncIterable<Uint8Array> }>
  | Readonly<{ kind: "symlink"; path: string; mode: number; target: string }>
  | Readonly<{ kind: "hardlink"; path: string; mode: number; target: string }>;

export interface SecureContentSession {
  add(entry: ContentEntry, signal: AbortSignal): Promise<void>;
  finalize(signal: AbortSignal): Promise<Readonly<{ root: string; content: ContentManifest }>>;
  abort(cause?: unknown): Promise<void>;
  /** The only scratch root adapters may use. */
  readonly workRoot: string;
  /** The writer's canonical content root, used to reject forged handoffs. */
  readonly contentRoot: string;
}

export interface SecureContentWriterFactory {
  /** Canonicalize and validate the caller-owned slot before opening it. */
  canonicalize(slot: StagingSlot): Promise<StagingSlot>;
  open(slot: StagingSlot, limits?: Partial<MaterializationLimits>): Promise<SecureContentSession>;
}

/** The only port allowed to copy a marketplace-relative source tree. */
export interface MarketplacePathAcquirer {
  materialize(
    source: Extract<PluginSource, { kind: "marketplace-path" }>,
    context: Readonly<{
      root: string;
      source: ResolvedMarketplaceSource;
      contentRootDigest: ContentDigest;
      content: ContentManifest;
      binding: ContentDigest;
    }>,
    sink: SecureContentSession,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface GitSourceAcquirer {
  materializeMarketplace(
    source: MarketplaceSource,
    sink: SecureContentSession,
    signal: AbortSignal,
  ): Promise<ResolvedMarketplaceSource>;
  materializePlugin(
    source: Extract<PluginSource, { kind: "git" | "git-subdir" }>,
    sink: SecureContentSession,
    signal: AbortSignal,
  ): Promise<ResolvedPluginSource>;
}

export interface NpmSourceAcquirer {
  materialize(
    source: Extract<PluginSource, { kind: "npm" }>,
    sink: SecureContentSession,
    signal: AbortSignal,
  ): Promise<ResolvedPluginSource>;
}

export type SourceMaterializationPortDependencies = Readonly<{
  git: GitSourceAcquirer;
  npm: NpmSourceAcquirer;
  content: SecureContentWriterFactory;
  sha256: Sha256;
  marketplace?: MarketplacePathAcquirer;
}>;
