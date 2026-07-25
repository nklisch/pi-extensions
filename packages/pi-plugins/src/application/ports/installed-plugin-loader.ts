import { z } from "zod";
import {
  ContentDigestSchema,
  ContentManifestSchema,
  type ContentDigest,
  type ContentManifest,
} from "../../domain/content-manifest.js";
import {
  CompatibilityReportSchema,
  type CompatibilityReport,
} from "../../domain/compatibility.js";
import { MarketplaceInstallationPolicySchema } from "../../domain/marketplace.js";
import {
  NormalizedPluginSchema,
  type NormalizedPlugin,
} from "../../domain/plugin.js";
import {
  InstalledRevisionRecordSchema,
  type InstalledRevisionRecord,
} from "../../domain/state/installed-state.js";
import {
  ScopeContextSchema,
  type ScopeContext,
} from "../../domain/state/scope.js";
import {
  ResolvedMarketplaceSourceSchema,
  type ResolvedMarketplaceSource,
} from "../../domain/source.js";

/** Complete, normalized evidence reconstructed from an installed revision. */
export const LoadedInstalledPluginSchema = z.object({
  plugin: NormalizedPluginSchema,
  compatibility: CompatibilityReportSchema,
  marketplaceSource: ResolvedMarketplaceSourceSchema,
  content: ContentManifestSchema,
  binding: ContentDigestSchema,
  // The marketplace entry's installation policy at install time. Runtime
  // re-assessment must use the same policy input or its report diverges from
  // the install-time expectation digest; capability availability is re-probed
  // live so runtime drift still fails closed.
  installationPolicy: MarketplaceInstallationPolicySchema.optional(),
}).strict().readonly();
export type LoadedInstalledPlugin = z.infer<typeof LoadedInstalledPluginSchema>;

export const InstalledPluginLoaderRequestSchema = z.object({
  scope: ScopeContextSchema,
  revision: InstalledRevisionRecordSchema,
}).strict().readonly();
export type InstalledPluginLoaderRequest = z.infer<typeof InstalledPluginLoaderRequestSchema>;

/**
 * Enable/rebuild is intentionally the only inward operation that can recover
 * declarations from lossy installed state. The adapter must use immutable
 * content and return the same complete evidence used by installation.
 */
export interface InstalledPluginLoader {
  load(request: InstalledPluginLoaderRequest, signal: AbortSignal): Promise<LoadedInstalledPlugin>;
}

export function verifyLoadedInstalledPlugin(input: unknown): LoadedInstalledPlugin {
  return LoadedInstalledPluginSchema.parse(input);
}

export type { ContentDigest, ContentManifest, InstalledRevisionRecord, NormalizedPlugin, CompatibilityReport, ResolvedMarketplaceSource, ScopeContext };
