import { z } from "zod";
import { MarketplaceReadResultSchema, type MarketplaceReadResult } from "../domain/marketplace.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { HostPrecedence } from "../domain/host-precedence.js";

export const MarketplaceInspectionLimitsSchema = z.object({
  maxCatalogBytes: z.number().int().positive().max(1024 * 1024).default(1024 * 1024),
}).strict().readonly();
export type MarketplaceInspectionLimits = z.infer<typeof MarketplaceInspectionLimitsSchema>;

export type MarketplaceCatalogReader = (input: unknown, options?: Readonly<{ path?: string }>) => MarketplaceReadResult;
export type MarketplaceCatalogMerger = (
  inputs: readonly [{ nativeHost: "claude" | "codex"; result: MarketplaceReadResult }, ...{ nativeHost: "claude" | "codex"; result: MarketplaceReadResult }[]],
  options?: Readonly<{ hostPrecedence?: HostPrecedence }>,
) => MarketplaceReadResult;

export type MarketplaceInspectionReaders = Readonly<{
  claude?: MarketplaceCatalogReader;
  codex?: MarketplaceCatalogReader;
  merge: MarketplaceCatalogMerger;
}>;

export type MaterializedMarketplaceInspectionInput = Readonly<{
  root: string;
  source: unknown;
  content: unknown;
  binding: ContentDigest;
}>;

export const MarketplaceInspectionResultSchema = MarketplaceReadResultSchema;
export type MarketplaceInspectionResult = MarketplaceReadResult;

export interface MarketplaceInspectionService {
  inspect(materialized: MaterializedMarketplaceInspectionInput, signal: AbortSignal): Promise<MarketplaceInspectionResult>;
}
