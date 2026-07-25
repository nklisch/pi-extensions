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
import {
  ActivationObservationSchema,
  LifecycleReloadResultSchema,
  type ActivationObservation,
  type LifecycleReloadPort,
} from "./ports/lifecycle-reload.js";
import {
  createActiveProjectionExpectation,
  createPluginRuntimeProjection,
  verifyProjectionExpectation,
  type ProjectionExpectation,
  type RuntimeProjectionPort,
} from "./ports/runtime-projection.js";
import {
  createLifecycleTransitionRecord,
  type LifecycleTransitionRecord,
  type LifecycleTransitionStore,
} from "./ports/lifecycle-transition-store.js";
import type { LifecycleOperationIdPort } from "./ports/lifecycle-operation-id.js";
import type { InstalledPluginLoader } from "./ports/installed-plugin-loader.js";
import { authorizeAutomaticUpdateCandidate, createAutomaticUpdateAuthorizationEvidence, type AutomaticUpdateAuthorizationEvidence } from "./automatic-update-authorization.js";
import { resolveEffectiveUpdatePolicy } from "./update-policy-resolution.js";
import type {
  CandidatePreparationCode,
  EnableCandidatePreparationRequest,
  PluginCandidatePreparationDependencies,
  PluginCandidatePreparationRequest,
  PreparedPluginCandidate,
} from "./plugin-candidate-preparation.js";
import {
  prepareEnableCandidate,
  prepareInactiveProjection,
  preparePluginCandidate,
} from "./plugin-candidate-preparation.js";
import type { PluginMaterializer } from "./source-materialization.js";
import {
  CandidateContentCleanupError,
  isCandidateContentCleanupError,
  type CandidateContentCleanupRecovery,
  type CandidateContentLease,
} from "./ports/candidate-content-lease.js";
import type { PreparedLifecycleCandidateBinding } from "./trusted-install-contract.js";
import type { LifecycleTargetExpectation } from "./native-lifecycle-operation-contract.js";
import { deriveLifecycleTargetDigest } from "./native-lifecycle-target.js";
import type { PluginInspectionService } from "./inspection-service.js";
import type { CompatibilityService } from "./compatibility-service.js";
import type { ContentStorePort, PromotionResult } from "./ports/content-store.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";
import type { ProjectRootAuthorityPort } from "./ports/project-root-authority.js";
import { PluginConfigurationReadResultSchema, type PluginConfigurationStore } from "./ports/plugin-configuration-store.js";
import { verifyPluginConfigurationDocument } from "../domain/configured-values.js";
import type { SecretStore } from "./ports/secret-store.js";
import type { ConfigurationPathPort, ConfigurationPathContext } from "./ports/configuration-path.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import {
  parseStateMutation,
  type GenerationSnapshot,
  type StateMutation,
} from "./state-contract.js";
import {
  createInstalledRevisionRecord,
  InstalledPluginRecordSchema,
  type InstalledPluginRecord,
  type InstalledRevisionRecord,
} from "../domain/state/installed-state.js";
import {
  createInstalledUserStateDocument,
} from "../domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../domain/state/project-state.js";
import {
  ScopeContextSchema,
  createScopeContext,
  toScopeReference,
  type ScopeContext,
  type ScopeReference,
} from "../domain/state/scope.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import type { Generation } from "../domain/state/config-state.js";
import type { TrustStateRecord } from "../domain/state/trust-state.js";
import type { NormalizedMarketplaceEntry } from "../domain/marketplace.js";
import type { ResolvedMarketplaceSource } from "../domain/source.js";
import type { SourceContext } from "./source-materialization.js";
import type { Sha256 } from "../domain/source.js";
import { deriveMarketplaceSourceIdentity, derivePluginSourceIdentity, MarketplaceUpdateRecordSchema } from "../domain/update-policy.js";
import { createTrustCandidate } from "../domain/trust-policy.js";
import { createLifecycleTransitionReconciler } from "./lifecycle-transition-reconciler.js";
import { CommittedMutationCleanupError } from "./generation-mutation-coordinator.js";

export type InstallPluginRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  origin?: LifecycleOrigin;
  entry: NormalizedMarketplaceEntry;
  marketplaceSource: ResolvedMarketplaceSource;
  sourceContext: SourceContext;
  trustRecords?: readonly TrustStateRecord[];
  configurationPathContext: ConfigurationPathContext;
  expectedRevision?: import("../domain/content-manifest.js").ContentDigest;
  automaticAuthorization?: AutomaticUpdateAuthorizationEvidence;
}>;
export type UpdatePluginRequest = InstallPluginRequest & ExpectedLifecycleTarget;
type PreparedInstallPluginRequest = InstallPluginRequest & Readonly<{
  candidateLease: CandidateContentLease;
  expectedBinding: PreparedLifecycleCandidateBinding;
  expectedConfigurationRevision?: import("../domain/content-manifest.js").ContentDigest;
  expectedTarget?: LifecycleTargetExpectation;
}>;
type ExpectedLifecycleTarget = Readonly<{ expectedTarget?: LifecycleTargetExpectation }>;
export type EnablePluginRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  origin?: LifecycleOrigin;
  trustRecords?: readonly TrustStateRecord[];
  configurationPathContext: ConfigurationPathContext;
  expectedConfigurationRevision?: import("../domain/content-manifest.js").ContentDigest;
}> & ExpectedLifecycleTarget;
export type DisablePluginRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  origin?: LifecycleOrigin;
}> & ExpectedLifecycleTarget;
export type UninstallPluginRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  origin?: LifecycleOrigin;
  retainedData?: LifecycleRetainedData;
}> & ExpectedLifecycleTarget;

export type LifecycleActivationFailure =
  | Readonly<{ kind: "reload-rejected"; code: "RELOAD_REJECTED" }>
  | Readonly<{ kind: "observation-mismatch"; code: "OBSERVATION_MISMATCH" }>
  | Readonly<{ kind: "adapter-error"; code: "ADAPTER_FAILED" | "ABORTED" }>;

export type LifecycleCleanupIntent = Readonly<{
  kind: "deferred";
  retainedData: LifecycleRetainedData;
  transition: import("../domain/state/references.js").PendingTransitionRef;
}>;

export type PluginLifecycleResult =
  | Readonly<{
      kind: "changed";
      operation: LifecycleOperation;
      snapshot: GenerationSnapshot;
      observation: ActivationObservation;
      cleanup?: LifecycleCleanupIntent;
    }>
  | Readonly<{ kind: "unchanged"; operation: LifecycleOperation; snapshot: GenerationSnapshot }>
  | Readonly<{ kind: "rejected"; operation: LifecycleOperation; code: LifecycleRejectionCode }>
  | Readonly<{ kind: "stale"; operation: LifecycleOperation; expected: Generation; actual: Generation }>
  | Readonly<{
      kind: "rolled-back";
      operation: LifecycleOperation;
      failure: LifecycleActivationFailure;
      snapshot: GenerationSnapshot;
      observation: ActivationObservation;
    }>
  | Readonly<{
      kind: "recovery-required";
      operation: LifecycleOperation;
      transition: import("../domain/state/references.js").PendingTransitionRef;
      committed?: Generation;
    }>;

export interface PluginLifecycleService {
  install(request: InstallPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  enable(request: EnablePluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  disable(request: DisablePluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  update(request: UpdatePluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  uninstall(request: UninstallPluginRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
}

export type PreparedLifecycleMutationRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  entry: NormalizedMarketplaceEntry;
  marketplaceSource: ResolvedMarketplaceSource;
  sourceContext: SourceContext;
  lease: CandidateContentLease;
  expected: PreparedLifecycleCandidateBinding;
  expectedConfigurationRevision?: import("../domain/content-manifest.js").ContentDigest;
  configurationPathContext: ConfigurationPathContext;
}>;

export interface PreparedLifecycleAuthority {
  installPrepared(request: PreparedLifecycleMutationRequest, signal: AbortSignal): Promise<PluginLifecycleResult>;
  updatePrepared(request: PreparedLifecycleMutationRequest & Readonly<{ expectedTarget: LifecycleTargetExpectation }>, signal: AbortSignal): Promise<PluginLifecycleResult>;
}

/** Source-compatible trusted-install authority name. */
export type PreparedInstallLifecycleAuthority = Pick<PreparedLifecycleAuthority, "installPrepared">;

export type PluginLifecycleComposition = Readonly<{
  application: PluginLifecycleService;
  prepared: PreparedLifecycleAuthority;
  preparedInstall: PreparedInstallLifecycleAuthority;
}>;

export type PluginLifecycleServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  mutations: import("./generation-mutation-coordinator.js").GenerationMutationCoordinator;
  content: ContentStorePort;
  materializer: PluginMaterializer;
  inspector: PluginInspectionService;
  compatibility: CompatibilityService;
  installed: InstalledPluginLoader;
  projections: RuntimeProjectionPort;
  reload: LifecycleReloadPort;
  transitions: LifecycleTransitionStore;
  operationIds: LifecycleOperationIdPort;
  projectTrust: ProjectTrustPort;
  projectRoots: ProjectRootAuthorityPort;
  configurations: PluginConfigurationStore;
  secrets: SecretStore;
  paths: ConfigurationPathPort;
  sha256: Sha256;
}>;

class GuardMismatch extends Error {
  readonly generation: Generation;
  constructor(generation: Generation) {
    super("lifecycle target changed while a prepared transition was waiting");
    this.name = "GuardMismatch";
    this.generation = generation;
  }
}

class PromotionFailure extends Error {
  constructor() {
    super("content promotion did not return the requested immutable revision");
    this.name = "PromotionFailure";
  }
}

class ConfigurationGuardMismatch extends Error {
  constructor() {
    super("prepared configuration authority changed");
    this.name = "ConfigurationGuardMismatch";
  }
}

class ConfigurationGuardUnavailable extends Error {
  constructor() {
    super("prepared configuration authority is unavailable");
    this.name = "ConfigurationGuardUnavailable";
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asScopeContext(input: ScopeContext, sha256: Sha256): ScopeContext {
  return createScopeContext(ScopeContextSchema.parse(input), sha256);
}

function targetRecord(snapshot: GenerationSnapshot, plugin: PluginKey): InstalledPluginRecord | undefined {
  return "installed" in snapshot
    ? snapshot.installed.plugins.find((record: InstalledPluginRecord) => record.plugin === plugin)
    : snapshot.project.plugins.find((record: InstalledPluginRecord) => record.plugin === plugin);
}

function withoutPending(record: InstalledPluginRecord): InstalledPluginRecord {
  const { pendingTransition: _pendingTransition, ...value } = record;
  return InstalledPluginRecordSchema.parse(value);
}

function withPending(record: InstalledPluginRecord, reference: import("../domain/state/references.js").PendingTransitionRef, _sha256: Sha256): InstalledPluginRecord {
  return InstalledPluginRecordSchema.parse({ ...withoutPending(record), pendingTransition: reference });
}

function scopeRecords(snapshot: GenerationSnapshot): readonly InstalledPluginRecord[] {
  return "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins;
}

function replaceTarget(
  snapshot: GenerationSnapshot,
  plugin: PluginKey,
  replacement: InstalledPluginRecord | null,
  sha256: Sha256,
): StateMutation {
  const records = scopeRecords(snapshot).filter((record) => record.plugin !== plugin);
  if (replacement !== null) records.push(replacement);
  if ("installed" in snapshot) {
    const installed = createInstalledUserStateDocument({
      ...snapshot.installed,
      generation: snapshot.generation,
      plugins: records,
    }, sha256);
    return parseStateMutation({
      scope: snapshot.scope,
      expectedGeneration: snapshot.generation,
      replace: { installed },
    }, sha256);
  }
  // Lifecycle owns only the target plugin. Rebuilding through the current
  // constructor preserves declaration, policy, scheduler, and registration evidence.
  const project = createProjectLocalStateDocument({
    ...snapshot.project,
    generation: snapshot.generation,
    plugins: records,
  }, snapshot.scope, sha256);
  return parseStateMutation({
    scope: snapshot.scope,
    expectedGeneration: snapshot.generation,
    replace: { project },
  }, sha256);
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

function safeFailure(error: unknown): LifecycleActivationFailure {
  if (error instanceof DOMException && error.name === "AbortError") return { kind: "adapter-error", code: "ABORTED" };
  if (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") {
    return { kind: "adapter-error", code: "ABORTED" };
  }
  return { kind: "adapter-error", code: "ADAPTER_FAILED" };
}

function cleanupSignal(): AbortSignal {
  return new AbortController().signal;
}

async function discardCandidate(
  dependencies: PluginLifecycleServiceDependencies,
  candidate: PreparedPluginCandidate | undefined,
): Promise<void> {
  if (candidate?.allocation === undefined) return;
  const recovery = Object.freeze({
    retry: () => dependencies.content.discardStaging(candidate.allocation!, cleanupSignal()),
  }) as CandidateContentCleanupRecovery;
  try {
    await recovery.retry();
  } catch (error) {
    throw new CandidateContentCleanupError(recovery, { cause: error });
  }
}

async function preparePreviousExpectation(
  dependencies: PluginLifecycleServiceDependencies,
  scope: ScopeContext,
  plugin: PluginKey,
  previous: InstalledPluginRecord | undefined,
  signal: AbortSignal,
): Promise<ProjectionExpectation> {
  if (previous === undefined || previous.activation === "disabled") {
    return prepareInactiveProjection(dependencies, { scope, plugin }, signal);
  }
  const selected = previous.revisions.find((revision) => revision.revision === previous.selectedRevision);
  if (selected === undefined) throw new Error("installed state selected revision is missing");
  const loaded = await dependencies.installed.load({ scope, revision: selected }, signal);
  if (loaded.binding !== selected.revision || loaded.plugin.identity.key !== plugin) throw new Error("installed loader returned a different selected revision");
  const reconstructed = createInstalledRevisionRecord({
    plugin: loaded.plugin,
    compatibility: loaded.compatibility,
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
  if (!sameJson(reconstructed, selected)) throw new Error("installed loader evidence does not match selected state");
  const projection = createActiveProjectionExpectation(createPluginRuntimeProjection({
    scope: toScopeReference(scope),
    plugin: loaded.plugin,
    compatibility: loaded.compatibility,
    revision: selected,
    sha256: dependencies.sha256,
  }), dependencies.sha256);
  const prepared = await dependencies.projections.prepare(projection, signal);
  const verified = verifyProjectionExpectation(prepared, dependencies.sha256);
  if (!sameJson(verified, projection)) throw new Error("previous projection adapter returned different evidence");
  return verified;
}

function observationMatches(
  observation: ActivationObservation,
  expectation: ProjectionExpectation,
  plugin: PluginKey,
): boolean {
  if (expectation.kind === "inactive") {
    return observation.kind === "inactive" &&
      sameJson(observation.scope, expectation.scope) &&
      observation.plugin === plugin &&
      observation.projectionDigest === expectation.digest;
  }
  return observation.kind === "active" &&
    sameJson(observation.scope, expectation.projection.scope) &&
    observation.plugin === plugin &&
    observation.revision === expectation.projection.revision &&
    observation.projectionDigest === expectation.projection.digest;
}

async function reloadAndObserve(
  dependencies: PluginLifecycleServiceDependencies,
  scope: ScopeContext,
  plugin: PluginKey,
  transition: import("../domain/state/references.js").PendingTransitionRef,
  expectation: ProjectionExpectation,
  signal: AbortSignal,
): Promise<Readonly<{ ok: true; observation: ActivationObservation }> | Readonly<{ ok: false; failure: LifecycleActivationFailure }>> {
  try {
    const reloadResult = LifecycleReloadResultSchema.parse(await dependencies.reload.reload({ scope: toScopeReference(scope), transition }, signal));
    if (reloadResult.kind === "failed") return { ok: false, failure: { kind: "reload-rejected", code: "RELOAD_REJECTED" } };
    const observation = ActivationObservationSchema.parse(await dependencies.reload.observe({ scope: toScopeReference(scope), plugin }, signal));
    if (!observationMatches(observation, expectation, plugin)) {
      return { ok: false, failure: { kind: "observation-mismatch", code: "OBSERVATION_MISMATCH" } };
    }
    return { ok: true, observation };
  } catch (error) {
    return { ok: false, failure: safeFailure(error) };
  }
}

function candidateForOperation(
  operation: LifecycleOperation,
  previous: InstalledPluginRecord,
  prepared: PreparedPluginCandidate | undefined,
  _sha256: Sha256,
): InstalledPluginRecord {
  if (operation === "disable" || operation === "uninstall") {
    return InstalledPluginRecordSchema.parse({ ...withoutPending(previous), activation: "disabled" });
  }
  if (prepared === undefined) throw new Error("activation candidate is missing");
  return prepared.record;
}

function operationOrigin(request: { origin?: LifecycleOrigin }): LifecycleOrigin {
  return LifecycleOriginSchema.parse(request.origin ?? "manual");
}

function retainedData(request: UninstallPluginRequest | DisablePluginRequest): LifecycleRetainedData {
  return LifecycleRetainedDataSchema.parse("retainedData" in request ? request.retainedData ?? "keep" : "keep");
}

function noOp(operation: LifecycleOperation, snapshot: GenerationSnapshot): PluginLifecycleResult {
  return { kind: "unchanged", operation, snapshot };
}

function rejected(operation: LifecycleOperation, code: LifecycleRejectionCode): PluginLifecycleResult {
  return { kind: "rejected", operation, code: LifecycleRejectionCodeSchema.parse(code) };
}

function recovery(
  operation: LifecycleOperation,
  transition: import("../domain/state/references.js").PendingTransitionRef,
  committed?: Generation,
): PluginLifecycleResult {
  return committed === undefined
    ? { kind: "recovery-required", operation, transition }
    : { kind: "recovery-required", operation, transition, committed };
}

function createPluginLifecycleImplementation(
  dependencies: PluginLifecycleServiceDependencies,
): PluginLifecycleComposition {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("lifecycle service dependencies are required");
  const preparation: PluginCandidatePreparationDependencies = dependencies;
  const reconciler = createLifecycleTransitionReconciler({
    state: dependencies.state,
    mutations: dependencies.mutations,
    reload: dependencies.reload,
    transitions: dependencies.transitions,
    sha256: dependencies.sha256,
  });

  async function load(scope: ScopeContext, signal: AbortSignal): Promise<GenerationSnapshot | undefined> {
    const result = await dependencies.state.read(scope, signal);
    return result.ok ? result.snapshot : undefined;
  }

  async function trustFor(scope: ScopeContext, requestRecords: readonly TrustStateRecord[] | undefined, signal: AbortSignal): Promise<readonly TrustStateRecord[]> {
    if (requestRecords !== undefined) return requestRecords;
    const snapshot = await load({ kind: "user" }, signal);
    return snapshot !== undefined && "trust" in snapshot ? snapshot.trust.records : [];
  }

  async function exactConfigurationState(
    prepared: PreparedPluginCandidate | undefined,
    expectedRevision: import("../domain/content-manifest.js").ContentDigest | undefined,
  ): Promise<"current" | "stale" | "unavailable"> {
    if (expectedRevision === undefined) return "current";
    const ref = prepared?.revision.configurationRef;
    if (ref === undefined || prepared === undefined) return "stale";
    try {
      const result = PluginConfigurationReadResultSchema.parse(
        await dependencies.configurations.read(ref, new AbortController().signal),
      );
      if (result.kind === "missing") return "stale";
      const document = verifyPluginConfigurationDocument(
        result.document,
        prepared.normalized.configuration,
        dependencies.sha256,
      );
      return document.configurationRef === ref && document.plugin === prepared.plugin &&
        sameJson(document.scope, toScopeReference(prepared.scope)) && document.revision === expectedRevision
        ? "current"
        : "stale";
    } catch {
      return "unavailable";
    }
  }

  async function runFirstCommit(
    operation: LifecycleOperation,
    scope: ScopeContext,
    plugin: PluginKey,
    before: GenerationSnapshot,
    previous: InstalledPluginRecord | undefined,
    candidate: InstalledPluginRecord,
    prepared: PreparedPluginCandidate | undefined,
    reference: import("../domain/state/references.js").PendingTransitionRef,
    expectedConfigurationRevision: import("../domain/content-manifest.js").ContentDigest | undefined,
    signal: AbortSignal,
  ): Promise<Readonly<{ kind: "committed"; snapshot: GenerationSnapshot }> | Readonly<{ kind: "stale"; expected: Generation; actual: Generation }> | Readonly<{ kind: "rejected"; code: LifecycleRejectionCode }> | Readonly<{ kind: "recovery"; committed?: Generation }>> {
    let expected = before.generation;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await dependencies.mutations.runPreparedMutation(
          { scope, plugins: [plugin], expectedGeneration: expected },
          async (context) => {
            await context.assertOwned();
            const current = targetRecord(context.snapshot, plugin);
            if (!sameJson(current, previous)) throw new GuardMismatch(context.snapshot.generation);
            const configurationState = await exactConfigurationState(prepared, expectedConfigurationRevision);
            if (configurationState === "stale") throw new ConfigurationGuardMismatch();
            if (configurationState === "unavailable") throw new ConfigurationGuardUnavailable();
            let promotion: PromotionResult | undefined;
            if (prepared?.promotion !== undefined) {
              try {
                promotion = await dependencies.content.promote(prepared.promotion, signal);
              } catch {
                throw new PromotionFailure();
              }
              if (!sameJson(promotion.identity, prepared.promotion.identity) || !sameJson(promotion.manifest, prepared.promotion.manifest)) {
                throw new PromotionFailure();
              }
            }
            return {
              mutation: replaceTarget(context.snapshot, plugin, withPending(candidate, reference, dependencies.sha256), dependencies.sha256),
              value: promotion,
            };
          },
          signal,
        );
        if (result.kind === "committed") return { kind: "committed", snapshot: result.snapshot };
        if (result.kind === "stale-generation") {
          if (attempt === 1) return { kind: "stale", expected: result.expected, actual: result.actual };
          const fresh = await load(scope, signal);
          if (fresh === undefined) return { kind: "recovery" };
          if (targetRecord(fresh, plugin) !== undefined && !sameJson(targetRecord(fresh, plugin), previous)) {
            return { kind: "stale", expected: expected, actual: fresh.generation };
          }
          if (targetRecord(fresh, plugin) === undefined && previous !== undefined) {
            return { kind: "stale", expected: expected, actual: fresh.generation };
          }
          expected = fresh.generation;
          continue;
        }
        if (result.kind === "commit-failed") return { kind: "rejected", code: "MALFORMED" };
        // A concurrent unrelated writer can advance the scope between the
        // store commit and the coordinator's verification read. Resolve that
        // ambiguous outcome from current authority only when our exact
        // pending candidate and transition reference are durably present.
        const fresh = await load(scope, signal);
        const freshTarget = fresh === undefined ? undefined : targetRecord(fresh, plugin);
        const expectedTarget = withPending(candidate, reference, dependencies.sha256);
        if (fresh !== undefined && sameJson(freshTarget, expectedTarget)) {
          return { kind: "committed", snapshot: fresh };
        }
        return result.actual === undefined
          ? { kind: "recovery" }
          : { kind: "recovery", committed: result.actual };
      } catch (error) {
        // The coordinator preserves durable commit evidence when only scope
        // lease cleanup fails. Replaying would be unsafe; continue the
        // transition from the exact committed snapshot instead.
        if (error instanceof CommittedMutationCleanupError) return { kind: "committed", snapshot: error.committed.snapshot };
        if (signal.aborted) return { kind: "rejected", code: "ABORTED" };
        if (error instanceof GuardMismatch) return { kind: "stale", expected, actual: error.generation };
        if (error instanceof ConfigurationGuardMismatch) return { kind: "rejected", code: "CONFIGURATION_STALE" };
        if (error instanceof ConfigurationGuardUnavailable) return { kind: "rejected", code: "MALFORMED" };
        if (error instanceof PromotionFailure) return { kind: "rejected", code: "PROMOTION_FAILED" };
        return { kind: "recovery" };
      }
    }
    return { kind: "stale", expected, actual: expected };
  }

  async function execute(
    operation: LifecycleOperation,
    request: InstallPluginRequest | PreparedInstallPluginRequest | EnablePluginRequest | DisablePluginRequest | UninstallPluginRequest,
    signal: AbortSignal,
  ): Promise<PluginLifecycleResult> {
    LifecycleOperationSchema.parse(operation);
    if (signal.aborted) return rejected(operation, "ABORTED");
    const scope = asScopeContext(request.scope, dependencies.sha256);
    const plugin = PluginKeySchema.parse(request.plugin);
    const origin = operationOrigin(request);
    let initial: GenerationSnapshot | undefined;
    try {
      initial = await load(scope, signal);
    } catch {
      return rejected(operation, signal.aborted ? "ABORTED" : "MALFORMED");
    }
    if (initial === undefined) return rejected(operation, "MALFORMED");
    const previous = targetRecord(initial, plugin);
    if (previous?.pendingTransition !== undefined) return rejected(operation, "PENDING_TRANSITION");
    const expectedTarget = "expectedTarget" in request ? request.expectedTarget : undefined;
    if (expectedTarget !== undefined) {
      if (expectedTarget.plugin !== plugin || previous === undefined || previous.pendingTransition !== undefined ||
          previous.selectedRevision !== expectedTarget.selectedRevision || previous.activation !== expectedTarget.activation ||
          deriveLifecycleTargetDigest(toScopeReference(scope), previous, dependencies.sha256) !== expectedTarget.targetDigest) {
        return { kind: "stale", operation, expected: expectedTarget.generation, actual: initial.generation };
      }
    }

    if (operation === "enable" && (previous === undefined || previous.activation === "enabled")) {
      return previous === undefined ? rejected(operation, "NOT_INSTALLED") : noOp(operation, initial);
    }
    if (operation === "disable" && (previous === undefined || previous.activation === "disabled")) {
      return previous === undefined ? rejected(operation, "NOT_INSTALLED") : noOp(operation, initial);
    }
    if (operation === "update" && previous === undefined) return rejected(operation, "NOT_INSTALLED");
    if (operation === "uninstall" && previous === undefined) return noOp(operation, initial);

    const trustRecords = operation === "install" || operation === "update" || operation === "enable"
      ? ("trustRecords" in request && request.trustRecords !== undefined
        ? request.trustRecords
        : "trust" in initial
          ? initial.trust.records
          : await trustFor(scope, undefined, signal))
      : [];
    let automaticAuthorization: AutomaticUpdateAuthorizationEvidence | undefined;
    if (operation === "update" && origin === "automatic-update") {
      const automaticRequest = request as UpdatePluginRequest;
      if (automaticRequest.expectedRevision === undefined) return rejected(operation, "INVALID_REQUEST");
      const policyRecord = "config" in initial
        ? initial.config.records.find((record) => record.marketplace === automaticRequest.entry.identity.value.marketplaceName)
        : initial.project.marketplaceUpdates.find((record) => record.marketplace === automaticRequest.entry.identity.value.marketplaceName);
      if (policyRecord === undefined) return rejected(operation, "UNTRUSTED");
      const selected = previous?.revisions.find((revision) => revision.revision === previous.selectedRevision);
      if (selected === undefined) return rejected(operation, "MALFORMED");
      try {
        const loadedPrevious = await dependencies.installed.load({ scope, revision: selected }, signal);
        const previousCandidate = createTrustCandidate({
          scope: toScopeReference(scope),
          marketplaceSource: loadedPrevious.marketplaceSource,
          plugin: loadedPrevious.plugin,
          compatibility: loadedPrevious.compatibility,
          content: loadedPrevious.content,
          materializationBinding: loadedPrevious.binding,
        }, dependencies.sha256);
        let globalPolicy: "manual" | "automatic";
        let scopedPolicy: "manual" | "automatic" | undefined;
        if ("config" in initial) {
          globalPolicy = initial.config.global.application;
          scopedPolicy = initial.config.scope.application;
        } else {
          const userPolicy = await dependencies.state.read({ kind: "user" }, signal);
          if (!userPolicy.ok || !("config" in userPolicy.snapshot)) return rejected(operation, "UNTRUSTED");
          globalPolicy = userPolicy.snapshot.config.global.application;
          scopedPolicy = initial.project.scope.application;
        }
        const effectivePolicy = resolveEffectiveUpdatePolicy({
          plugin,
          record: MarketplaceUpdateRecordSchema.parse(policyRecord),
          global: globalPolicy,
          ...(scopedPolicy === undefined ? {} : { scope: scopedPolicy }),
          marketplaceSourceIdentity: selected.evidence.source.marketplaceSourceIdentity ?? "legacy-unavailable",
          registeredMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity(policyRecord.source, dependencies.sha256),
          pluginSourceIdentity: selected.evidence.source.pluginSourceIdentity ?? "legacy-unavailable",
        });
        const authority = await authorizeAutomaticUpdateCandidate({
          scope,
          previous: loadedPrevious,
          previousRecord: selected,
          candidate: previousCandidate,
          candidateMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity(automaticRequest.marketplaceSource.declared, dependencies.sha256),
          candidatePluginSourceIdentity: derivePluginSourceIdentity(automaticRequest.entry.source.value, dependencies.sha256),
          expectedRevision: automaticRequest.expectedRevision,
          policyRecord: MarketplaceUpdateRecordSchema.parse(policyRecord),
          effectivePolicy,
          trustRecords,
          ...(scope.kind === "project" && "project" in initial ? { projectDeclarationDigest: initial.project.declarationDigest } : {}),
        }, { projectTrust: dependencies.projectTrust, sha256: dependencies.sha256 }, signal);
        if (authority.kind === "denied") return rejected(operation, authority.code === "STATE_STALE" ? "MALFORMED" : authority.code === "PROJECT_UNTRUSTED" ? "UNTRUSTED" : "UNTRUSTED");
        automaticAuthorization = createAutomaticUpdateAuthorizationEvidence({
          kind: "automatic-authorization",
          scope: toScopeReference(scope),
          plugin,
          expectedRevision: automaticRequest.expectedRevision,
          marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(automaticRequest.marketplaceSource.declared, dependencies.sha256),
          pluginSourceIdentity: derivePluginSourceIdentity(automaticRequest.entry.source.value, dependencies.sha256),
        });
      } catch (error) {
        if (signal.aborted) return rejected(operation, "ABORTED");
        return rejected(operation, "UNTRUSTED");
      }
    }

    let prepared: PreparedPluginCandidate | undefined;
    let candidateExpectation: ProjectionExpectation;
    try {
      if (operation === "install" || operation === "update") {
        const installRequest = request as InstallPluginRequest;
        const candidateRequest: PluginCandidatePreparationRequest = {
          operation,
          scope,
          entry: installRequest.entry,
          marketplaceSource: installRequest.marketplaceSource,
          sourceContext: installRequest.sourceContext,
          trustRecords,
          configurationPathContext: installRequest.configurationPathContext,
          ...(previous === undefined ? {} : { existing: previous }),
          ...(automaticAuthorization === undefined ? {} : { automaticAuthorization }),
          ...(installRequest.expectedRevision === undefined ? {} : { expectedRevision: installRequest.expectedRevision }),
          ...("candidateLease" in installRequest ? {
            candidateLease: (installRequest as PreparedInstallPluginRequest).candidateLease,
            expectedBinding: (installRequest as PreparedInstallPluginRequest).expectedBinding,
            ...((installRequest as PreparedInstallPluginRequest).expectedConfigurationRevision === undefined
              ? {}
              : { expectedConfigurationRevision: (installRequest as PreparedInstallPluginRequest).expectedConfigurationRevision }),
          } : {}),
        };
        const result = await preparePluginCandidate(preparation, candidateRequest, signal);
        if (result.kind === "rejected") return rejected(operation, mapPreparationCode(result.code));
        prepared = result.candidate;
        if (prepared.plugin !== plugin) {
          await discardCandidate(dependencies, prepared);
          return rejected(operation, "MALFORMED");
        }
        if (operation === "install" && previous !== undefined) {
          if (previous.selectedRevision === prepared.record.selectedRevision && previous.activation === "enabled") {
            await discardCandidate(dependencies, prepared);
            return noOp(operation, initial);
          }
          await discardCandidate(dependencies, prepared);
          return rejected(operation, "ALREADY_INSTALLED");
        }
        if (operation === "update" && previous !== undefined && previous.selectedRevision === prepared.record.selectedRevision && previous.activation === "enabled") {
          await discardCandidate(dependencies, prepared);
          return noOp(operation, initial);
        }
        candidateExpectation = prepared.projection;
      } else if (operation === "enable") {
        if (previous === undefined) return rejected(operation, "NOT_INSTALLED");
        const enableRequest = request as EnablePluginRequest;
        const result = await prepareEnableCandidate(preparation, {
          operation: "enable",
          scope,
          installed: previous,
          trustRecords,
          configurationPathContext: enableRequest.configurationPathContext,
          ...(enableRequest.expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision: enableRequest.expectedConfigurationRevision }),
        } satisfies EnableCandidatePreparationRequest, signal);
        if (result.kind === "rejected") return rejected(operation, mapPreparationCode(result.code));
        prepared = result.candidate;
        candidateExpectation = prepared.projection;
      } else {
        candidateExpectation = await prepareInactiveProjection(dependencies, { scope, plugin }, signal);
      }
    } catch (error) {
      await discardCandidate(dependencies, prepared);
      if (isCandidateContentCleanupError(error)) throw error;
      return rejected(operation, signal.aborted ? "ABORTED" : "PROJECTION_FAILED");
    }

    const previousExpectation = await preparePreviousExpectation(dependencies, scope, plugin, previous, signal).catch(() => undefined);
    if (previousExpectation === undefined) {
      await discardCandidate(dependencies, prepared);
      return rejected(operation, "MALFORMED");
    }

    let operationId: string;
    try {
      operationId = await dependencies.operationIds.create(signal);
      z.string().uuid().parse(operationId);
    } catch {
      await discardCandidate(dependencies, prepared);
      return rejected(operation, signal.aborted ? "ABORTED" : "MALFORMED");
    }
    const reference = (await import("./plugin-lifecycle-contract.js")).deriveLifecyclePendingTransitionRef({
      operationId,
      scope: toScopeReference(scope),
      plugin,
      startingGeneration: initial.generation,
    }, dependencies.sha256);
    const candidateSource = previous ?? prepared?.record;
    if (candidateSource === undefined) {
      await discardCandidate(dependencies, prepared);
      return rejected(operation, "MALFORMED");
    }
    const candidate = candidateForOperation(operation, candidateSource, prepared, dependencies.sha256);
    const finalRecord = operation === "uninstall" ? null : candidate;
    const transition: LifecycleTransitionRecord = createLifecycleTransitionRecord({
      operationId,
      operation,
      origin,
      scope: toScopeReference(scope),
      plugin,
      startingGeneration: initial.generation,
      previous: previous === undefined ? null : withoutPending(previous),
      candidate: withoutPending(candidate),
      final: finalRecord === null ? null : withoutPending(finalRecord),
      previousProjection: previousExpectation,
      candidateProjection: candidateExpectation,
      retainedData: operation === "uninstall" ? retainedData(request) : "keep",
      reference,
      sha256: dependencies.sha256,
    });
    try {
      const stored = await dependencies.transitions.prepare(transition, signal);
      if (stored === "already-present") {
        await discardCandidate(dependencies, prepared);
        return rejected(operation, "PENDING_TRANSITION");
      }
    } catch {
      await discardCandidate(dependencies, prepared);
      return rejected(operation, signal.aborted ? "ABORTED" : "MALFORMED");
    }

    const expectedConfigurationRevision = "expectedConfigurationRevision" in request
      ? request.expectedConfigurationRevision
      : undefined;
    const first = await runFirstCommit(
      operation,
      scope,
      plugin,
      initial,
      previous,
      candidate,
      prepared,
      reference,
      expectedConfigurationRevision,
      signal,
    );
    await discardCandidate(dependencies, prepared);
    if (first.kind === "stale") return { kind: "stale", operation, expected: first.expected, actual: first.actual };
    if (first.kind === "rejected") return rejected(operation, first.code);
    if (first.kind === "recovery") return recovery(operation, reference, first.committed);

    const committed = first.snapshot;
    const beforeReloadConfiguration = await exactConfigurationState(prepared, expectedConfigurationRevision);
    let activation: Awaited<ReturnType<typeof reloadAndObserve>>;
    if (beforeReloadConfiguration === "stale") {
      activation = { ok: false, failure: { kind: "observation-mismatch", code: "OBSERVATION_MISMATCH" } };
    } else if (beforeReloadConfiguration === "unavailable") {
      activation = { ok: false, failure: { kind: "adapter-error", code: "ADAPTER_FAILED" } };
    } else {
      activation = await reloadAndObserve(dependencies, scope, plugin, reference, candidateExpectation, signal);
      if (activation.ok) {
        const observedConfiguration = await exactConfigurationState(prepared, expectedConfigurationRevision);
        if (observedConfiguration !== "current") {
          activation = observedConfiguration === "stale"
            ? { ok: false, failure: { kind: "observation-mismatch", code: "OBSERVATION_MISMATCH" } }
            : { ok: false, failure: { kind: "adapter-error", code: "ADAPTER_FAILED" } };
        }
      }
    }
    const reconciled = await reconciler.completeCommittedTransition({
      operation,
      scope,
      plugin,
      previous,
      candidate,
      final: finalRecord,
      reference,
      committed,
      previousProjection: previousExpectation,
      candidateProjection: candidateExpectation,
      activation,
    }, signal);
    if (reconciled.kind === "recovery-required") return recovery(operation, reference, reconciled.committed);
    if (reconciled.kind === "rolled-back") {
      return {
        kind: "rolled-back",
        operation,
        failure: reconciled.failure,
        snapshot: reconciled.snapshot,
        observation: reconciled.observation,
      };
    }
    return {
      kind: "changed",
      operation,
      snapshot: reconciled.snapshot,
      observation: reconciled.observation,
      ...(operation === "uninstall" ? { cleanup: { kind: "deferred", retainedData: retainedData(request), transition: reference } } : {}),
    };
  }

  const application: PluginLifecycleService = Object.freeze({
    install: (request: InstallPluginRequest, signal: AbortSignal) => execute("install", request, signal),
    enable: (request: EnablePluginRequest, signal: AbortSignal) => execute("enable", request, signal),
    disable: (request: DisablePluginRequest, signal: AbortSignal) => execute("disable", request, signal),
    update: (request: UpdatePluginRequest, signal: AbortSignal) => execute("update", request, signal),
    uninstall: (request: UninstallPluginRequest, signal: AbortSignal) => execute("uninstall", request, signal),
  });
  async function executePrepared(
    operation: "install" | "update",
    request: PreparedLifecycleMutationRequest & Readonly<{ expectedTarget?: LifecycleTargetExpectation }>,
    signal: AbortSignal,
  ): Promise<PluginLifecycleResult> {
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
    try {
      return await execute(operation, preparedRequest, signal);
    } finally {
      // No-op after transfer; mandatory cleanup when lifecycle returned before claim.
      await request.lease.release();
    }
  }
  const prepared: PreparedLifecycleAuthority = Object.freeze({
    installPrepared: (request: PreparedLifecycleMutationRequest, signal: AbortSignal) => executePrepared("install", request, signal),
    updatePrepared: (request: PreparedLifecycleMutationRequest & Readonly<{ expectedTarget: LifecycleTargetExpectation }>, signal: AbortSignal) => executePrepared("update", request, signal),
  });
  return Object.freeze({ application, prepared, preparedInstall: prepared });
}

export function createPluginLifecycleComposition(
  dependencies: PluginLifecycleServiceDependencies,
): PluginLifecycleComposition {
  return createPluginLifecycleImplementation(dependencies);
}

/** Source-compatible public lifecycle factory. */
export function createPluginLifecycleService(
  dependencies: PluginLifecycleServiceDependencies,
): PluginLifecycleService {
  return createPluginLifecycleImplementation(dependencies).application;
}

export const PluginLifecycleResultSchema = z.object({
  kind: z.enum(["changed", "unchanged", "rejected", "stale", "rolled-back", "recovery-required"]),
}).passthrough().readonly();

export type {
  ActivationObservation,
  ConfigurationPathContext,
  Generation,
  GenerationSnapshot,
  InstalledPluginRecord,
  InstalledRevisionRecord,
  PluginKey,
  ProjectionExpectation,
  ScopeContext,
  ScopeReference,
};
