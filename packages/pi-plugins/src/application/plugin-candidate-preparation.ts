import { z } from "zod";
import {
  NormalizedMarketplaceEntrySchema,
  type NormalizedMarketplaceEntry,
} from "../domain/marketplace.js";
import {
  PluginKeySchema,
  type PluginKey,
} from "../domain/identity.js";
import {
  createScopeContext,
  toScopeReference,
  type ScopeContext,
} from "../domain/state/scope.js";
import {
  InstalledPluginRecordSchema,
  createInstalledPluginRecord,
  createInstalledRevisionRecord,
  type InstalledPluginRecord,
  type InstalledRevisionRecord,
} from "../domain/state/installed-state.js";
import type { TrustStateRecord } from "../domain/state/trust-state.js";
import {
  CompatibilityReportSchema,
  type CompatibilityReport,
} from "../domain/compatibility.js";
import {
  NormalizedPluginSchema,
  type NormalizedPlugin,
} from "../domain/plugin.js";
import {
  PluginSourceSchema,
  ResolvedMarketplaceSourceSchema,
  type ResolvedMarketplaceSource,
  type Sha256,
} from "../domain/source.js";
import {
  createTrustCandidate,
  type TrustCandidate,
} from "../domain/trust-policy.js";
import {
  withResolvedPluginConfiguration,
  withAuthorizedPluginConfiguration,
  ConfigurationResolutionError,
} from "./configuration-resolver.js";
import { projectSafeComponents } from "./native-inspection-disclosure.js";
import { deriveTrustedInstallConsentDisclosureDigest } from "./trusted-install-identifiers.js";
import type { ConfigurationPathContext } from "./ports/configuration-path.js";
import type { PluginConfigurationStore } from "./ports/plugin-configuration-store.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";
import type { ProjectRootAuthorityPort } from "./ports/project-root-authority.js";
import type { SecretStore } from "./ports/secret-store.js";
import type { ConfigurationPathPort } from "./ports/configuration-path.js";
import type { ContentStorePort, StagingAllocation, VerifiedPromotionPlan } from "./ports/content-store.js";
import {
  CandidateContentCleanupError,
  type CandidateContentCleanupRecovery,
  type CandidateContentLease,
} from "./ports/candidate-content-lease.js";
import type { PreparedLifecycleCandidateBinding } from "./trusted-install-contract.js";
import { digestConfigurationDescriptors } from "../domain/configured-values.js";
import { digestCompatibilityReport } from "./ports/runtime-projection.js";
import type { PluginMaterializer, SourceContext } from "./source-materialization.js";
import type { PluginInspectionService } from "./inspection-service.js";
import type { CompatibilityService } from "./compatibility-service.js";
import { createPromotionPlan } from "./content-promotion.js";
import { createInstalledRevisionDescriptor } from "./installed-revision-descriptor.js";
import {
  createActiveProjectionExpectation,
  createInactiveProjectionExpectation,
  createPluginRuntimeProjection,
  verifyProjectionExpectation,
  type ProjectionExpectation,
  type RuntimeProjectionPort,
} from "./ports/runtime-projection.js";
import type { InstalledPluginLoader, LoadedInstalledPlugin } from "./ports/installed-plugin-loader.js";
import type { AutomaticUpdateAuthorizationEvidence } from "./automatic-update-authorization.js";
import { deriveMarketplaceSourceIdentity, derivePluginSourceIdentity } from "../domain/update-policy.js";

export const CandidatePreparationCodeRegistry = {
  incompatible: { tag: "INCOMPATIBLE" },
  untrusted: { tag: "UNTRUSTED" },
  unconfigured: { tag: "UNCONFIGURED" },
  projectionFailed: { tag: "PROJECTION_FAILED" },
  aborted: { tag: "ABORTED" },
  malformed: { tag: "MALFORMED" },
  availableRevisionChanged: { tag: "AVAILABLE_REVISION_CHANGED" },
  configurationStale: { tag: "CONFIGURATION_STALE" },
} as const;
export type CandidatePreparationCode = (typeof CandidatePreparationCodeRegistry)[keyof typeof CandidatePreparationCodeRegistry]["tag"];
const candidatePreparationCodes = Object.values(CandidatePreparationCodeRegistry).map((entry) => entry.tag) as [
  CandidatePreparationCode,
  ...CandidatePreparationCode[],
];
export const CandidatePreparationCodeSchema = z.enum(candidatePreparationCodes);

export const PluginCandidatePreparationDependenciesSchema = z.object({}).passthrough();

export type PluginCandidatePreparationDependencies = Readonly<{
  content: ContentStorePort;
  materializer: PluginMaterializer;
  inspector: PluginInspectionService;
  compatibility: CompatibilityService;
  installed: InstalledPluginLoader;
  projections: RuntimeProjectionPort;
  projectTrust: ProjectTrustPort;
  projectRoots: ProjectRootAuthorityPort;
  configurations: PluginConfigurationStore;
  secrets: SecretStore;
  paths: ConfigurationPathPort;
  sha256: Sha256;
}>;

export type PluginCandidatePreparationRequest = Readonly<{
  operation: "install" | "update";
  scope: ScopeContext;
  entry: NormalizedMarketplaceEntry;
  marketplaceSource: ResolvedMarketplaceSource;
  sourceContext: SourceContext;
  trustRecords: readonly TrustStateRecord[];
  configurationPathContext: ConfigurationPathContext;
  existing?: InstalledPluginRecord;
  expectedRevision?: import("../domain/content-manifest.js").ContentDigest;
  expectedConfigurationRevision?: import("../domain/content-manifest.js").ContentDigest;
  candidateLease?: CandidateContentLease;
  expectedBinding?: PreparedLifecycleCandidateBinding;
  automaticAuthorization?: AutomaticUpdateAuthorizationEvidence;
}>;

export type EnableCandidatePreparationRequest = Readonly<{
  operation: "enable";
  scope: ScopeContext;
  installed: InstalledPluginRecord;
  trustRecords: readonly TrustStateRecord[];
  configurationPathContext: ConfigurationPathContext;
  expectedConfigurationRevision?: import("../domain/content-manifest.js").ContentDigest;
}>;

export type PreparedPluginCandidate = Readonly<{
  operation: "install" | "update" | "enable";
  scope: ScopeContext;
  plugin: PluginKey;
  normalized: NormalizedPlugin;
  compatibility: CompatibilityReport;
  revision: InstalledRevisionRecord;
  record: InstalledPluginRecord;
  projection: Extract<ProjectionExpectation, { kind: "active" }>;
  trust: TrustCandidate;
  promotion?: VerifiedPromotionPlan;
  allocation?: StagingAllocation;
}>;

export type CandidatePreparationResult =
  | Readonly<{ kind: "prepared"; candidate: PreparedPluginCandidate }>
  | Readonly<{ kind: "rejected"; code: CandidatePreparationCode }>;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function abortIfRequested(signal: AbortSignal): void {
  signal.throwIfAborted();
}

class ProjectionPreparationError extends Error {
  constructor() {
    super("runtime projection preparation failed");
    this.name = "ProjectionPreparationError";
  }
}

function mapFailure(error: unknown, phase: "materialize" | "inspect" | "compatibility" | "trust" | "configuration" | "projection"): CandidatePreparationCode {
  if (error instanceof ProjectionPreparationError) return "PROJECTION_FAILED";
  if (error instanceof ConfigurationResolutionError) {
    if (error.code === "CONFIGURATION_STALE") return "CONFIGURATION_STALE";
    return error.code === "PROJECT_UNTRUSTED" || error.code === "TRUST_ABSENT" || error.code === "TRUST_REVOKED" || error.code === "TRUST_EVIDENCE_INVALID"
      ? "UNTRUSTED"
      : "UNCONFIGURED";
  }
  if (phase === "trust") return "UNTRUSTED";
  if (phase === "projection") return "PROJECTION_FAILED";
  if (phase === "compatibility" || phase === "inspect") return "INCOMPATIBLE";
  if (phase === "materialize") return "MALFORMED";
  return "MALFORMED";
}

function allocationCleanupRecovery(
  dependencies: PluginCandidatePreparationDependencies,
  allocation: StagingAllocation,
): CandidateContentCleanupRecovery {
  return Object.freeze({
    retry: () => dependencies.content.discardStaging(allocation, new AbortController().signal),
  }) as CandidateContentCleanupRecovery;
}

async function discardOwned(
  dependencies: PluginCandidatePreparationDependencies,
  allocation: StagingAllocation | undefined,
  _signal: AbortSignal,
): Promise<void> {
  if (allocation === undefined) return;
  const recovery = allocationCleanupRecovery(dependencies, allocation);
  try {
    // Cleanup is deliberate even after caller cancellation; the staging
    // capability is owned by this preparation and carries no user data.
    await recovery.retry();
  } catch (error) {
    throw new CandidateContentCleanupError(recovery, { cause: error });
  }
}

async function prepareProjection(
  dependencies: PluginCandidatePreparationDependencies,
  expectation: ProjectionExpectation,
  signal: AbortSignal,
): Promise<ProjectionExpectation> {
  try {
    const prepared = await dependencies.projections.prepare(expectation, signal);
    const verified = verifyProjectionExpectation(prepared, dependencies.sha256);
    if (!sameJson(verified, expectation)) throw new Error("projection adapter returned different evidence");
    return verified;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProjectionPreparationError();
  }
}

async function resolveReadiness(
  dependencies: PluginCandidatePreparationDependencies,
  input: Readonly<{
    trust: TrustCandidate;
    trustRecords: readonly TrustStateRecord[];
    configurationRef: InstalledRevisionRecord["configurationRef"];
    expectedConfigurationRevision?: import("../domain/content-manifest.js").ContentDigest;
    normalized: NormalizedPlugin;
    configurationPathContext: ConfigurationPathContext;
    automaticAuthorization?: AutomaticUpdateAuthorizationEvidence;
  }>,
  signal: AbortSignal,
): Promise<void> {
  const scope = createScopeContext(input.configurationPathContext.scope, dependencies.sha256);
  let pathContext: ConfigurationPathContext = { ...input.configurationPathContext, scope };
  if (scope.kind === "project") {
    try {
      const trustedProjectRoot = await dependencies.projectRoots.acquire(signal);
      pathContext = { ...pathContext, trustedProjectRoot };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
    }
  }
  const configurationRequest = {
    candidate: input.trust,
    trustRecords: input.trustRecords,
    configurationRef: input.configurationRef,
    ...(input.expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision: input.expectedConfigurationRevision }),
    descriptors: input.normalized.configuration,
    pathContext,
  };
  if (input.automaticAuthorization === undefined) {
    await withResolvedPluginConfiguration(configurationRequest, dependencies, signal, async () => undefined);
  } else {
    await withAuthorizedPluginConfiguration(configurationRequest, input.automaticAuthorization, dependencies, signal, async () => undefined);
  }
}

function verifyTrustedInstallBinding(
  input: PluginCandidatePreparationRequest,
  candidate: Readonly<{
    normalized: NormalizedPlugin;
    compatibility: CompatibilityReport;
    revision: InstalledRevisionRecord;
    trust: TrustCandidate;
    materialized: Awaited<ReturnType<PluginMaterializer["materialize"]>>;
    scope: ScopeContext;
  }>,
  sha256: Sha256,
): void {
  const expected = input.expectedBinding;
  if (expected === undefined) return;
  const scope = toScopeReference(candidate.scope);
  const mismatch = expected.plugin !== candidate.normalized.identity.key ||
    !sameJson(expected.scope, scope) ||
    expected.sourceIdentity !== candidate.materialized.source.hash ||
    expected.immutableRevision !== candidate.revision.revision ||
    expected.contentDigest !== candidate.materialized.content.rootDigest ||
    expected.compatibilityFingerprint !== digestCompatibilityReport(candidate.compatibility, sha256) ||
    expected.configurationDescriptorDigest !== digestConfigurationDescriptors(candidate.normalized.configuration, sha256) ||
    expected.consentDisclosureDigest !== deriveTrustedInstallConsentDisclosureDigest(
      projectSafeComponents({ plugin: candidate.normalized, compatibility: candidate.compatibility }),
      sha256,
    ) ||
    expected.configurationRef !== candidate.revision.configurationRef ||
    expected.trustSubject !== candidate.trust.subject ||
    expected.executableSurfaceDigest !== candidate.trust.evidence.executableSurfaceDigest;
  if (mismatch) throw new Error("AVAILABLE_REVISION_CHANGED");
}

async function prepareNormalizedCandidate(
  dependencies: PluginCandidatePreparationDependencies,
  input: PluginCandidatePreparationRequest,
  normalized: NormalizedPlugin,
  compatibility: CompatibilityReport,
  materialized: Awaited<ReturnType<PluginMaterializer["materialize"]>>,
  allocation: StagingAllocation,
  signal: AbortSignal,
): Promise<PreparedPluginCandidate> {
  const scope = createScopeContext(input.scope, dependencies.sha256);
  const scopeReference = toScopeReference(scope);
  const declaredVersion = normalized.version?.value ?? input.entry.version?.value;
  const revision = createInstalledRevisionRecord({
    plugin: normalized,
    compatibility,
    content: materialized.content,
    scope: scopeReference,
    marketplaceSourceIdentity: input.automaticAuthorization?.marketplaceSourceIdentity ?? deriveMarketplaceSourceIdentity(input.marketplaceSource.declared, dependencies.sha256),
    pluginSourceIdentity: input.automaticAuthorization?.pluginSourceIdentity ?? derivePluginSourceIdentity(input.entry.source.value, dependencies.sha256),
    ...(declaredVersion === undefined ? {} : { declaredVersion }),
  }, dependencies.sha256);
  const trust = createTrustCandidate({
    scope: scopeReference,
    marketplaceSource: input.marketplaceSource,
    plugin: normalized,
    compatibility,
    content: materialized.content,
    materializationBinding: materialized.binding,
  }, dependencies.sha256);
  verifyTrustedInstallBinding(input, { normalized, compatibility, revision, trust, materialized, scope }, dependencies.sha256);
  await resolveReadiness(dependencies, {
    trust,
    trustRecords: input.trustRecords,
    configurationRef: revision.configurationRef,
    ...(input.expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision: input.expectedConfigurationRevision }),
    normalized,
    configurationPathContext: input.configurationPathContext,
    ...(input.automaticAuthorization === undefined ? {} : { automaticAuthorization: input.automaticAuthorization }),
  }, signal);
  if (input.expectedRevision !== undefined && revision.revision !== input.expectedRevision) throw new Error("AVAILABLE_REVISION_CHANGED");
  const record = createInstalledPluginRecord({
    plugin: normalized.identity.key,
    activation: "enabled",
    selectedRevision: revision.revision,
    revisions: [
      ...(input.existing?.revisions ?? []).filter((candidate) => candidate.revision !== revision.revision),
      revision,
    ],
    scope: scopeReference,
  }, dependencies.sha256);
  const projection = createActiveProjectionExpectation(createPluginRuntimeProjection({
    scope: scopeReference,
    plugin: normalized,
    compatibility,
    revision,
    sha256: dependencies.sha256,
  }), dependencies.sha256);
  const preparedProjection = await prepareProjection(dependencies, projection, signal);
  if (preparedProjection.kind !== "active") throw new Error("active candidate projection became inactive");
  const descriptor = createInstalledRevisionDescriptor({
    loaded: {
      plugin: normalized,
      compatibility,
      marketplaceSource: input.marketplaceSource,
      content: materialized.content,
      binding: materialized.binding,
      ...(input.entry.policy === undefined ? {} : { installationPolicy: input.entry.policy }),
    },
    revision,
    sha256: dependencies.sha256,
  });
  const promotion = createPromotionPlan({
    kind: "plugin",
    allocation,
    materialized,
    descriptor,
  }, dependencies.sha256);
  return Object.freeze({
    operation: input.operation,
    scope,
    plugin: normalized.identity.key,
    normalized,
    compatibility,
    revision,
    record,
    projection: preparedProjection,
    trust,
    promotion,
    allocation,
  });
}

/** Prepare an install/update candidate entirely before state coordination. */
export async function preparePluginCandidate(
  dependencies: PluginCandidatePreparationDependencies,
  input: PluginCandidatePreparationRequest,
  signal: AbortSignal,
): Promise<CandidatePreparationResult> {
  let allocation: StagingAllocation | undefined;
  let retainAllocation = false;
  let phase: "materialize" | "inspect" | "compatibility" | "trust" | "configuration" | "projection" = "materialize";
  try {
    abortIfRequested(signal);
    const request = {
      ...input,
      scope: createScopeContext(input.scope, dependencies.sha256),
      entry: NormalizedMarketplaceEntrySchema.parse(input.entry),
      marketplaceSource: ResolvedMarketplaceSourceSchema.parse(input.marketplaceSource),
    };
    PluginSourceSchema.parse(request.entry.source.value);
    let materialized: Awaited<ReturnType<PluginMaterializer["materialize"]>>;
    if (request.candidateLease === undefined) {
      allocation = await dependencies.content.allocateStaging(signal);
      materialized = await dependencies.materializer.materialize(
        request.entry.source.value,
        request.sourceContext,
        allocation.slot,
        signal,
      );
    } else {
      const claimed = await request.candidateLease.claim(signal);
      allocation = claimed.allocation;
      materialized = claimed.materialized;
      const expected = request.expectedBinding;
      if (expected === undefined || claimed.candidate.id !== expected.candidateId ||
          claimed.candidate.registrationId !== expected.registrationId || claimed.candidate.snapshot !== expected.catalogSnapshot ||
          claimed.candidate.entry.identity.value.key !== expected.plugin || !sameJson(toScopeReference(claimed.candidate.scope), expected.scope) ||
          !sameJson(claimed.candidate.entry, request.entry) || !sameJson(claimed.candidate.marketplace.source, request.marketplaceSource)) {
        throw new Error("AVAILABLE_REVISION_CHANGED");
      }
    }
    phase = "inspect";
    const inspected = await dependencies.inspector.inspect({ entry: request.entry, materialized }, signal);
    if (!inspected.ok) return { kind: "rejected", code: "INCOMPATIBLE" };
    phase = "compatibility";
    const compatibility = CompatibilityReportSchema.parse(await dependencies.compatibility.assess({
      plugin: inspected.value,
      ...(request.entry.policy === undefined ? {} : { marketplacePolicy: request.entry.policy }),
    }, signal));
    if (!compatibility.activatable) return { kind: "rejected", code: "INCOMPATIBLE" };
    phase = "trust";
    const candidate = await prepareNormalizedCandidate(dependencies, request, inspected.value, compatibility, materialized, allocation, signal);
    phase = "projection";
    retainAllocation = true;
    return { kind: "prepared", candidate };
  } catch (error) {
    if (signal.aborted) return { kind: "rejected", code: "ABORTED" };
    if (error instanceof Error && error.message === "AVAILABLE_REVISION_CHANGED") return { kind: "rejected", code: "AVAILABLE_REVISION_CHANGED" };
    return { kind: "rejected", code: mapFailure(error, phase) };
  } finally {
    // Promotion happens only later under the coordinator. Until then every
    // rejection, cancellation, or malformed handoff releases its owned slot.
    if (allocation !== undefined && !retainAllocation) await discardOwned(dependencies, allocation, signal);
  }
}

/** Prepare enable from the exact selected installed revision. */
export async function prepareEnableCandidate(
  dependencies: PluginCandidatePreparationDependencies,
  input: EnableCandidatePreparationRequest,
  signal: AbortSignal,
): Promise<CandidatePreparationResult> {
  try {
    abortIfRequested(signal);
    const scope = createScopeContext(input.scope, dependencies.sha256);
    const installed = InstalledPluginRecordSchema.parse(input.installed);
    const selected = installed.revisions.find((revision) => revision.revision === installed.selectedRevision);
    if (selected === undefined) return { kind: "rejected", code: "MALFORMED" };
    const loaded: LoadedInstalledPlugin = await dependencies.installed.load({ scope, revision: selected }, signal);
    const normalizedLoaded = NormalizedPluginSchema.parse(loaded.plugin);
    const compatibility = CompatibilityReportSchema.parse(loaded.compatibility);
    if (loaded.binding !== selected.revision) return { kind: "rejected", code: "MALFORMED" };
    if (normalizedLoaded.identity.key !== installed.plugin || compatibility.plugin.key !== installed.plugin) {
      return { kind: "rejected", code: "MALFORMED" };
    }
    const reconstructed = createInstalledRevisionRecord({
      plugin: normalizedLoaded,
      compatibility,
      content: loaded.content,
      revision: selected.revision,
      contentRef: selected.contentRef,
      dataRef: selected.dataRef,
      ...(selected.configurationRef === undefined ? {} : { configurationRef: selected.configurationRef }),
      ...(selected.evidence.source.marketplaceSourceIdentity === undefined ? {} : { marketplaceSourceIdentity: selected.evidence.source.marketplaceSourceIdentity }),
      ...(selected.evidence.source.pluginSourceIdentity === undefined ? {} : { pluginSourceIdentity: selected.evidence.source.pluginSourceIdentity }),
      ...(selected.evidence.source.declaredVersion === undefined ? {} : { declaredVersion: selected.evidence.source.declaredVersion }),
      scope: toScopeReference(scope),
    }, dependencies.sha256);
    if (!sameJson(reconstructed, selected)) return { kind: "rejected", code: "MALFORMED" };
    if (!compatibility.activatable) return { kind: "rejected", code: "INCOMPATIBLE" };
    const trust = createTrustCandidate({
      scope: toScopeReference(scope),
      marketplaceSource: loaded.marketplaceSource,
      plugin: normalizedLoaded,
      compatibility,
      content: loaded.content,
      materializationBinding: loaded.binding,
    }, dependencies.sha256);
    await resolveReadiness(dependencies, {
      trust,
      trustRecords: input.trustRecords,
      configurationRef: selected.configurationRef,
      ...(input.expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision: input.expectedConfigurationRevision }),
      normalized: normalizedLoaded,
      configurationPathContext: input.configurationPathContext,
    }, signal);
    const record = createInstalledPluginRecord({
      ...installed,
      activation: "enabled",
      scope: toScopeReference(scope),
    }, dependencies.sha256);
    const projection = createActiveProjectionExpectation(createPluginRuntimeProjection({
      scope: toScopeReference(scope),
      plugin: normalizedLoaded,
      compatibility,
      revision: selected,
      sha256: dependencies.sha256,
    }), dependencies.sha256);
    const preparedProjection = await prepareProjection(dependencies, projection, signal);
    if (preparedProjection.kind !== "active") return { kind: "rejected", code: "PROJECTION_FAILED" };
    return {
      kind: "prepared",
      candidate: Object.freeze({
        operation: "enable",
        scope,
        plugin: installed.plugin,
        normalized: normalizedLoaded,
        compatibility,
        revision: selected,
        record,
        projection: preparedProjection,
        trust,
      }),
    };
  } catch (error) {
    if (signal.aborted) return { kind: "rejected", code: "ABORTED" };
    return { kind: "rejected", code: mapFailure(error, "projection") };
  }
}

/** Prepare the one canonical inactive projection used by disable/uninstall. */
export async function prepareInactiveProjection(
  dependencies: Pick<PluginCandidatePreparationDependencies, "projections" | "sha256">,
  input: Readonly<{ scope: ScopeContext; plugin: PluginKey }>,
  signal: AbortSignal,
): Promise<Extract<ProjectionExpectation, { kind: "inactive" }>> {
  const scope = createScopeContext(input.scope, dependencies.sha256);
  const expectation = createInactiveProjectionExpectation({
    scope: toScopeReference(scope),
    plugin: PluginKeySchema.parse(input.plugin),
    sha256: dependencies.sha256,
  });
  const prepared = await dependencies.projections.prepare(expectation, signal);
  const verified = verifyProjectionExpectation(prepared, dependencies.sha256);
  if (verified.kind !== "inactive" || !sameJson(verified, expectation)) throw new Error("inactive projection adapter returned different evidence");
  return verified;
}

export type {
  ConfigurationPathContext,
  CompatibilityReport,
  InstalledPluginRecord,
  InstalledRevisionRecord,
  NormalizedPlugin,
  ProjectionExpectation,
  ScopeContext,
  TrustCandidate,
};
