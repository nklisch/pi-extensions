import { z } from "zod";
import { PluginConfigurationDocumentSchemaV1, type PluginConfigurationDocument } from "../../domain/configured-values.js";
import { ContentDigestSchema, type ContentDigest } from "../../domain/content-manifest.js";
import type { PluginConfigurationRef } from "../../domain/state/references.js";

export const PluginConfigurationReadResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("found"), document: PluginConfigurationDocumentSchemaV1 }).strict(),
  z.object({ kind: z.literal("missing") }).strict(),
]).readonly();
export type PluginConfigurationReadResult = z.infer<typeof PluginConfigurationReadResultSchema>;

export const PluginConfigurationReplaceResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stored") }).strict(),
  z.object({ kind: z.literal("stale"), actualRevision: ContentDigestSchema.nullable() }).strict(),
]).readonly();
export type PluginConfigurationReplaceResult = z.infer<typeof PluginConfigurationReplaceResultSchema>;

export const PluginConfigurationRemoveResultSchema = z.enum(["removed", "stale", "missing"]);
export type PluginConfigurationRemoveResult = z.infer<typeof PluginConfigurationRemoveResultSchema>;

/**
 * CAS storage for non-sensitive configuration documents only.
 *
 * `read` is the authoritative mutation-boundary read: an adapter must
 * linearize it with its own replace operation so callers can reconcile a
 * response lost after durable commit without deleting an active locator.
 */
export interface PluginConfigurationStore {
  read(
    ref: PluginConfigurationRef,
    signal: AbortSignal,
  ): Promise<PluginConfigurationReadResult>;
  replace(
    request: Readonly<{
      expectedRevision: ContentDigest | null;
      document: PluginConfigurationDocument;
    }>,
    signal: AbortSignal,
  ): Promise<PluginConfigurationReplaceResult>;
  remove(
    request: Readonly<{
      ref: PluginConfigurationRef;
      expectedRevision: ContentDigest;
      confirmedSecretDeletion: true;
    }>,
    signal: AbortSignal,
  ): Promise<PluginConfigurationRemoveResult>;
}
