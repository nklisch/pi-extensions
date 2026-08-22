import { z } from "zod";
import {
  LifecycleOperationSchema,
  LifecycleOriginSchema,
  LifecycleRetainedDataSchema,
  LifecycleRejectionCodeSchema,
  type LifecycleOperation,
  type LifecycleOrigin,
  type LifecycleRejectionCode,
  type LifecycleRetainedData,
} from "./plugin-lifecycle-contract.js";
import { runScopedMutation, type ScopedMutationResult } from "./state-transaction.js";
import type { LifecycleReloadPort } from "./ports/lifecycle-reload.js";
import type { InstalledPluginLoader } from "./ports/installed-plugin-loader.js";
import type {
  CandidatePreparationCode,
  EnableCandidatePreparationRequest,
  PluginCandidatePreparationDependencies,
  PluginCandidatePreparationRequest,
  PreparedPluginCandidate,
} from "./plugin-candidate-preparation.js";
import { prepareEnableCandidate, prepareInactiveProjection, preparePluginCandidate } from "./plugin-candidate-preparation.js";
import type { PluginMaterializer, SourceContext } from "./source-materialization.js";
import type { CandidateContentLease } from "./ports/candidate-content-lease.js";
import { CandidateContentCleanupError, isCandidateContentCleanupError, type CandidateContentCleanupRecovery } from "./ports/candidate-content-lease.js";
import type { PreparedLifecycleCandidateBinding } from "./trusted-install-contract.js";
import type { LifecycleTargetExpectation } from "./native-lifecycle-operation-contract.js";
import { deriveLifecycleTargetDigest } from "./native-lifecycle-target.js";
import type { PluginInspectionService } from "./inspection-service.js";
import type { CompatibilityService } from "./compatibility-service.js";
import type { ContentStorePort } from "./ports/content-store.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";
import type { ProjectRootAuthorityPort } from "./ports/project-root-authority.js";
import { PluginConfigurationReadResultSchema, type PluginConfigurationStore } from "./ports/plugin-configuration-store.js";
import { verifyPluginConfigurationDocument } from "../domain/configured-values.js";
import type { SecretStore } from "./ports/secret-store.js";
import type { ConfigurationPathPort, ConfigurationPathContext } from "./ports/configuration-path.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import { parseStateMutation, type GenerationSnapshot, type StateMutation } from "./state-contract.js";
import {
  createInstalledRevisionRecord,
  InstalledPluginRecordSchema,
  createInstalledUserStateDocument,
  type InstalledPluginRecord,
} from "../domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../domain/state/project-state.js";
import { ScopeContextSchema, createScopeContext, toScopeReference, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { GenerationSchema, type Generation } from "../domain/state/config-state.js";
import type { TrustStateRecord } from "../domain/state/trust-state.js";
import type { NormalizedMarketplaceEntry } from "../domain/marketplace.js";
import type { ResolvedMarketplaceSource, Sha256 } from "../domain/source.js";
import { ContentDigestSchema, type ContentDigest } from "../domain/content-manifest.js";
import type { PendingDeleteMarkerStore } from "./ports/pending-data-deletion.js";
import type { PersistentDataRemovalPort } from "./ports/persistent-data-removal.js";

export type InstallPluginRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  origin?: LifecycleOrigin;
  entry: NormalizedMarketplaceEntry;
  marketplaceSource: ResolvedMarketplaceSource;
  sourceContext: SourceContext;
  trustRecords?: readonly TrustStateRecord[];
  configurationPathContext: ConfigurationPathContext;
  expectedRevision?: ContentDigest;
  automaticAuthorization?: import("./automatic-update-authorization.js").AutomaticUpdateAuthorizationEvidence;
}>;
export type UpdatePluginRequest = InstallPluginRequest & ExpectedLifecycleTarget & Readonly<{ activation?: "immediate" | "deferred" }>;
type PreparedInstallPluginRequest = InstallPluginRequest & Readonly<{
  candidateLease: CandidateContentLease;
  expectedBinding: PreparedLifecycleCandidateBinding;
  expectedConfigurationRevision?: ContentDigest;
  expectedTarget?: LifecycleTargetExpectation;
}>;
type ExpectedLifecycleTarget = Readonly<{ expectedTarget?: LifecycleTargetExpectation }>;
export type EnablePluginRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  origin?: LifecycleOrigin;
  trustRecords?: readonly TrustStateRecord[];
  configurationPathContext: ConfigurationPathContext;
  expectedConfigurationRevision?: ContentDigest;
}> & ExpectedLifecycleTarget;
export type DisablePluginRequest = Readonly<{ scope: ScopeContext; plugin: PluginKey; origin?: LifecycleOrigin }> & ExpectedLifecycleTarget;
export type UninstallPluginRequest = Readonly<{ scope: ScopeContext; plugin: PluginKey; origin?: LifecycleOrigin; retainedData?: LifecycleRetainedData }> & ExpectedLifecycleTarget;
/** Repair needs the current catalog handoff because installed state retains only
 * hashed source evidence, never executable URLs or paths. */
export type RepairPluginRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  entry: NormalizedMarketplaceEntry;
  marketplaceSource: ResolvedMarketplaceSource;
  sourceContext: SourceContext;
  trustRecords?: readonly TrustStateRecord[];
  configurationPathContext: ConfigurationPathContext;
  expectedConfigurationRevision?: ContentDigest;
}>;
export type RollbackPluginRequest = Readonly<{ scope: ScopeContext; plugin: PluginKey }> & ExpectedLifecycleTarget;

/** Lifecycle outcomes intentionally describe state authority, not a durable operation journal. */
export type PluginLifecycleResult =
  | Readonly<{ kind: "applied"; operation: LifecycleOperation; snapshot: GenerationSnapshot; activation?: "applied" | "live-next-start" }>
  | Readonly<{ kind: "live-next-start"; operation: LifecycleOperation; snapshot: GenerationSnapshot; note?: "no-reload-context" | "reload-failed" }>
  | Readonly<{ kind: "degraded"; operation: LifecycleOperation; snapshot: GenerationSnapshot; failure: Readonly<{ plugin: PluginKey; code: string; explanation: string }>; runningRevision?: ContentDigest }>
  | Readonly<{ kind: "current"; operation: LifecycleOperation; snapshot: GenerationSnapshot }>
  | Readonly<{ kind: "rejected"; operation: LifecycleOperation; code: LifecycleRejectionCode }>
  | Readonly<{ kind: "stale"; operation: LifecycleOperation; expected: Generation; actual?: Generation }>;

export interface PluginLifecycleService {
  install(request: InstallPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  enable(request: EnablePluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  disable(request: DisablePluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  update(request: UpdatePluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  uninstall(request: UninstallPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  repair(request: RepairPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  rollback(request: RollbackPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
}

export type PreparedLifecycleMutationRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  entry: NormalizedMarketplaceEntry;
  marketplaceSource: ResolvedMarketplaceSource;
  sourceContext: SourceContext;
  lease: CandidateContentLease;
  expected: PreparedLifecycleCandidateBinding;
  expectedConfigurationRevision?: ContentDigest;
  configurationPathContext: ConfigurationPathContext;
}>;
export interface PreparedLifecycleAuthority {
  installPrepared(request: PreparedLifecycleMutationRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  updatePrepared(request: PreparedLifecycleMutationRequest & Readonly<{ expectedTarget: LifecycleTargetExpectation }>, signal: AbortSignal): Promise<PluginLifecycleResult>;
}
export type PreparedInstallLifecycleAuthority = Pick<PreparedLifecycleAuthority, "installPrepared">;
export type PluginLifecycleComposition = Readonly<{ application: PluginLifecycleService; prepared: PreparedLifecycleAuthority; preparedInstall: PreparedInstallLifecycleAuthority }>;

export type PluginLifecycleServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  content: ContentStorePort;
  materializer: PluginMaterializer;
  inspector: PluginInspectionService;
  compatibility: CompatibilityService;
  installed: InstalledPluginLoader;
  projections: import("./ports/runtime-projection.js").RuntimeProjectionPort;
  reload: LifecycleReloadPort;
  projectTrust: ProjectTrustPort;
  projectRoots: ProjectRootAuthorityPort;
  configurations: PluginConfigurationStore;
  secrets: SecretStore;
  paths: ConfigurationPathPort;
  sha256: Sha256;
  pendingDeletes?: PendingDeleteMarkerStore;
  dataRemoval?: PersistentDataRemovalPort;
}>;

function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function asScopeContext(input: ScopeContext, sha256: Sha256): ScopeContext { return createScopeContext(ScopeContextSchema.parse(input), sha256); }
function targetRecord(snapshot: GenerationSnapshot, plugin: PluginKey): InstalledPluginRecord | undefined {
  return "installed" in snapshot ? snapshot.installed.plugins.find((record) => record.plugin === plugin) : snapshot.project.plugins.find((record) => record.plugin === plugin);
}
function records(snapshot: GenerationSnapshot): readonly InstalledPluginRecord[] { return "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins; }
function replaceTarget(snapshot: GenerationSnapshot, plugin: PluginKey, replacement: InstalledPluginRecord | null, sha256: Sha256): StateMutation {
  const next = records(snapshot).filter((record) => record.plugin !== plugin);
  if (replacement !== null) next.push(replacement);
  if ("installed" in snapshot) {
    const installed = createInstalledUserStateDocument({ ...snapshot.installed, generation: snapshot.generation, plugins: next }, sha256);
    return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { installed } }, sha256);
  }
  const project = createProjectLocalStateDocument({ ...snapshot.project, generation: snapshot.generation, plugins: next }, snapshot.scope, sha256);
  return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { project } }, sha256);
}
function mapPreparationCode(code: CandidatePreparationCode): LifecycleRejectionCode {
  switch (code) {
    case "INCOMPATIBLE": return "INCOMPATIBLE";
    case "UNTRUSTED": return "UNTRUSTED";
    case "UNCONFIGURED": return "UNCONFIGURED";
    case "PROJECTION_FAILED": return "PROJECTION_FAILED";
    case "ABORTED": return "ABORTED";
    case "AVAILABLE_REVISION_CHANGED": return "AVAILABLE_REVISION_CHANGED";
    case "CONFIGURATION_STALE": return "CONFIGURATION_STALE";
    default: return "MALFORMED";
  }
}
function operationOrigin(request: { origin?: LifecycleOrigin }): LifecycleOrigin { return LifecycleOriginSchema.parse(request.origin ?? "manual"); }
function retainedData(request: UninstallPluginRequest): LifecycleRetainedData { return LifecycleRetainedDataSchema.parse(request.retainedData ?? "keep"); }
function current(operation: LifecycleOperation, snapshot: GenerationSnapshot): PluginLifecycleResult { return { kind: "current", operation, snapshot }; }
function rejected(operation: LifecycleOperation, code: LifecycleRejectionCode): PluginLifecycleResult { return { kind: "rejected", operation, code: LifecycleRejectionCodeSchema.parse(code) }; }
function cleanupSignal(): AbortSignal { return new AbortController().signal; }

async function discardCandidate(dependencies: PluginLifecycleServiceDependencies, candidate: PreparedPluginCandidate | undefined): Promise<void> {
  if (candidate?.allocation === undefined) return;
  const recovery = Object.freeze({ retry: () => dependencies.content.discardStaging(candidate.allocation!, cleanupSignal()) }) as CandidateContentCleanupRecovery;
  try { await recovery.retry(); } catch (error) { throw new CandidateContentCleanupError(recovery, { cause: error }); }
}

async function exactConfigurationState(dependencies: PluginLifecycleServiceDependencies, prepared: PreparedPluginCandidate | undefined, expected: ContentDigest | undefined): Promise<"current" | "stale" | "unavailable"> {
  if (expected === undefined) return "current";
  if (prepared === undefined || prepared.revision.configurationRef === undefined) return "stale";
  try {
    const result = PluginConfigurationReadResultSchema.parse(await dependencies.configurations.read(prepared.revision.configurationRef, cleanupSignal()));
    if (result.kind === "missing") return "stale";
    const document = verifyPluginConfigurationDocument(result.document, prepared.normalized.configuration, dependencies.sha256);
    return document.configurationRef === prepared.revision.configurationRef && document.plugin === prepared.plugin && sameJson(document.scope, toScopeReference(prepared.scope)) && document.revision === expected ? "current" : "stale";
  } catch { return "unavailable"; }
}

function appendPrevious(candidate: InstalledPluginRecord, previous: InstalledPluginRecord | undefined, operation: LifecycleOperation): InstalledPluginRecord {
  if (operation !== "update" || previous === undefined) return candidate;
  const previousRevision = previous.selectedRevision === candidate.selectedRevision
    ? previous.previousRevision
    : previous.selectedRevision;
  return InstalledPluginRecordSchema.parse({
    ...candidate,
    ...(previousRevision === undefined ? {} : { previousRevision }),
  });
}

function sourceEvidenceMatches(candidate: InstalledPluginRecord["revisions"][number], expected: InstalledPluginRecord["revisions"][number]): boolean {
  const actual = candidate.evidence.source;
  const wanted = expected.evidence.source;
  if (actual.kind !== wanted.kind || actual.sourceHash !== wanted.sourceHash) return false;
  if ("revision" in actual && "revision" in wanted && actual.revision !== wanted.revision) return false;
  if ("marketplaceRevision" in actual && "marketplaceRevision" in wanted && actual.marketplaceRevision !== wanted.marketplaceRevision) return false;
  if (actual.kind === "npm" && wanted.kind === "npm" && actual.sourceRevision !== wanted.sourceRevision) return false;
  return true;
}

async function activate(dependencies: PluginLifecycleServiceDependencies, operation: LifecycleOperation, scope: ScopeContext, snapshot: GenerationSnapshot, plugin: PluginKey, signal: AbortSignal): Promise<PluginLifecycleResult> {
  try {
    const result = await dependencies.reload.reload({ scope: toScopeReference(scope) }, signal);
    if (result.kind === "accepted") {
      const degraded = result.report?.kind === "degraded"
        ? result.report.degraded.find((entry) => entry.plugin === plugin && (entry.scope === undefined || sameJson(entry.scope, toScopeReference(scope))))
        : undefined;
      if (degraded !== undefined) {
        return {
          kind: "degraded",
          operation,
          snapshot,
          failure: { plugin, code: degraded.code, explanation: degraded.explanation },
          ...(degraded.runningRevision === undefined ? {} : { runningRevision: ContentDigestSchema.parse(degraded.runningRevision) }),
        };
      }
      return { kind: "applied", operation, snapshot, activation: "applied" };
    }
    if (result.code === "PI_RELOAD_CONTEXT_UNAVAILABLE") return { kind: "live-next-start", operation, snapshot, note: "no-reload-context" };
    return { kind: "live-next-start", operation, snapshot, note: "reload-failed" };
  } catch {
    return { kind: "live-next-start", operation, snapshot, note: "reload-failed" };
  }
}

function mapMutation<T>(operation: LifecycleOperation, result: ScopedMutationResult<T>, signal: AbortSignal): PluginLifecycleResult | { kind: "committed"; snapshot: GenerationSnapshot } {
  if (result.kind === "committed") return { kind: "committed", snapshot: result.snapshot };
  if (result.kind === "stale") return { kind: "stale", operation, expected: GenerationSchema.parse(result.expected), ...(result.actual === undefined ? {} : { actual: GenerationSchema.parse(result.actual) }) };
  if (result.kind === "retryable") return rejected(operation, result.code);
  if (result.kind === "reject") return result.value as PluginLifecycleResult;
  if (result.kind === "no-op") return result.value as PluginLifecycleResult;
  if (signal.aborted) return rejected(operation, "ABORTED");
  return rejected(operation, "MALFORMED");
}

function createPluginLifecycleImplementation(dependencies: PluginLifecycleServiceDependencies): PluginLifecycleComposition {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("lifecycle service dependencies are required");
  const preparation: PluginCandidatePreparationDependencies = dependencies;

  async function load(scope: ScopeContext, signal: AbortSignal): Promise<GenerationSnapshot | undefined> {
    const result = await dependencies.state.read(scope, signal);
    return result.ok ? result.snapshot : undefined;
  }
  async function trustFor(request: InstallPluginRequest | EnablePluginRequest, signal: AbortSignal): Promise<readonly TrustStateRecord[]> {
    if (request.trustRecords !== undefined) return request.trustRecords;
    const result = await dependencies.state.read({ kind: "user" }, signal);
    return result.ok && "trust" in result.snapshot ? result.snapshot.trust.records : [];
  }

  async function execute(operation: LifecycleOperation, request: InstallPluginRequest | PreparedInstallPluginRequest | EnablePluginRequest | DisablePluginRequest | UninstallPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult> {
    LifecycleOperationSchema.parse(operation);
    if (signal.aborted) return rejected(operation, "ABORTED");
    const scope = asScopeContext(request.scope, dependencies.sha256);
    const plugin = PluginKeySchema.parse(request.plugin);
    const initial = await load(scope, signal).catch(() => undefined);
    if (initial === undefined) return rejected(operation, "MALFORMED");
    const previous = targetRecord(initial, plugin);
    const expectedTarget = "expectedTarget" in request ? request.expectedTarget : undefined;
    if (expectedTarget !== undefined && (previous === undefined || expectedTarget.plugin !== plugin || expectedTarget.selectedRevision !== previous.selectedRevision || expectedTarget.activation !== previous.activation || deriveLifecycleTargetDigest(toScopeReference(scope), previous, dependencies.sha256) !== expectedTarget.targetDigest)) {
      return { kind: "stale", operation, expected: expectedTarget.generation, actual: initial.generation };
    }
    if (operation === "install" && previous !== undefined) return rejected(operation, "ALREADY_INSTALLED");
    if (operation === "update" && previous === undefined) return rejected(operation, "NOT_INSTALLED");
    if (operation === "enable" && previous === undefined) return rejected(operation, "NOT_INSTALLED");
    if (operation === "disable" && previous === undefined) return rejected(operation, "NOT_INSTALLED");
    if (operation === "uninstall" && previous === undefined) return current(operation, initial);
    if (operation === "enable" && previous?.activation === "enabled") return current(operation, initial);
    if (operation === "disable" && previous?.activation === "disabled") return current(operation, initial);

    let prepared: PreparedPluginCandidate | undefined;
    try {
      if (operation === "install" || operation === "update") {
        const installRequest = request as InstallPluginRequest;
        const preparedInstallRequest = request as PreparedInstallPluginRequest;
        const trustRecords = await trustFor(installRequest, signal);
        const candidateRequest: PluginCandidatePreparationRequest = {
          operation,
          scope,
          entry: installRequest.entry,
          marketplaceSource: installRequest.marketplaceSource,
          sourceContext: installRequest.sourceContext,
          trustRecords,
          configurationPathContext: installRequest.configurationPathContext,
          ...(previous === undefined ? {} : { existing: previous }),
          ...(installRequest.expectedRevision === undefined ? {} : { expectedRevision: installRequest.expectedRevision }),
          ...(installRequest.automaticAuthorization === undefined ? {} : { automaticAuthorization: installRequest.automaticAuthorization }),
          ...("candidateLease" in request ? { candidateLease: preparedInstallRequest.candidateLease, expectedBinding: preparedInstallRequest.expectedBinding, ...(preparedInstallRequest.expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision: preparedInstallRequest.expectedConfigurationRevision }) } : {}),
        };
        const result = await preparePluginCandidate(preparation, candidateRequest, signal);
        if (result.kind === "rejected") return rejected(operation, mapPreparationCode(result.code));
        prepared = result.candidate;
        if (prepared.plugin !== plugin) {
          await discardCandidate(dependencies, prepared);
          prepared = undefined;
          return rejected(operation, "MALFORMED");
        }
        if (operation === "update" && previous !== undefined && previous.selectedRevision === prepared.record.selectedRevision && previous.activation === "enabled") {
          await discardCandidate(dependencies, prepared);
          prepared = undefined;
          return current(operation, initial);
        }
      } else if (operation === "enable") {
        const enableRequest = request as EnablePluginRequest;
        const result = await prepareEnableCandidate(preparation, { operation: "enable", scope, installed: previous!, trustRecords: await trustFor(enableRequest, signal), configurationPathContext: enableRequest.configurationPathContext, ...(enableRequest.expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision: enableRequest.expectedConfigurationRevision }) } satisfies EnableCandidatePreparationRequest, signal);
        if (result.kind === "rejected") return rejected(operation, mapPreparationCode(result.code));
        prepared = result.candidate;
      }
    } catch (error) {
      await discardCandidate(dependencies, prepared);
      if (isCandidateContentCleanupError(error)) throw error;
      return rejected(operation, signal.aborted ? "ABORTED" : "PROJECTION_FAILED");
    }

    const expectedConfigurationRevision = "expectedConfigurationRevision" in request ? request.expectedConfigurationRevision : undefined;
    const candidate = operation === "uninstall"
      ? InstalledPluginRecordSchema.parse({ ...previous!, activation: "disabled" })
      : operation === "disable"
        ? InstalledPluginRecordSchema.parse({ ...previous!, activation: "disabled" })
        : appendPrevious(prepared?.record ?? previous!, previous, operation);

    if (operation === "uninstall" && retainedData(request as UninstallPluginRequest) === "delete-confirmed" && dependencies.pendingDeletes !== undefined && previous !== undefined) {
      const selected = previous.revisions.find((revision) => revision.revision === previous.selectedRevision);
      if (selected === undefined) return rejected(operation, "MALFORMED");
      try {
        await dependencies.pendingDeletes.create({ scope: toScopeReference(scope), plugin, dataRef: selected.dataRef, requestedAt: Date.now() });
      } catch { return rejected(operation, "MALFORMED"); }
    }

    try {
      if (prepared?.promotion !== undefined) {
        const promotion = await dependencies.content.promote(prepared.promotion, signal);
        if (!sameJson(promotion.identity, prepared.promotion.identity) || !sameJson(promotion.manifest, prepared.promotion.manifest)) {
          await discardCandidate(dependencies, prepared);
          prepared = undefined;
          return rejected(operation, "PROMOTION_FAILED");
        }
      }
      const mutation = runScopedMutation<PluginLifecycleResult | undefined>(dependencies.state, scope, (snapshot: GenerationSnapshot) => {
        const latest = targetRecord(snapshot, plugin);
        if (!sameJson(latest, previous)) return { kind: "reject" as const, value: { kind: "stale" as const, operation, expected: initial.generation, actual: snapshot.generation } };
        const replacement = operation === "uninstall" ? null : candidate;
        return { kind: "commit" as const, mutation: replaceTarget(snapshot, plugin, replacement, dependencies.sha256), value: undefined, recheckAuthority: async () => {
          const configurationState = await exactConfigurationState(dependencies, prepared, expectedConfigurationRevision);
          if (configurationState === "stale") throw new Error("CONFIGURATION_STALE");
          if (configurationState === "unavailable") throw new Error("CONFIGURATION_UNAVAILABLE");
        } };
      }, signal);
      const committed = await mutation;
      const mapped = mapMutation(operation, committed, signal);
      if (!("kind" in mapped) || mapped.kind !== "committed") {
        await discardCandidate(dependencies, prepared);
        return mapped as PluginLifecycleResult;
      }
      await discardCandidate(dependencies, prepared);
      if (operation === "update" && (request as UpdatePluginRequest).activation === "deferred") return { kind: "live-next-start", operation, snapshot: mapped.snapshot, note: "no-reload-context" };
      if (operation === "uninstall" && retainedData(request as UninstallPluginRequest) === "delete-confirmed" && dependencies.pendingDeletes !== undefined && dependencies.dataRemoval !== undefined && previous !== undefined) {
        const selected = previous.revisions.find((revision) => revision.revision === previous.selectedRevision);
        if (selected !== undefined) {
          const marker = { scope: toScopeReference(scope), plugin, dataRef: selected.dataRef, requestedAt: Date.now() };
          try {
            await dependencies.dataRemoval.remove({ ...marker, confirmation: "delete-confirmed", capability: {} }, signal);
            await dependencies.pendingDeletes.remove(marker);
          } catch { /* convergence retries the durable marker */ }
        }
      }
      return activate(dependencies, operation, scope, mapped.snapshot, plugin, signal);
    } catch (error) {
      await discardCandidate(dependencies, prepared).catch(() => undefined);
      if (signal.aborted) return rejected(operation, "ABORTED");
      if (error instanceof Error && error.message === "CONFIGURATION_STALE") return rejected(operation, "CONFIGURATION_STALE");
      if (error instanceof Error && error.message.includes("promotion")) return rejected(operation, "PROMOTION_FAILED");
      return rejected(operation, "MALFORMED");
    }
  }

  async function repair(request: RepairPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult> {
    const operation: LifecycleOperation = "repair";
    if (signal.aborted) return rejected(operation, "ABORTED");
    const scope = asScopeContext(request.scope, dependencies.sha256);
    const plugin = PluginKeySchema.parse(request.plugin);
    const initial = await load(scope, signal).catch(() => undefined);
    if (initial === undefined) return rejected(operation, "MALFORMED");
    const installed = targetRecord(initial, plugin);
    const selected = installed?.revisions.find((revision) => revision.revision === installed.selectedRevision);
    if (installed === undefined) return rejected(operation, "NOT_INSTALLED");
    if (selected === undefined) return rejected(operation, "MALFORMED");

    let prepared: PreparedPluginCandidate | undefined;
    try {
      const preparedResult = await preparePluginCandidate(preparation, {
        operation: "update",
        scope,
        entry: request.entry,
        marketplaceSource: request.marketplaceSource,
        sourceContext: request.sourceContext,
        trustRecords: await trustFor(request, signal),
        configurationPathContext: request.configurationPathContext,
        existing: installed,
        expectedRevision: selected.revision,
        ...(request.expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision: request.expectedConfigurationRevision }),
      }, signal);
      if (preparedResult.kind === "rejected") return rejected(operation, mapPreparationCode(preparedResult.code));
      prepared = preparedResult.candidate;
      if (prepared.plugin !== plugin || prepared.revision.revision !== selected.revision || !sourceEvidenceMatches(prepared.revision, selected)) {
        await discardCandidate(dependencies, prepared).catch(() => undefined);
        prepared = undefined;
        return rejected(operation, "AVAILABLE_REVISION_CHANGED");
      }
      if (prepared.promotion !== undefined) {
        const promotion = await dependencies.content.promote(prepared.promotion, signal);
        if (!sameJson(promotion.identity, prepared.promotion.identity) || !sameJson(promotion.manifest, prepared.promotion.manifest)) {
          await discardCandidate(dependencies, prepared).catch(() => undefined);
          prepared = undefined;
          return rejected(operation, "PROMOTION_FAILED");
        }
      }
      await discardCandidate(dependencies, prepared);
      prepared = undefined;
      const latest = await load(scope, signal);
      const latestRecord = latest === undefined ? undefined : targetRecord(latest, plugin);
      if (latest === undefined || latestRecord === undefined || latestRecord.selectedRevision !== selected.revision) {
        return { kind: "stale", operation, expected: initial.generation, ...(latest === undefined ? {} : { actual: latest.generation }) };
      }
      // Repair never commits when the authority pointer already names the
      // repaired revision. The promotion above is idempotent and is the only
      // persistent change in the common missing-files case.
      return activate(dependencies, operation, scope, latest, plugin, signal);
    } catch (error) {
      await discardCandidate(dependencies, prepared).catch(() => undefined);
      if (signal.aborted) return rejected(operation, "ABORTED");
      if (error instanceof Error && error.message === "AVAILABLE_REVISION_CHANGED") return rejected(operation, "AVAILABLE_REVISION_CHANGED");
      if (error instanceof Error && error.message.includes("promotion")) return rejected(operation, "PROMOTION_FAILED");
      return rejected(operation, "MALFORMED");
    }
  }

  async function rollback(request: RollbackPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult> {
    const operation: LifecycleOperation = "rollback";
    if (signal.aborted) return rejected(operation, "ABORTED");
    const scope = asScopeContext(request.scope, dependencies.sha256);
    const plugin = PluginKeySchema.parse(request.plugin);
    const initial = await load(scope, signal).catch(() => undefined);
    if (initial === undefined) return rejected(operation, "MALFORMED");
    const previous = targetRecord(initial, plugin);
    const expectedTarget = request.expectedTarget;
    if (expectedTarget !== undefined && (previous === undefined || expectedTarget.plugin !== plugin || expectedTarget.selectedRevision !== previous.selectedRevision || expectedTarget.activation !== previous.activation || deriveLifecycleTargetDigest(toScopeReference(scope), previous, dependencies.sha256) !== expectedTarget.targetDigest)) {
      return { kind: "stale", operation, expected: expectedTarget.generation, actual: initial.generation };
    }
    if (previous === undefined) return rejected(operation, "NOT_INSTALLED");
    if (previous.previousRevision === undefined || !previous.revisions.some((revision) => revision.revision === previous.previousRevision)) return rejected(operation, "MALFORMED");
    const mutation = await runScopedMutation<PluginLifecycleResult | undefined>(dependencies.state, scope, (snapshot: GenerationSnapshot) => {
      const latest = targetRecord(snapshot, plugin);
      if (latest === undefined || !sameJson(latest, previous)) {
        return { kind: "reject" as const, value: { kind: "stale" as const, operation, expected: initial.generation, actual: snapshot.generation } };
      }
      const fallback = latest.previousRevision;
      if (fallback === undefined || !latest.revisions.some((revision) => revision.revision === fallback)) {
        return { kind: "reject" as const, value: rejected(operation, "MALFORMED") };
      }
      const replacement = InstalledPluginRecordSchema.parse({
        ...latest,
        selectedRevision: fallback,
        previousRevision: latest.selectedRevision,
      });
      return { kind: "commit" as const, mutation: replaceTarget(snapshot, plugin, replacement, dependencies.sha256), value: undefined };
    }, signal);
    const mapped = mapMutation(operation, mutation, signal);
    if (!("kind" in mapped) || mapped.kind !== "committed") return mapped as PluginLifecycleResult;
    return activate(dependencies, operation, scope, mapped.snapshot, plugin, signal);
  }

  const application: PluginLifecycleService = Object.freeze({
    install: (request: InstallPluginRequest, signal: AbortSignal) => execute("install", request, signal),
    enable: (request: EnablePluginRequest, signal: AbortSignal) => execute("enable", request, signal),
    disable: (request: DisablePluginRequest, signal: AbortSignal) => execute("disable", request, signal),
    update: (request: UpdatePluginRequest, signal: AbortSignal) => execute("update", request, signal),
    uninstall: (request: UninstallPluginRequest, signal: AbortSignal) => execute("uninstall", request, signal),
    repair,
    rollback,
  });

  async function executePrepared(operation: "install" | "update", request: PreparedLifecycleMutationRequest & Readonly<{ expectedTarget?: LifecycleTargetExpectation }>, signal: AbortSignal): Promise<PluginLifecycleResult> {
    const preparedRequest: PreparedInstallPluginRequest = {
      scope: request.scope,
      plugin: request.plugin,
      origin: "manual",
      entry: request.entry,
      marketplaceSource: request.marketplaceSource,
      sourceContext: request.sourceContext,
      configurationPathContext: request.configurationPathContext,
      expectedRevision: request.expected.immutableRevision,
      ...(request.expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision: request.expectedConfigurationRevision }),
      candidateLease: request.lease,
      expectedBinding: request.expected,
      ...(request.expectedTarget === undefined ? {} : { expectedTarget: request.expectedTarget }),
    };
    try { return await execute(operation, preparedRequest, signal); }
    finally { await request.lease.release(); }
  }
  const prepared: PreparedLifecycleAuthority = Object.freeze({
    installPrepared: (request: PreparedLifecycleMutationRequest, signal: AbortSignal) => executePrepared("install", request, signal),
    updatePrepared: (request: PreparedLifecycleMutationRequest & Readonly<{ expectedTarget: LifecycleTargetExpectation }>, signal: AbortSignal) => executePrepared("update", request, signal),
  });
  return Object.freeze({ application, prepared, preparedInstall: prepared });
}

export function createPluginLifecycleComposition(dependencies: PluginLifecycleServiceDependencies): PluginLifecycleComposition { return createPluginLifecycleImplementation(dependencies); }
export function createPluginLifecycleService(dependencies: PluginLifecycleServiceDependencies): PluginLifecycleService { return createPluginLifecycleImplementation(dependencies).application; }
export const PluginLifecycleResultSchema = z.object({ kind: z.enum(["applied", "live-next-start", "degraded", "current", "rejected", "stale"]) }).passthrough().readonly();
export type { ConfigurationPathContext, Generation, GenerationSnapshot, InstalledPluginRecord, PluginKey, ScopeContext, ScopeReference };
