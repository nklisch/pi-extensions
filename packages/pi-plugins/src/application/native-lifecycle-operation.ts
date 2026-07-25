import type {
  BoundPluginConfigurationService,
  ConfigurationRecoveryCapability,
} from "./configuration-service.js";
import type { ExactTrustGrantService } from "./exact-trust-grant-service.js";
import {
  NativeLifecycleOperationResultSchema,
  type NativeLifecycleOperationConfirmation,
  type NativeLifecycleOperationResult,
  type NativeLifecyclePreviewId,
  type NativeLifecycleRetainedPreflightEvidence,
} from "./native-lifecycle-operation-contract.js";
import { createNativeLifecycleProgressRecorder, type NativeLifecycleProgressRecorder } from "./native-lifecycle-progress.js";
import { projectPluginLifecycleResult } from "./native-lifecycle-result.js";
import type { NativeLifecycleTargetService, VerifiedNativeLifecycleTarget } from "./native-lifecycle-target.js";
import type { NativeLifecycleUpdateService, PreparedNativeLifecycleUpdate } from "./native-lifecycle-update.js";
import type { NativeUninstallCleanupService } from "./native-uninstall-cleanup.js";
import type { NativeDiagnostic } from "./native-inspection-contract.js";
import type { NativeInspectionEvidencePort } from "./ports/native-inspection-evidence.js";
import type { ProjectRootAuthorityPort, TrustedProjectRoot } from "./ports/project-root-authority.js";
import { isCandidateContentCleanupError } from "./ports/candidate-content-lease.js";
import type { ConfigurationPathContext } from "./ports/configuration-path.js";
import type { PluginLifecycleComposition } from "./plugin-lifecycle-service.js";
import { validateTrustedInstallSubmission, type TrustedInstallConfigurationAuthority, type TrustedInstallConfigurationDependencies } from "./trusted-install-configuration.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { hashContent, type ContentDigest } from "../domain/content-manifest.js";
import type { Sha256 } from "../domain/source.js";

export type NativeLifecycleOperationDependencies = Readonly<{
  targets: NativeLifecycleTargetService;
  updates: NativeLifecycleUpdateService;
  lifecycle: PluginLifecycleComposition;
  configuration: BoundPluginConfigurationService;
  configurationAuthority: TrustedInstallConfigurationAuthority;
  configurationInput(candidate: PreparedNativeLifecycleUpdate["candidate"], projectRoot: TrustedProjectRoot | undefined): Omit<TrustedInstallConfigurationDependencies, "configurationRef" | "plugin" | "scope" | "descriptors">;
  configurationPathContext(target: VerifiedNativeLifecycleTarget, projectRoot: TrustedProjectRoot | undefined): ConfigurationPathContext;
  trust: ExactTrustGrantService;
  evidence: NativeInspectionEvidencePort;
  projectRoots: ProjectRootAuthorityPort;
  uninstallCleanup: NativeUninstallCleanupService;
  sha256: Sha256;
}>;

export type VerifiedNativeLifecycleOperationContext = Readonly<{
  operation: "enable" | "disable" | "update" | "uninstall";
  previewId: NativeLifecyclePreviewId;
  target: VerifiedNativeLifecycleTarget;
  update?: PreparedNativeLifecycleUpdate;
  diagnostics?: readonly NativeDiagnostic[];
}>;

/** Opaque configuration recovery remains owned by the operation composition. */
export class NativeLifecycleConfigurationRecoveryError extends Error {
  constructor(
    readonly recovery: ConfigurationRecoveryCapability,
    readonly code: "ADAPTER_FAILED" | "CLEANUP_FAILED",
    readonly retainedPreflight?: NativeLifecycleRetainedPreflightEvidence,
    options?: ErrorOptions,
  ) {
    super("native lifecycle configuration recovery is required", options);
    this.name = "NativeLifecycleConfigurationRecoveryError";
  }
}

function emptyEffects() { return { state: "unchanged" as const, projectFile: "unchanged" as const, completedActionIds: [], pendingActionIds: [] }; }

function currentState(
  context: VerifiedNativeLifecycleOperationContext,
  progress: NativeLifecycleProgressRecorder,
  reason: "already-enabled" | "already-disabled" | "revision-current" | "already-uninstalled",
  target: VerifiedNativeLifecycleTarget = context.target,
): NativeLifecycleOperationResult {
  return NativeLifecycleOperationResultSchema.parse({ kind: "current-state", operation: context.operation, previewId: context.previewId, progress: progress.events(), diagnostics: context.diagnostics ?? [], effects: emptyEffects(), reason, target: target.binding });
}

function terminal(
  input: Readonly<Record<string, unknown> & { kind: "stale" | "conflict" | "rejected" | "recovery-required" | "cancelled" | "failed" }>,
  context: VerifiedNativeLifecycleOperationContext,
  progress: NativeLifecycleProgressRecorder,
  retainedPreflight?: NativeLifecycleRetainedPreflightEvidence,
): NativeLifecycleOperationResult {
  return NativeLifecycleOperationResultSchema.parse({ ...input, operation: context.operation, previewId: context.previewId, progress: progress.events(), diagnostics: context.diagnostics ?? [], effects: emptyEffects(), ...(retainedPreflight === undefined ? {} : { retainedPreflight }) });
}

type MutableRetainedPreflight = {
  configurationRevision?: ContentDigest;
  trustFingerprint?: ContentDigest;
};
function retainedPreflight(value: MutableRetainedPreflight): NativeLifecycleRetainedPreflightEvidence | undefined {
  if (value.configurationRevision === undefined && value.trustFingerprint === undefined) return undefined;
  return {
    configuration: value.configurationRevision !== undefined,
    trust: value.trustFingerprint !== undefined,
    ...(value.configurationRevision === undefined ? {} : { configurationRevision: value.configurationRevision }),
    ...(value.trustFingerprint === undefined ? {} : { trustFingerprint: value.trustFingerprint }),
  };
}

function matchingConfirmation(operation: VerifiedNativeLifecycleOperationContext["operation"], confirmation: NativeLifecycleOperationConfirmation): boolean {
  if (confirmation.kind === "deny") return true;
  if (operation === "enable" || operation === "disable") return confirmation.kind === "confirm" && confirmation.operation === operation;
  if (operation === "update") return confirmation.kind === "confirm-update";
  return confirmation.kind === "confirm-uninstall";
}

async function currentProjectRoot(target: VerifiedNativeLifecycleTarget, dependencies: NativeLifecycleOperationDependencies, signal: AbortSignal): Promise<TrustedProjectRoot | undefined> {
  if (target.scope.kind === "user") return undefined;
  const root = await dependencies.projectRoots.acquire(signal);
  if (dependencies.projectRoots.revalidate !== undefined) await dependencies.projectRoots.revalidate(root, target.scope, signal);
  else dependencies.projectRoots.verify(root, target.scope);
  return root;
}

function sourceContext(candidate: PreparedNativeLifecycleUpdate["candidate"]): import("./source-materialization.js").SourceContext {
  return candidate.resolved.entry.source.value.kind === "marketplace-path"
    ? { kind: "marketplace", root: candidate.resolved.marketplace.root, source: candidate.resolved.marketplace.source, contentRootDigest: candidate.resolved.marketplace.content.rootDigest, content: candidate.resolved.marketplace.content, binding: candidate.resolved.marketplace.binding }
    : { kind: "external" };
}

async function executeUpdate(
  context: VerifiedNativeLifecycleOperationContext & Readonly<{ update: PreparedNativeLifecycleUpdate }>,
  confirmation: Extract<NativeLifecycleOperationConfirmation, { kind: "confirm-update" }>,
  dependencies: NativeLifecycleOperationDependencies,
  progress: NativeLifecycleProgressRecorder,
  signal: AbortSignal,
): Promise<NativeLifecycleOperationResult> {
  const validated = await dependencies.updates.validate(context.update, signal);
  if (validated.kind === "current-state") return currentState(context, progress, "revision-current", validated.target);
  if (validated.kind !== "ready") {
    if (validated.kind === "blocked") return terminal({ kind: "conflict", reason: "pending-transition" }, context, progress);
    if (validated.kind === "stale") return terminal({ kind: "stale", reason: validated.reason }, context, progress);
    return terminal({ kind: "rejected", code: "AVAILABLE_REVISION_CHANGED" }, context, progress);
  }
  const update = validated.update;
  const retained: MutableRetainedPreflight = {};
  const trustFingerprint = hashContent(new TextEncoder().encode(`native-lifecycle-trust-v1\0${canonicalJson(update.candidate.trust)}`), dependencies.sha256);
  if (confirmation.input.consent.consentId !== update.candidate.consent.consentId || confirmation.input.authority.trustFingerprint !== trustFingerprint) {
    return terminal({ kind: "stale", reason: "consent" }, context, progress);
  }
  const root = await currentProjectRoot(update.target, dependencies, signal).catch(() => undefined);
  if (update.target.scope.kind === "project" && root === undefined) return terminal({ kind: "stale", reason: "project" }, context, progress);

  let configurationRevision: ContentDigest | undefined;
  if (update.candidate.binding.configurationRef !== undefined) {
    await progress.emit({ phase: "configuration-custody", state: "started", plugin: update.target.binding.plugin });
    const authorityRequest = {
      configurationRef: update.candidate.binding.configurationRef,
      plugin: update.candidate.binding.plugin,
      scope: update.candidate.binding.scope,
      descriptors: update.candidate.plugin.configuration,
    };
    const current = await dependencies.configurationAuthority.readCurrent(authorityRequest, signal);
    if (current.kind === "stale" || current.kind === "unavailable") return terminal({ kind: "stale", reason: "configuration" }, context, progress);
    const observedConfigurationRevision = current.kind === "current" ? current.document.revision : null;
    if (observedConfigurationRevision !== confirmation.input.authority.configurationRevision) {
      return terminal({ kind: "stale", reason: "configuration" }, context, progress);
    }
    const trustedInput = {
      expectedVersion: 0,
      nonSensitive: confirmation.input.nonSensitive,
      sensitive: confirmation.input.sensitive,
      consent: confirmation.input.consent,
    } as const;
    const noInput = trustedInput.nonSensitive.length === 0 && trustedInput.sensitive.length === 0;
    const currentReady = current.kind === "current" && update.candidate.fields.every((field) => field.state !== "invalid" && field.state !== "unavailable" && (!field.required || field.state === "configured" || field.state === "defaulted"));
    if (noInput && currentReady) {
      configurationRevision = current.document.revision;
      retained.configurationRevision = configurationRevision;
    } else {
      const validation = await validateTrustedInstallSubmission(update.candidate.fields, trustedInput, {
        ...dependencies.configurationInput(update.candidate, root),
        configurationRef: update.candidate.binding.configurationRef,
        plugin: update.candidate.binding.plugin,
        scope: update.candidate.resolved.scope,
        descriptors: update.candidate.plugin.configuration,
        ...(current.kind === "current" ? { existing: current.document } : {}),
      }, signal);
      if (validation.kind === "invalid") return terminal({ kind: "rejected", code: "UNCONFIGURED" }, context, progress);
      const saved = await dependencies.configuration.save(validation.request, signal);
      if (saved.kind === "stale") return terminal({ kind: "stale", reason: "configuration" }, context, progress, retainedPreflight(retained));
      if (saved.kind === "secret-collision") return terminal({ kind: "rejected", code: "MALFORMED" }, context, progress, retainedPreflight(retained));
      if (saved.kind === "stored") {
        configurationRevision = saved.document.revision;
        retained.configurationRevision = configurationRevision;
      } else {
        const recovery = saved.kind === "ambiguous-with-recovery-required"
          ? saved.recovery.recovery
          : saved.cleanup.recovery;
        let settlement: Awaited<ReturnType<ConfigurationRecoveryCapability["settle"]>>;
        try {
          settlement = await recovery.settle(signal);
        } catch (error) {
          throw new NativeLifecycleConfigurationRecoveryError(
            recovery,
            saved.kind === "ambiguous-with-recovery-required" ? "ADAPTER_FAILED" : "CLEANUP_FAILED",
            retainedPreflight(retained),
            { cause: error },
          );
        }
        if (settlement.kind === "recovery-required") {
          throw new NativeLifecycleConfigurationRecoveryError(
            recovery,
            saved.kind === "ambiguous-with-recovery-required" ? "ADAPTER_FAILED" : "CLEANUP_FAILED",
            retainedPreflight(retained),
          );
        }
        if (saved.kind === "stale-with-cleanup-required" || settlement.kind === "stale") {
          return terminal({ kind: "stale", reason: "configuration" }, context, progress, retainedPreflight(retained));
        }
        const document = settlement.kind === "stored"
          ? settlement.document
          : saved.kind === "stored-with-cleanup-required"
            ? saved.document
            : undefined;
        if (document === undefined) throw new NativeLifecycleConfigurationRecoveryError(recovery, "ADAPTER_FAILED", retainedPreflight(retained));
        configurationRevision = document.revision;
        retained.configurationRevision = configurationRevision;
      }
    }
    await progress.emit({ phase: "configuration-custody", state: "completed", plugin: update.target.binding.plugin });
  } else {
    if (confirmation.input.authority.configurationRevision !== null) return terminal({ kind: "stale", reason: "configuration" }, context, progress);
    if (confirmation.input.nonSensitive.length > 0 || confirmation.input.sensitive.length > 0) {
      return terminal({ kind: "rejected", code: "UNCONFIGURED" }, context, progress);
    }
  }

  await progress.emit({ phase: "trust-decision", state: "started", plugin: update.target.binding.plugin });
  let granted: Awaited<ReturnType<ExactTrustGrantService["grant"]>>;
  try {
    granted = await dependencies.trust.grant({ candidate: update.candidate.trust, scope: update.candidate.resolved.scope, ...(root === undefined ? {} : { projectRoot: root }) }, signal);
  } catch {
    return terminal({ kind: "failed", code: "ADAPTER_FAILED" }, context, progress, retainedPreflight(retained));
  }
  if ((granted.kind === "recorded" || granted.kind === "already-recorded") || ("recorded" in granted && granted.recorded === true) || (granted.kind === "recovery-required" && granted.committed !== undefined)) {
    retained.trustFingerprint = trustFingerprint;
  }
  if (granted.kind === "stale") return terminal({ kind: "conflict", reason: "concurrent-mutation" }, context, progress, retainedPreflight(retained));
  if (granted.kind === "project-stale") return terminal({ kind: "stale", reason: "project" }, context, progress, retainedPreflight(retained));
  if (granted.kind === "project-untrusted") return terminal({ kind: "rejected", code: "PROJECT_UNTRUSTED" }, context, progress, retainedPreflight(retained));
  if (granted.kind === "recovery-required") return terminal({ kind: "recovery-required", code: "ADAPTER_FAILED", ...(granted.committed === undefined ? {} : { committed: granted.committed }), action: "run-recovery" }, context, progress, retainedPreflight(retained));
  // Some tests/adapters historically spell the successful exact grant as
  // `granted`; all non-terminal outcomes here mean the exact subject is held.
  retained.trustFingerprint = trustFingerprint;
  await progress.emit({ phase: "trust-decision", state: "completed", plugin: update.target.binding.plugin });

  let revalidated: Awaited<ReturnType<NativeLifecycleUpdateService["validate"]>>;
  try { revalidated = await dependencies.updates.validate(update, signal); }
  catch { return terminal({ kind: "failed", code: "ADAPTER_FAILED" }, context, progress, retainedPreflight(retained)); }
  if (revalidated.kind === "current-state") {
    const result = currentState(context, progress, "revision-current", revalidated.target);
    return NativeLifecycleOperationResultSchema.parse({ ...result, retainedPreflight: retainedPreflight(retained) });
  }
  if (revalidated.kind !== "ready") return terminal({ kind: revalidated.kind === "blocked" ? "conflict" : "stale", ...(revalidated.kind === "blocked" ? { reason: "pending-transition" } : { reason: "candidate" }) } as never, context, progress, retainedPreflight(retained));
  let evidenceCurrent: "current" | "stale";
  try {
    const validateEvidence = dependencies.evidence.validateForInstall?.bind(dependencies.evidence) ?? dependencies.evidence.validate.bind(dependencies.evidence);
    evidenceCurrent = await validateEvidence(update.candidate.snapshotBinding, signal);
  } catch { return terminal({ kind: "failed", code: "ADAPTER_FAILED" }, context, progress, retainedPreflight(retained)); }
  if (evidenceCurrent !== "current") return terminal({ kind: "stale", reason: update.target.binding.scope.kind === "project" ? "project" : "capability" }, context, progress, retainedPreflight(retained));
  if (root !== undefined && dependencies.projectRoots.revalidate !== undefined) {
    try { await dependencies.projectRoots.revalidate(root, revalidated.update.target.scope, signal); }
    catch { return terminal({ kind: "stale", reason: "project" }, context, progress, retainedPreflight(retained)); }
  }
  if (update.candidate.binding.configurationRef !== undefined && configurationRevision !== undefined) {
    const exact = await dependencies.configurationAuthority.readExact({ configurationRef: update.candidate.binding.configurationRef, plugin: update.candidate.binding.plugin, scope: update.candidate.binding.scope, descriptors: update.candidate.plugin.configuration, expectedRevision: configurationRevision }, signal);
    if (exact.kind !== "current") return terminal({ kind: "stale", reason: "configuration" }, context, progress, retainedPreflight(retained));
  }

  await progress.emit({ phase: "lifecycle-transaction", state: "started", plugin: update.target.binding.plugin });
  let result;
  try {
    result = await dependencies.lifecycle.prepared.updatePrepared({
      scope: revalidated.update.target.scope,
      plugin: update.candidate.binding.plugin,
      entry: update.candidate.resolved.entry,
      marketplaceSource: update.candidate.resolved.marketplace.source,
      sourceContext: sourceContext(update.candidate),
      lease: update.candidate.lease,
      expected: update.candidate.binding,
      ...(configurationRevision === undefined ? {} : { expectedConfigurationRevision: configurationRevision }),
      configurationPathContext: dependencies.configurationInput(update.candidate, root).pathContext,
      expectedTarget: revalidated.update.target.expectation,
    }, signal);
  } catch (error) {
    if (isCandidateContentCleanupError(error)) {
      Object.assign(error, { retainedPreflight: retainedPreflight(retained) });
      throw error;
    }
    return terminal({ kind: "failed", code: "ADAPTER_FAILED" }, context, progress, retainedPreflight(retained));
  }
  await progress.emit({ phase: "lifecycle-transaction", state: "completed", plugin: update.target.binding.plugin });
  const counts = update.candidate.detail.compatibility.components.counts;
  const projected = projectPluginLifecycleResult({ result, target: context.target, previewId: context.previewId, progress: progress.events(), ...(context.diagnostics === undefined ? {} : { diagnostics: context.diagnostics }), components: { skills: counts.skills, hooks: counts.hooks, mcpServers: counts.mcpServers }, sha256: dependencies.sha256 });
  return NativeLifecycleOperationResultSchema.parse({ ...projected, retainedPreflight: retainedPreflight(retained) });
}

/** Execute only an internally verified preview context through existing authorities. */
export async function executeNativeLifecycleOperation(
  context: VerifiedNativeLifecycleOperationContext,
  confirmation: NativeLifecycleOperationConfirmation,
  dependencies: NativeLifecycleOperationDependencies,
  progress: NativeLifecycleProgressRecorder,
  signal: AbortSignal,
): Promise<NativeLifecycleOperationResult> {
  if (!matchingConfirmation(context.operation, confirmation)) return terminal({ kind: "stale", reason: "session" }, context, progress);
  if (confirmation.kind === "deny") return terminal({ kind: "cancelled", phase: "preflight" }, context, progress);
  await progress.emit({ phase: "authority-revalidation", state: "started", plugin: context.target.binding.plugin });
  const validated = await dependencies.targets.validate(context.target, signal);
  if (validated.kind !== "ready") {
    if (validated.kind === "blocked") return terminal({ kind: "conflict", reason: "pending-transition" }, context, progress);
    return terminal({ kind: "stale", reason: validated.reason === "project" ? "project" : validated.reason === "capability" ? "capability" : "target" }, context, progress);
  }
  await progress.emit({ phase: "authority-revalidation", state: "completed", plugin: context.target.binding.plugin });
  const target = validated.target;
  if (context.operation === "enable" && target.binding.activation === "enabled") return currentState(context, progress, "already-enabled", target);
  if (context.operation === "disable" && target.binding.activation === "disabled") return currentState(context, progress, "already-disabled", target);
  if (context.operation === "update") {
    if (context.update === undefined || confirmation.kind !== "confirm-update") return terminal({ kind: "stale", reason: "session" }, context, progress);
    return executeUpdate({ ...context, update: context.update }, confirmation, dependencies, progress, signal);
  }

  let result;
  await progress.emit({ phase: "lifecycle-transaction", state: "started", plugin: target.binding.plugin });
  if (context.operation === "enable") {
    let root: TrustedProjectRoot | undefined;
    try { root = await currentProjectRoot(target, dependencies, signal); }
    catch { return terminal({ kind: "stale", reason: "project" }, context, progress); }
    const pathContext = dependencies.configurationPathContext(target, root);
    result = await dependencies.lifecycle.application.enable({ scope: target.scope, plugin: target.binding.plugin, configurationPathContext: pathContext, expectedTarget: target.expectation }, signal);
  } else if (context.operation === "disable") {
    result = await dependencies.lifecycle.application.disable({ scope: target.scope, plugin: target.binding.plugin, expectedTarget: target.expectation }, signal);
  } else {
    if (confirmation.kind !== "confirm-uninstall") return terminal({ kind: "stale", reason: "session" }, context, progress);
    result = await dependencies.lifecycle.application.uninstall({ scope: target.scope, plugin: target.binding.plugin, retainedData: confirmation.persistentData, expectedTarget: target.expectation }, signal);
  }
  await progress.emit({ phase: "lifecycle-transaction", state: "completed", plugin: target.binding.plugin });
  let cleanupPersistentData: "retained" | "deleted" | "recovery-required" | undefined;
  if (context.operation === "uninstall" && confirmation.kind === "confirm-uninstall" && result.kind === "changed") {
    cleanupPersistentData = confirmation.persistentData === "keep" ? "retained" : "recovery-required";
    if (confirmation.persistentData === "delete-confirmed" && result.cleanup !== undefined) {
      await progress.emit({ phase: "uninstall-cleanup", state: "started", plugin: target.binding.plugin });
      const cleanup = await dependencies.uninstallCleanup.complete({ scope: target.binding.scope, reference: result.cleanup.transition }, signal);
      cleanupPersistentData = cleanup.kind === "deleted" ? "deleted" : cleanup.kind === "retained" ? "retained" : "recovery-required";
      await progress.emit({ phase: "uninstall-cleanup", state: cleanup.kind === "recovery-required" ? "failed" : "completed", plugin: target.binding.plugin, ...(cleanup.kind === "recovery-required" ? { code: "CLEANUP_FAILED" } : {}) });
      if (cleanup.kind === "recovery-required") {
        return NativeLifecycleOperationResultSchema.parse({ kind: "recovery-required", operation: "uninstall", previewId: context.previewId, progress: progress.events(), diagnostics: context.diagnostics ?? [], effects: { state: "changed", projectFile: "unchanged", completedActionIds: [], pendingActionIds: [], generation: result.snapshot.generation }, code: "CLEANUP_FAILED", transition: cleanup.reference, committed: result.snapshot.generation, action: "run-recovery" });
      }
    }
  }
  return projectPluginLifecycleResult({ result, target: context.target, previewId: context.previewId, progress: progress.events(), ...(context.diagnostics === undefined ? {} : { diagnostics: context.diagnostics }), ...(confirmation.kind === "confirm-uninstall" ? { persistentData: confirmation.persistentData } : {}), ...(cleanupPersistentData === undefined ? {} : { cleanupPersistentData }), sha256: dependencies.sha256 });
}

export function createNativeLifecycleOperationExecutor(dependencies: NativeLifecycleOperationDependencies) {
  return Object.freeze({
    async execute(context: VerifiedNativeLifecycleOperationContext, confirmation: NativeLifecycleOperationConfirmation, options: Readonly<{ onProgress?: import("./native-lifecycle-operation-contract.js").NativeLifecycleProgressSink }>, signal: AbortSignal) {
      const progress = createNativeLifecycleProgressRecorder(context.operation, options.onProgress);
      return executeNativeLifecycleOperation(context, confirmation, dependencies, progress, signal);
    },
  });
}
