import { z } from "zod";
import type { MaterializedPlugin } from "./source-materialization.js";
import {
  ContentDigestSchema,
  ContentManifestSchema,
} from "../domain/content-manifest.js";
import {
  NormalizedMarketplaceEntrySchema,
} from "../domain/marketplace.js";
import {
  NormalizedPluginSchema,
} from "../domain/plugin.js";
import { ReadResultSchema } from "../domain/errors.js";
import { ResolvedPluginSourceSchema } from "../domain/source.js";

/** Hard limits used by bounded document readers at the bundle boundary. */
export const BundleDocumentLimits = Object.freeze({
  manifestBytes: 256 * 1024,
  hooksBytes: 1024 * 1024,
  mcpBytes: 1024 * 1024,
  skillBytes: 1024 * 1024,
  frontmatterBytes: 16 * 1024,
  frontmatterLines: 256,
  frontmatterDepth: 8,
  frontmatterNodes: 256,
  frontmatterScalarBytes: 8 * 1024,
} as const);

export const BundleDocumentLimitsSchema = z
  .object({
    manifestBytes: z.number().int().positive().safe(),
    hooksBytes: z.number().int().positive().safe(),
    mcpBytes: z.number().int().positive().safe(),
    skillBytes: z.number().int().positive().safe(),
    frontmatterBytes: z.number().int().positive().safe(),
    frontmatterLines: z.number().int().positive().safe(),
    frontmatterDepth: z.number().int().positive().safe(),
    frontmatterNodes: z.number().int().positive().safe(),
    frontmatterScalarBytes: z.number().int().positive().safe(),
  })
  .strict()
  .readonly();
export type BundleDocumentLimits = z.infer<typeof BundleDocumentLimitsSchema>;
export type BundleDocumentLimitsContract = BundleDocumentLimits;

/**
 * Keep the materialized handoff schema local to this application boundary.
 * MaterializedPlugin is already the source-materialization port's inferred
 * public type; this schema makes the inspection input fail closed before any
 * reader or content adapter is called.
 */
const MaterializedPluginSchema = z
  .object({
    root: z.string().min(1),
    source: ResolvedPluginSourceSchema,
    content: ContentManifestSchema,
    binding: ContentDigestSchema,
  })
  .strict()
  .readonly();

export const BundleInspectionInputSchema = z
  .object({
    entry: NormalizedMarketplaceEntrySchema,
    materialized: MaterializedPluginSchema,
  })
  .strict()
  .readonly();

export type BundleInspectionInput = Readonly<{
  entry: z.infer<typeof NormalizedMarketplaceEntrySchema>;
  materialized: MaterializedPlugin;
}>;

export const BundleInspectionResultSchema = ReadResultSchema(NormalizedPluginSchema);
export type BundleInspectionResult = z.infer<typeof BundleInspectionResultSchema>;
