import { z } from "zod";
import { hashContent } from "./content-manifest.js";
import { PluginKeySchema, type PluginKey } from "./identity.js";
import {
  MarketplaceSourceSchema,
  SourceHashSchema,
  type MarketplaceSource,
  type PluginSource,
  type Sha256,
  type SourceHash,
} from "./source.js";
import {
  deriveMarketplaceSourceIdentity,
  derivePluginSourceIdentity,
} from "./update-policy.js";
import {
  MarketplaceSnapshotRecordSchema,
  type MarketplaceSnapshotRecord,
} from "./state/installed-state.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "./state/scope.js";

export const MarketplaceRegistrationIdSchema = z.string()
  .regex(/^marketplace-registration-v1:sha256:[0-9a-f]{64}$/)
  .brand<"MarketplaceRegistrationId">();
export type MarketplaceRegistrationId = z.infer<typeof MarketplaceRegistrationIdSchema>;

export const MarketplaceCandidateIdSchema = z.string()
  .regex(/^marketplace-candidate-v1:sha256:[0-9a-f]{64}$/)
  .brand<"MarketplaceCandidateId">();
export type MarketplaceCandidateId = z.infer<typeof MarketplaceCandidateIdSchema>;

export const MarketplaceSnapshotTokenSchema = z.string()
  .regex(/^marketplace-snapshot-v1:sha256:[0-9a-f]{64}$/)
  .brand<"MarketplaceSnapshotToken">();
export type MarketplaceSnapshotToken = z.infer<typeof MarketplaceSnapshotTokenSchema>;

export const MarketplaceCursorSchema = z.string()
  .regex(/^marketplace-cursor-v1:[A-Za-z0-9_-]+$/)
  .max(2048)
  .brand<"MarketplaceCursor">();
export type MarketplaceCursor = z.infer<typeof MarketplaceCursorSchema>;

export const MarketplaceScopeSelectionSchema = z.enum(["user", "project", "all-current"]);
export type MarketplaceScopeSelection = z.infer<typeof MarketplaceScopeSelectionSchema>;

const encoder = new TextEncoder();

function digestHex(value: unknown, sha256: Sha256): string {
  const digest = hashContent(encoder.encode(JSON.stringify(value)), sha256);
  return digest.slice("sha256:".length);
}

/** Scope and canonical declared source are the complete registration identity. */
export function deriveMarketplaceRegistrationId(input: Readonly<{
  scope: ScopeReference;
  source: MarketplaceSource;
}>, sha256: Sha256): MarketplaceRegistrationId {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const source = MarketplaceSourceSchema.parse(input.source);
  const sourceIdentity = deriveMarketplaceSourceIdentity(source, sha256);
  return MarketplaceRegistrationIdSchema.parse(
    `marketplace-registration-v1:sha256:${digestHex({
      version: "marketplace-registration-v1",
      scope,
      sourceIdentity,
    }, sha256)}`,
  );
}

/** Bind a public snapshot token to every selected immutable state fact. */
export function deriveMarketplaceSnapshotToken(input: Readonly<{
  scope: ScopeReference;
  registrationId: MarketplaceRegistrationId;
  snapshot: MarketplaceSnapshotRecord;
}>, sha256: Sha256): MarketplaceSnapshotToken {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const registrationId = MarketplaceRegistrationIdSchema.parse(input.registrationId);
  const snapshot = MarketplaceSnapshotRecordSchema.parse(input.snapshot);
  return MarketplaceSnapshotTokenSchema.parse(
    `marketplace-snapshot-v1:sha256:${digestHex({
      version: "marketplace-snapshot-v1",
      scope,
      registrationId,
      marketplace: snapshot.marketplace,
      resolvedSourceHash: snapshot.source.sourceHash,
      revision: snapshot.source.revision,
      contentDigest: snapshot.contentDigest,
      binding: snapshot.binding,
      contentRef: snapshot.contentRef,
    }, sha256)}`,
  );
}

/** Candidate identity is exact to one selected snapshot and one declaration. */
export function deriveMarketplaceCandidateId(input: Readonly<{
  snapshot: MarketplaceSnapshotToken;
  plugin: PluginKey;
  source: PluginSource;
}>, sha256: Sha256): MarketplaceCandidateId {
  const snapshot = MarketplaceSnapshotTokenSchema.parse(input.snapshot);
  const plugin = PluginKeySchema.parse(input.plugin);
  const sourceIdentity = derivePluginSourceIdentity(input.source, sha256);
  return MarketplaceCandidateIdSchema.parse(
    `marketplace-candidate-v1:sha256:${digestHex({
      version: "marketplace-candidate-v1",
      snapshot,
      plugin,
      sourceIdentity,
    }, sha256)}`,
  );
}

export type { MarketplaceSource, MarketplaceSnapshotRecord, PluginKey, PluginSource, ScopeReference, Sha256, SourceHash };
export { MarketplaceSourceSchema, SourceHashSchema };
