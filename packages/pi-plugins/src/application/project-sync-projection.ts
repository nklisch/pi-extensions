import { canonicalJson, compareUtf8 } from "../domain/canonical-json.js";
import { hashContent, type ContentDigest } from "../domain/content-manifest.js";
import type { MarketplaceName } from "../domain/identity.js";
import { deriveMarketplaceRegistrationId, type MarketplaceRegistrationId } from "../domain/marketplace-registration.js";
import type { InstalledPluginRecord } from "../domain/state/installed-state.js";
import { PortableProjectDeclarationSchema, type PortablePluginConstraint, type PortableProjectDeclaration } from "../domain/state/portable-project-declaration.js";
import type { ProjectGenerationSnapshot } from "./state-contract.js";
import { derivePluginSourceIdentity } from "../domain/update-policy.js";
import type { Sha256 } from "../domain/source.js";

export type ProjectPluginSyncReadiness = Readonly<{
  plugin: InstalledPluginRecord["plugin"];
  trust: "ready" | "missing";
  trustFingerprint: ContentDigest;
  configuration: "ready" | "missing";
  configurationRevision: ContentDigest | null;
}>;

export type ProjectSyncReadinessSnapshot = Readonly<{
  capabilityDigest: ContentDigest;
  projectTrustFingerprint: ContentDigest;
  plugins: readonly ProjectPluginSyncReadiness[];
}>;

/** Exact readiness is hashed once and carried publicly only as an opaque digest. */
export function deriveProjectSyncReadinessDigest(
  readiness: ProjectSyncReadinessSnapshot,
  sha256: Sha256,
  includedPlugins?: ReadonlySet<string>,
): ContentDigest {
  const plugins = readiness.plugins
    .filter((entry) => includedPlugins === undefined || includedPlugins.has(entry.plugin))
    .sort((left, right) => compareUtf8(left.plugin, right.plugin));
  return hashContent(new TextEncoder().encode(`project-sync-readiness-v1\0${canonicalJson({
    capabilityDigest: readiness.capabilityDigest,
    projectTrustFingerprint: readiness.projectTrustFingerprint,
    plugins,
  })}`), sha256);
}

export type ProjectSyncMachineProjection = Readonly<{
  declaration: PortableProjectDeclaration;
  registrations: readonly Readonly<{ registrationId: MarketplaceRegistrationId; marketplace: MarketplaceName }>[];
  plugins: readonly Readonly<{
    plugin: InstalledPluginRecord["plugin"];
    selectedRevision: InstalledPluginRecord["selectedRevision"];
    pending: boolean;
    trust: "ready" | "missing";
    configuration: "ready" | "missing";
  }>[];
}>;

function matchingConstraint(record: InstalledPluginRecord, constraint: PortablePluginConstraint | undefined, sha256: Sha256): PortablePluginConstraint | undefined {
  if (constraint === undefined) return undefined;
  const selected = record.revisions.find((revision) => revision.revision === record.selectedRevision);
  if (selected === undefined) return undefined;
  if (constraint.kind === "declared-version") return selected.evidence.source.declaredVersion === constraint.value ? constraint : undefined;
  const identity = selected.evidence.source.pluginSourceIdentity;
  return identity !== undefined && derivePluginSourceIdentity(constraint.source, sha256) === identity ? constraint : undefined;
}

/** Project-only machine projection. User state is intentionally not accepted. */
export function projectProjectSyncMachineState(input: Readonly<{
  snapshot: ProjectGenerationSnapshot;
  readiness?: readonly ProjectPluginSyncReadiness[];
  existingFile?: PortableProjectDeclaration;
  sha256: Sha256;
}>): ProjectSyncMachineProjection {
  const scope = { kind: "project" as const, projectKey: input.snapshot.scope.projectKey };
  const readiness = new Map((input.readiness ?? []).map((entry) => [entry.plugin, entry]));
  const existing = new Map((input.existingFile?.plugins ?? []).map((entry) => [entry.plugin, entry]));
  const marketplaces = input.snapshot.project.marketplaceUpdates.map((record) => ({ marketplace: record.marketplace, source: record.source }))
    .sort((left, right) => compareUtf8(left.marketplace, right.marketplace));
  const plugins = input.snapshot.project.plugins.map((record) => {
    const constraint = matchingConstraint(record, existing.get(record.plugin)?.constraint, input.sha256);
    return { plugin: record.plugin, enabled: record.activation === "enabled", ...(constraint === undefined ? {} : { constraint }) };
  }).sort((left, right) => compareUtf8(left.plugin, right.plugin));
  const declaration = PortableProjectDeclarationSchema.parse({ schemaVersion: 1, marketplaces, plugins });
  return Object.freeze({
    declaration,
    registrations: Object.freeze(input.snapshot.project.marketplaceUpdates.map((record) => ({ registrationId: deriveMarketplaceRegistrationId({ scope, source: record.source }, input.sha256), marketplace: record.marketplace })).sort((left, right) => compareUtf8(left.marketplace, right.marketplace))),
    plugins: Object.freeze(input.snapshot.project.plugins.map((record) => ({
      plugin: record.plugin,
      selectedRevision: record.selectedRevision,
      pending: record.pendingTransition !== undefined,
      trust: readiness.get(record.plugin)?.trust ?? "ready",
      configuration: readiness.get(record.plugin)?.configuration ?? "ready",
    })).sort((left, right) => compareUtf8(left.plugin, right.plugin))),
  });
}
