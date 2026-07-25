import { z } from "zod";
import {
  ContentDigestSchema,
  type ContentDigest,
} from "../content-manifest.js";
import {
  ProjectIdentitySchema,
  ProjectKeySchema,
  ScopeContextSchema,
  createScopeContext,
  type ProjectIdentity,
  type ProjectKey,
  type ScopeContext,
} from "./scope.js";
import {
  InstalledPluginRecordSchema,
  MarketplaceSnapshotRecordSchema,
  createInstalledPluginRecord,
  createMarketplaceSnapshotRecord,
  type InstalledPluginRecord,
  type MarketplaceSnapshotRecord,
} from "./installed-state.js";
import { PluginKeySchema } from "../identity.js";
import { GenerationSchema } from "./config-state.js";
export { GenerationSchema } from "./config-state.js";
export type { Generation } from "./config-state.js";
import type { Sha256 } from "../source.js";
import {
  MarketplaceRegistrationRecordSchema,
  MarketplaceUpdateRecordSchema,
  UpdateApplicationModeSchema,
  UpdateSchedulerLeaseSchema,
} from "../update-policy.js";
import { serializeMarketplaceSource } from "../source.js";

/**
 * Digest preimage used for a project-local document whose portable declaration
 * has never been synchronized. Fresh scopes and version cut-overs share it.
 */
export const UNSYNCHRONIZED_PORTABLE_INTENT = "portable-project-intent-unsynchronized-v1";

/**
 * Machine-local state for one verified project declaration and identity. This
 * is the only project-local schema; the literal version remains so a future
 * clean cut-over can recognize stale documents, which the state codec
 * reinitializes instead of migrating.
 */
export const ProjectLocalStateDocumentSchema = z.object({
  schemaVersion: z.literal(4),
  generation: GenerationSchema,
  projectKey: ProjectKeySchema,
  identity: ProjectIdentitySchema,
  declarationDigest: ContentDigestSchema,
  scope: z.object({
    application: UpdateApplicationModeSchema.optional(),
    schedulerLease: UpdateSchedulerLeaseSchema.optional(),
  }).strict().readonly().default(() => ({})),
  marketplaces: z.array(MarketplaceSnapshotRecordSchema).readonly(),
  plugins: z.array(InstalledPluginRecordSchema).readonly(),
  marketplaceUpdates: z.array(MarketplaceRegistrationRecordSchema).readonly(),
}).strict().readonly().superRefine((document, context) => {
  const snapshots = new Set(document.marketplaces.map((record) => record.marketplace));
  const names = new Set<string>();
  const sources = new Set<string>();
  for (const [index, record] of document.marketplaceUpdates.entries()) {
    if (record.source.kind === "local-git") context.addIssue({ code: "custom", path: ["marketplaceUpdates", index, "source"], message: "project marketplace sources must be portable" });
    if (!snapshots.has(record.marketplace)) context.addIssue({ code: "custom", path: ["marketplaceUpdates", index, "marketplace"], message: "registration must have a matching marketplace snapshot" });
    if (names.has(record.marketplace)) context.addIssue({ code: "custom", path: ["marketplaceUpdates", index, "marketplace"], message: "duplicate marketplace registration" });
    names.add(record.marketplace);
    const source = serializeMarketplaceSource(record.source);
    if (sources.has(source)) context.addIssue({ code: "custom", path: ["marketplaceUpdates", index, "source"], message: "duplicate marketplace source" });
    sources.add(source);
  }
  const pluginKeys = new Set<string>();
  for (const [index, plugin] of document.plugins.entries()) {
    if (pluginKeys.has(plugin.plugin)) context.addIssue({ code: "custom", path: ["plugins", index, "plugin"], message: "duplicate installed plugin" });
    pluginKeys.add(plugin.plugin);
    // Plugin scope is independent from the host-global marketplace registry;
    // a project plugin does not require a duplicated local snapshot.
  }
});
export type ProjectLocalStateDocument = z.infer<typeof ProjectLocalStateDocumentSchema>;

const ProjectLocalStateInputSchema = z
  .object({
    schemaVersion: z.literal(4).optional(),
    generation: GenerationSchema,
    projectKey: ProjectKeySchema,
    identity: ProjectIdentitySchema,
    declarationDigest: ContentDigestSchema,
    marketplaces: z.array(z.unknown()),
    plugins: z.array(z.unknown()),
    marketplaceUpdates: z.array(z.unknown()).optional(),
    scope: z.unknown().optional(),
  })
  .strict();

function sameJsonIdentity(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => sameJsonIdentity(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJsonIdentity(leftRecord[key], rightRecord[key]),
  );
}

function projectScopeReference(context: Extract<ScopeContext, { kind: "project" }>): {
  readonly kind: "project";
  readonly projectKey: ProjectKey;
} {
  return { kind: "project", projectKey: context.projectKey };
}

/**
 * Construct a project-local document only from a scope context whose key is
 * recomputed against the injected hash. The canonical root is retained as
 * identity evidence in this machine-local document; nested plugin references
 * receive only the path-free project key.
 */
function normalizeProjectLocalCore(
  input: unknown,
  context: Extract<ScopeContext, { kind: "project" }>,
  sha256: Sha256,
) {
  const value = ProjectLocalStateInputSchema.parse(input);
  const verifiedContext = createScopeContext(ScopeContextSchema.parse(context), sha256);
  if (verifiedContext.kind !== "project") throw new Error("project-local state requires project scope context");
  if (value.projectKey !== verifiedContext.projectKey) throw new Error("project-local state project key does not match scope context");
  if (!sameJsonIdentity(value.identity, verifiedContext.identity)) throw new Error("project-local state identity does not match scope context");

  const scope = projectScopeReference(verifiedContext);
  return {
    value,
    core: {
      generation: value.generation,
      projectKey: verifiedContext.projectKey,
      identity: verifiedContext.identity,
      declarationDigest: value.declarationDigest,
      marketplaces: value.marketplaces.map((marketplace) => createMarketplaceSnapshotRecord(marketplace, sha256)),
      plugins: value.plugins.map((plugin) => createInstalledPluginRecord({ ...plugin as Record<string, unknown>, scope }, sha256)),
    },
  };
}

/** Build and verify the current project-local document envelope. */
export function createProjectLocalStateDocument(
  input: unknown,
  context: Extract<ScopeContext, { kind: "project" }>,
  sha256: Sha256,
): ProjectLocalStateDocument {
  const value = ProjectLocalStateInputSchema.parse(input);
  // Project plugins resolve through the host-global marketplace registry, so
  // the constructor deliberately applies no plugin-to-snapshot cross-check.
  const { core } = normalizeProjectLocalCore(value, context, sha256);
  return ProjectLocalStateDocumentSchema.parse({
    ...core,
    schemaVersion: 4,
    scope: value.scope ?? {},
    marketplaceUpdates: (value.marketplaceUpdates ?? []).map((record) => MarketplaceUpdateRecordSchema.parse(record)),
  });
}

export type ProjectPluginRecordCollectionDecode = Readonly<{
  records: readonly InstalledPluginRecord[];
  quarantined: readonly {
    index: number;
    recordKey?: string;
    code: "RECORD_INVALID" | "RECORD_DUPLICATE";
  }[];
}>;

function projectCandidateKey(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const key = (input as { readonly plugin?: unknown }).plugin;
  return typeof key === "string" && PluginKeySchema.safeParse(key).success ? key : undefined;
}

/** Project-local variant of plugin-granular corruption isolation. */
export function decodeProjectPlugins(
  input: unknown,
  context: Extract<ScopeContext, { kind: "project" }>,
  sha256: Sha256,
): ProjectPluginRecordCollectionDecode {
  if (!Array.isArray(input)) throw new Error("project plugin collection must be an array");
  const valid: Array<{ index: number; key: string; record: InstalledPluginRecord }> = [];
  const quarantined: ProjectPluginRecordCollectionDecode["quarantined"][number][] = [];
  const verifiedContext = createScopeContext(ScopeContextSchema.parse(context), sha256);
  if (verifiedContext.kind !== "project") {
    throw new Error("project plugin collection requires project scope context");
  }
  const scope = projectScopeReference(verifiedContext);
  const counts = new Map<string, number>();
  for (const candidate of input) {
    const key = projectCandidateKey(candidate);
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const [index, candidate] of input.entries()) {
    const key = projectCandidateKey(candidate);
    if (key === undefined) {
      throw new Error(`project plugin record identity is missing or invalid at index ${index}`);
    }
    try {
      const record = createInstalledPluginRecord({
        ...candidate as Record<string, unknown>,
        scope,
      }, sha256);
      valid.push({ index, key, record });
    } catch {
      quarantined.push({ index, recordKey: key, code: "RECORD_INVALID" });
    }
  }

  const records: InstalledPluginRecord[] = [];
  for (const candidate of valid) {
    if (counts.get(candidate.key)! > 1) {
      quarantined.push({ index: candidate.index, recordKey: candidate.key, code: "RECORD_DUPLICATE" });
    } else {
      records.push(candidate.record);
    }
  }
  return {
    records,
    quarantined: quarantined.sort((left, right) => left.index - right.index),
  };
}

export type { ProjectIdentity, ProjectKey, ScopeContext, ContentDigest, MarketplaceSnapshotRecord };
export type { InstalledPluginRecord };
