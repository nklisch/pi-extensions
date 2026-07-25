import { compareUtf8 } from "../domain/canonical-json.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { Sha256 } from "../domain/source.js";
import {
  ConfigurationCleanupError,
  type BoundPluginConfigurationService,
  type ConfigurationRecoverySettlement,
} from "./configuration-service.js";
import type { ExactTrustGrantService } from "./exact-trust-grant-service.js";
import type { LifecycleOperationIdPort } from "./ports/lifecycle-operation-id.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { NativeInspectionEvidencePort } from "./ports/native-inspection-evidence.js";
import type { ProjectRootAuthorityPort, TrustedProjectRoot } from "./ports/project-root-authority.js";
import {
  type TrustedInstallCandidate,
  type TrustedInstallCandidateService,
} from "./trusted-install-candidate.js";
import {
  isCandidateContentCleanupError,
  type CandidateContentCleanupRecovery,
  type CandidateContentLease,
} from "./ports/candidate-content-lease.js";
import {
  TrustedInstallActivationResultSchema,
  TrustedInstallCancellationResultSchema,
  TrustedInstallOpenRequestSchema,
  TrustedInstallOpenResultSchema,
  TrustedInstallSessionViewSchema,
  TrustedInstallStatusResultSchema,
  TrustedInstallSubmissionSchema,
  type TrustedInstallActivationResult,
  type TrustedInstallExecutionOptions,
  type TrustedInstallationService,
  type TrustedInstallInputIssue,
  type TrustedInstallProgressEvent,
  type TrustedInstallRunOptions,
  type TrustedInstallSessionState,
  type TrustedInstallSessionView,
} from "./trusted-install-contract.js";
import { deriveInspectionEvidenceSnapshotId, decodeInspectionDetailId } from "./native-inspection-identifiers.js";
import { createTrustedInstallSessionRegistry, type TrustedInstallSessionEntry } from "./trusted-install-session.js";
import {
  validateTrustedInstallSubmission,
  type TrustedInstallConfigurationAuthority,
  type TrustedInstallConfigurationDependencies,
} from "./trusted-install-configuration.js";
import { executeTrustedInstallLifecycle, type TrustedInstallLifecycleDependencies, type TrustedInstallLifecycleResult } from "./trusted-install-lifecycle.js";

export type TrustedInstallationServiceDependencies = Readonly<{
  candidate: TrustedInstallCandidateService;
  configuration: BoundPluginConfigurationService;
  configurationAuthority: TrustedInstallConfigurationAuthority;
  configurationInput(candidate: TrustedInstallCandidate, projectRoot: TrustedProjectRoot | undefined): Omit<TrustedInstallConfigurationDependencies, "configurationRef" | "plugin" | "scope" | "descriptors">;
  trust: ExactTrustGrantService;
  lifecycle: TrustedInstallLifecycleDependencies;
  evidence: NativeInspectionEvidencePort;
  projectRoots: ProjectRootAuthorityPort;
  clock: LifecycleClock;
  sessionIds: LifecycleOperationIdPort;
  hostEpoch: ContentDigest;
  sha256: Sha256;
}>;

class ProjectAuthorityStale extends Error {}

function sortedIssues(input: readonly TrustedInstallInputIssue[]): readonly TrustedInstallInputIssue[] {
  const unique = new Map(input.map((issue) => [`${issue.key ?? ""}\0${issue.code}`, issue]));
  return Object.freeze([...unique.values()].sort((left, right) => {
    const key = compareUtf8(left.key ?? "", right.key ?? "");
    return key !== 0 ? key : compareUtf8(left.code, right.code);
  }));
}

function resultState(result: TrustedInstallActivationResult): TrustedInstallSessionState {
  return result.kind === "needs-input" ? "awaiting-input" : result.kind;
}

export function createTrustedInstallationService(dependencies: TrustedInstallationServiceDependencies): Readonly<{
  application: TrustedInstallationService;
  quiesce(): void;
  close(): Promise<void>;
}> {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("trusted installation dependencies are required");
  const registry = createTrustedInstallSessionRegistry({ clock: dependencies.clock, sessionIds: dependencies.sessionIds, hostEpoch: dependencies.hostEpoch, sha256: dependencies.sha256 });
  const pendingCandidateCleanup = new Set<CandidateContentCleanupRecovery>();
  let quiesced = false;

  function cleanupRecoveryForLease(lease: CandidateContentLease): CandidateContentCleanupRecovery {
    return Object.freeze({ retry: () => lease.release() }) as CandidateContentCleanupRecovery;
  }

  function retainCandidateCleanup(error: unknown, lease?: CandidateContentLease): boolean {
    if (isCandidateContentCleanupError(error)) {
      pendingCandidateCleanup.add(error.recovery);
      return true;
    }
    if (lease !== undefined) {
      pendingCandidateCleanup.add(cleanupRecoveryForLease(lease));
      return true;
    }
    return false;
  }

  function progress(entry: TrustedInstallSessionEntry, phase: TrustedInstallProgressEvent["phase"], state: TrustedInstallProgressEvent["state"], options?: TrustedInstallExecutionOptions, code?: string): void {
    const event = Object.freeze({
      sequence: entry.progress.length === 0 ? 0 : entry.progress.at(-1)!.sequence + 1,
      phase, state, plugin: entry.candidate.binding.plugin, scope: entry.candidate.binding.scope,
      revision: entry.candidate.binding.immutableRevision,
      ...(code === undefined ? {} : { code }),
    }) as TrustedInstallProgressEvent;
    entry.progress.push(event);
    while (entry.progress.length > 32) entry.progress.shift();
    if (options?.onProgress !== undefined) {
      Promise.resolve().then(() => options.onProgress!(event)).catch(() => {
        const delivery = Object.freeze({ ...event, sequence: entry.progress.at(-1)!.sequence + 1, state: "failed" as const, code: "PROGRESS_DELIVERY_FAILED" });
        entry.progress.push(delivery);
        while (entry.progress.length > 32) entry.progress.shift();
      });
    }
  }

  function view(entry: TrustedInstallSessionEntry): TrustedInstallSessionView {
    return TrustedInstallSessionViewSchema.parse({
      token: entry.token,
      version: entry.version,
      state: entry.state,
      expiresAt: registry.expiresAt(entry),
      binding: entry.candidate.binding,
      candidate: entry.candidate.detail,
      fields: entry.candidate.fields,
      consent: entry.candidate.consent,
      progress: entry.progress,
      retained: entry.retained,
    });
  }

  async function finish(entry: TrustedInstallSessionEntry, resultInput: TrustedInstallActivationResult): Promise<TrustedInstallActivationResult> {
    const result = TrustedInstallActivationResultSchema.parse(resultInput);
    registry.finish(entry, resultState(result), result);
    try {
      await entry.candidate.lease.release();
      return result;
    } catch (error) {
      retainCandidateCleanup(error, entry.candidate.lease);
      const cleanupFailure = TrustedInstallActivationResultSchema.parse({
        kind: "failed", code: "CLEANUP_FAILED", progress: entry.progress, retained: safeRetained(entry),
      });
      registry.finish(entry, "failed", cleanupFailure);
      return cleanupFailure;
    }
  }

  function safeRetained(entry: TrustedInstallSessionEntry) { return { ...entry.retained }; }
  function conflict(entry: TrustedInstallSessionEntry, reason: "already-installed-different-revision" | "operation-in-progress" | "pending-transition" | "concurrent-mutation"): TrustedInstallActivationResult {
    return TrustedInstallActivationResultSchema.parse({ kind: "conflict", reason, progress: entry.progress, retained: safeRetained(entry) });
  }
  function stale(entry: TrustedInstallSessionEntry, reason: "session" | "candidate" | "configuration" | "consent" | "project" | "capability"): TrustedInstallActivationResult {
    return TrustedInstallActivationResultSchema.parse({ kind: "stale", reason, progress: entry.progress, retained: safeRetained(entry) });
  }
  function cancelled(entry: TrustedInstallSessionEntry, phase: TrustedInstallProgressEvent["phase"]): TrustedInstallActivationResult {
    return TrustedInstallActivationResultSchema.parse({ kind: "cancelled", phase, progress: entry.progress, retained: safeRetained(entry) });
  }

  function pauseForWorkflowRecovery(
    entry: TrustedInstallSessionEntry,
    action: "retry-configuration-recovery" | "retry-trust-recovery",
  ): TrustedInstallActivationResult {
    entry.state = "recovery-required";
    const result = TrustedInstallActivationResultSchema.parse({
      kind: "recovery-required",
      action,
      session: view(entry),
      progress: entry.progress,
      retained: safeRetained(entry),
    });
    registry.pause(entry, "recovery-required", result);
    return result;
  }

  async function settleConfigurationRecovery(
    entry: TrustedInstallSessionEntry,
    signal: AbortSignal,
  ): Promise<"current" | "retry" | "stale" | "pending"> {
    const pending = entry.configurationRecovery;
    if (pending === undefined) return "current";
    let settlement: ConfigurationRecoverySettlement;
    try {
      settlement = await pending.recovery.settle(signal);
    } catch {
      return "pending";
    }
    if (settlement.kind === "recovery-required") return "pending";
    if (pending.kind === "stale-cleanup" || settlement.kind === "stale") {
      delete entry.configurationRecovery;
      return "stale";
    }
    if (pending.kind === "retry-save") {
      delete entry.configurationRecovery;
      return "retry";
    }
    const document = settlement.kind === "stored"
      ? settlement.document
      : pending.kind === "stored-cleanup"
        ? pending.document
        : undefined;
    if (document === undefined) return "pending";
    delete entry.configurationRecovery;
    entry.configurationRevision = document.revision;
    entry.retained.configuration = true;
    return "current";
  }

  async function projectRoot(candidate: TrustedInstallCandidate, signal: AbortSignal): Promise<TrustedProjectRoot | undefined> {
    if (candidate.binding.scope.kind === "user") return undefined;
    try {
      const root = await dependencies.projectRoots.acquire(signal);
      const scope = candidate.resolved.scope;
      dependencies.projectRoots.verify(root, scope);
      if (dependencies.projectRoots.revalidate !== undefined) await dependencies.projectRoots.revalidate(root, scope, signal);
      return root;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw new ProjectAuthorityStale();
    }
  }

  async function terminalFromLifecycle(entry: TrustedInstallSessionEntry, lifecycle: TrustedInstallLifecycleResult): Promise<TrustedInstallActivationResult> {
    if (lifecycle.kind === "boundary-failure") {
      if (lifecycle.reason === "aborted") return finish(entry, cancelled(entry, "activation-transaction"));
      return finish(entry, {
        kind: "failed",
        code: lifecycle.reason === "cleanup-failed" ? "CLEANUP_FAILED" : "ADAPTER_FAILED",
        progress: entry.progress,
        retained: safeRetained(entry),
      });
    }
    if (lifecycle.kind === "current-state") {
      progress(entry, "activation-observation", "completed");
      return finish(entry, { kind: "current-state", plugin: entry.candidate.binding.plugin, scope: entry.candidate.binding.scope, revision: lifecycle.revision, activation: lifecycle.activation, reason: "already-active", progress: entry.progress, retained: safeRetained(entry) });
    }
    if (lifecycle.kind === "conflict") return finish(entry, conflict(entry, lifecycle.reason));
    if (lifecycle.kind === "recovery-required") return finish(entry, { kind: "recovery-required", action: "run-recovery", progress: entry.progress, retained: safeRetained(entry) });
    const result = lifecycle.result;
    if (result.kind === "changed") {
      if (lifecycle.enabledExisting) {
        progress(entry, "activation-observation", "completed");
        progress(entry, "completed", "completed");
        return finish(entry, { kind: "current-state", plugin: entry.candidate.binding.plugin, scope: entry.candidate.binding.scope, revision: entry.candidate.binding.immutableRevision, activation: "enabled", reason: "enabled-existing", progress: entry.progress, retained: safeRetained(entry) });
      }
      const observation = result.observation;
      if (observation.kind !== "active" || observation.plugin !== entry.candidate.binding.plugin || observation.revision !== entry.candidate.binding.immutableRevision || JSON.stringify(observation.scope) !== JSON.stringify(entry.candidate.binding.scope)) {
        return finish(entry, { kind: "recovery-required", action: "run-recovery", progress: entry.progress, retained: safeRetained(entry) });
      }
      progress(entry, "activation-observation", "completed");
      progress(entry, "completed", "completed");
      const counts = entry.candidate.detail.compatibility.components.counts;
      return finish(entry, {
        kind: "succeeded", plugin: entry.candidate.binding.plugin, scope: entry.candidate.binding.scope,
        revision: entry.candidate.binding.immutableRevision, projectionDigest: observation.projectionDigest,
        components: { skills: counts.skills, hooks: counts.hooks, mcpServers: counts.mcpServers },
        progress: entry.progress,
        diagnostics: entry.candidate.detail.diagnostics.filter((diagnostic) => diagnostic.category !== "trust" && diagnostic.category !== "configuration" && diagnostic.category !== "freshness"),
        retained: safeRetained(entry),
      });
    }
    if (result.kind === "unchanged") return finish(entry, { kind: "current-state", plugin: entry.candidate.binding.plugin, scope: entry.candidate.binding.scope, revision: entry.candidate.binding.immutableRevision, activation: "enabled", reason: "already-active", progress: entry.progress, retained: safeRetained(entry) });
    if (result.kind === "stale") return finish(entry, conflict(entry, "concurrent-mutation"));
    if (result.kind === "rolled-back") return finish(entry, { kind: "rolled-back", failure: result.failure.kind, restored: true, progress: entry.progress, retained: safeRetained(entry) });
    if (result.kind === "recovery-required") return finish(entry, { kind: "recovery-required", transition: result.transition, ...(result.committed === undefined ? {} : { committed: result.committed }), action: "run-recovery", progress: entry.progress, retained: safeRetained(entry) });
    if (result.code === "ABORTED") return finish(entry, cancelled(entry, "activation-transaction"));
    if (result.code === "AVAILABLE_REVISION_CHANGED") return finish(entry, stale(entry, "candidate"));
    if (result.code === "CONFIGURATION_STALE") return finish(entry, stale(entry, "configuration"));
    if (result.code === "ALREADY_INSTALLED") return finish(entry, conflict(entry, "already-installed-different-revision"));
    if (result.code === "PENDING_TRANSITION") return finish(entry, conflict(entry, "pending-transition"));
    return finish(entry, { kind: "rejected", code: result.code, diagnostics: entry.candidate.detail.diagnostics, progress: entry.progress, retained: safeRetained(entry) });
  }

  async function open(requestInput: unknown, signal: AbortSignal) {
    if (quiesced) return TrustedInstallOpenResultSchema.parse({ kind: "unavailable", code: "DISPOSED", diagnostics: [] });
    const request = TrustedInstallOpenRequestSchema.parse(requestInput);
    await registry.reap();
    const snapshot = await dependencies.evidence.capture(signal).catch((error) => {
      if (signal.aborted) throw signal.reason ?? error;
      return undefined;
    });
    if (snapshot === undefined) return TrustedInstallOpenResultSchema.parse({ kind: "unavailable", code: "EVIDENCE_UNAVAILABLE", diagnostics: [] });
    if (deriveInspectionEvidenceSnapshotId(snapshot.binding, dependencies.sha256) !== request.inspectionSnapshotId) return TrustedInstallOpenResultSchema.parse({ kind: "stale", reason: "candidate" });
    const subject = decodeInspectionDetailId(request.detailId, dependencies.sha256);
    if (subject === undefined) return TrustedInstallOpenResultSchema.parse({ kind: "rejected", code: "INSPECTION_ID_INVALID", diagnostics: [] });
    if (subject.subject !== "marketplace-candidate") return TrustedInstallOpenResultSchema.parse({ kind: "rejected", code: "INSPECTION_SUBJECT_UNSUPPORTED", diagnostics: [] });
    if (subject.scope.kind === "project") {
      if (snapshot.binding.currentProject.projectKey !== subject.scope.projectKey) {
        return TrustedInstallOpenResultSchema.parse({ kind: "stale", reason: "project" });
      }
      if (snapshot.binding.currentProject.trust.kind !== "trusted") {
        return TrustedInstallOpenResultSchema.parse({ kind: "rejected", code: "PROJECT_UNTRUSTED", diagnostics: [] });
      }
    }
    const acquired = await dependencies.candidate.acquire({ subject, snapshot }, signal);
    if (acquired.kind !== "ready") {
      if (acquired.kind === "stale") return TrustedInstallOpenResultSchema.parse({ kind: "stale", reason: "candidate" });
      if (acquired.kind === "cleanup-failed") {
        pendingCandidateCleanup.add(acquired.cleanup);
        return TrustedInstallOpenResultSchema.parse({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: acquired.diagnostics });
      }
      return TrustedInstallOpenResultSchema.parse({ kind: acquired.kind, code: acquired.kind === "unavailable" ? "CANDIDATE_UNAVAILABLE" : "CANDIDATE_REJECTED", diagnostics: acquired.diagnostics });
    }
    const releaseAcquired = async (): Promise<"released" | "cleanup-failed"> => {
      try {
        await acquired.candidate.lease.release();
        return "released";
      } catch (error) {
        retainCandidateCleanup(error, acquired.candidate.lease);
        return "cleanup-failed";
      }
    };
    try {
      if (await dependencies.candidate.validate(acquired.candidate, signal) !== "current" ||
          await dependencies.evidence.validate(acquired.candidate.snapshotBinding, signal) !== "current") {
        const released = await releaseAcquired();
        return TrustedInstallOpenResultSchema.parse(released === "released"
          ? { kind: "stale", reason: acquired.candidate.binding.scope.kind === "project" ? "project" : "candidate" }
          : { kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] });
      }
      // A project inspection token is not root authority. Prove the current
      // canonical project independently before publishing a resumable session.
      await projectRoot(acquired.candidate, signal);
    } catch (error) {
      const released = await releaseAcquired();
      if (released === "cleanup-failed") return TrustedInstallOpenResultSchema.parse({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] });
      if (error instanceof ProjectAuthorityStale) return TrustedInstallOpenResultSchema.parse({ kind: "stale", reason: "project" });
      if (signal.aborted) throw signal.reason ?? error;
      return TrustedInstallOpenResultSchema.parse({ kind: "unavailable", code: "EVIDENCE_UNAVAILABLE", diagnostics: [] });
    }
    let entry: TrustedInstallSessionEntry;
    try {
      entry = await registry.create(acquired.candidate, signal);
    } catch (error) {
      const released = await releaseAcquired();
      if (released === "cleanup-failed") {
        return TrustedInstallOpenResultSchema.parse({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] });
      }
      if (signal.aborted) throw signal.reason ?? error;
      return TrustedInstallOpenResultSchema.parse({ kind: "unavailable", code: "SESSION_UNAVAILABLE", diagnostics: [] });
    }
    progress(entry, "candidate-acquisition", "completed");
    return TrustedInstallOpenResultSchema.parse({ kind: "opened", session: view(entry) });
  }

  async function activate(request: Readonly<{ token: import("./trusted-install-contract.js").TrustedInstallSessionToken; submission: import("./trusted-install-contract.js").TrustedInstallSubmission }>, options: TrustedInstallExecutionOptions, callerSignal: AbortSignal): Promise<TrustedInstallActivationResult> {
    if (quiesced) return TrustedInstallActivationResultSchema.parse({ kind: "disposed" });
    const lookup = await registry.lookup(request.token);
    if (lookup.kind !== "found") return TrustedInstallActivationResultSchema.parse({ kind: lookup.kind });
    const entry = lookup.entry;
    if (entry.result !== undefined) return entry.result;
    if (entry.state === "activating") return conflict(entry, "operation-in-progress");
    const submission = TrustedInstallSubmissionSchema.parse(request.submission);
    if (submission.expectedVersion !== entry.version) return stale(entry, "session");
    entry.state = "activating";
    entry.version += 1;
    const signal = AbortSignal.any([callerSignal, entry.controller.signal]);
    let phase: TrustedInstallProgressEvent["phase"] = "input-validation";
    try {
      progress(entry, phase, "started", options);
      const validateInstallAuthority = dependencies.evidence.validateForInstall?.bind(dependencies.evidence) ?? dependencies.evidence.validate.bind(dependencies.evidence);
      const candidateCurrent = await dependencies.candidate.validate(entry.candidate, signal);
      const evidenceCurrent = await validateInstallAuthority(entry.candidate.snapshotBinding, signal);
      if (candidateCurrent !== "current") return finish(entry, stale(entry, "candidate"));
      if (evidenceCurrent !== "current") return finish(entry, stale(entry, entry.candidate.binding.scope.kind === "project" ? "project" : "capability"));

      const issues: TrustedInstallInputIssue[] = [];
      if (submission.consent.consentId !== entry.candidate.consent.consentId) issues.push({ code: "CONSENT_STALE" });
      if (submission.consent.kind === "deny" && submission.consent.consentId === entry.candidate.consent.consentId) {
        progress(entry, phase, "completed", options);
        return finish(entry, cancelled(entry, phase));
      }
      const root = await projectRoot(entry.candidate, signal);
      let configurationRequest: import("./configuration-service.js").SavePluginConfigurationRequest | undefined;
      if (entry.candidate.binding.configurationRef !== undefined) {
        const authorityRequest = {
          configurationRef: entry.candidate.binding.configurationRef,
          plugin: entry.candidate.binding.plugin,
          scope: entry.candidate.binding.scope,
          descriptors: entry.candidate.plugin.configuration,
        };
        const current = entry.configurationRevision === undefined
          ? await dependencies.configurationAuthority.readCurrent(authorityRequest, signal)
          : await dependencies.configurationAuthority.readExact({
              ...authorityRequest,
              expectedRevision: entry.configurationRevision,
            }, signal);
        if (current.kind === "stale" || current.kind === "unavailable") return finish(entry, stale(entry, "configuration"));
        if (entry.configurationRevision !== undefined && current.kind === "current") {
          entry.retained.configuration = true;
        } else {
          const noConfigurationInput = submission.nonSensitive.length === 0 && submission.sensitive.length === 0;
          const currentSatisfiesFields = current.kind === "current" && entry.candidate.fields.every((field) =>
            field.state !== "invalid" && field.state !== "unavailable" &&
            (!field.required || field.state === "configured" || field.state === "defaulted"));
          if (noConfigurationInput && currentSatisfiesFields) {
            entry.configurationRevision = current.document.revision;
            entry.retained.configuration = true;
          } else {
            const input = dependencies.configurationInput(entry.candidate, root);
            const validation = await validateTrustedInstallSubmission(entry.candidate.fields, submission, {
              ...input,
              configurationRef: entry.candidate.binding.configurationRef,
              plugin: entry.candidate.binding.plugin,
              scope: entry.candidate.resolved.scope,
              descriptors: entry.candidate.plugin.configuration,
              ...(current.kind === "current" ? { existing: current.document } : {}),
            }, signal);
            if (validation.kind === "invalid") issues.push(...validation.issues);
            else configurationRequest = validation.request;
          }
        }
      } else if (submission.nonSensitive.length > 0 || submission.sensitive.length > 0) {
        for (const key of [...submission.nonSensitive, ...submission.sensitive].map((item) => item.key)) issues.push({ code: "CONFIG_UNKNOWN_KEY", key });
      }
      if (issues.length > 0) {
        progress(entry, phase, "failed", options, "INPUT_REQUIRED");
        registry.restore(entry);
        return TrustedInstallActivationResultSchema.parse({ kind: "needs-input", issues: sortedIssues(issues), session: view(entry) });
      }
      progress(entry, phase, "completed", options);
      signal.throwIfAborted();

      if (entry.candidate.binding.configurationRef !== undefined) {
        phase = "configuration-custody";
        progress(entry, phase, "started", options);
        if (entry.configurationRevision === undefined) {
          if (configurationRequest === undefined) throw new Error("configuration authority was not established");
          const saved = await dependencies.configuration.save(configurationRequest, signal);
          if (saved.kind === "stale") return finish(entry, stale(entry, "configuration"));
          if (saved.kind === "stale-with-cleanup-required") {
            entry.configurationRecovery = { kind: "stale-cleanup", recovery: saved.cleanup.recovery };
          } else if (saved.kind === "ambiguous-with-recovery-required") {
            entry.configurationRecovery = { kind: "ambiguous", recovery: saved.recovery.recovery };
          } else if (saved.kind === "stored-with-cleanup-required") {
            entry.retained.configuration = true;
            entry.configurationRecovery = {
              kind: "stored-cleanup",
              recovery: saved.cleanup.recovery,
              document: saved.document,
            };
          }
          if (entry.configurationRecovery !== undefined) {
            const settled = await settleConfigurationRecovery(entry, signal);
            if (settled === "pending") return pauseForWorkflowRecovery(entry, "retry-configuration-recovery");
            if (settled === "stale") return finish(entry, stale(entry, "configuration"));
            if (settled === "retry") throw new Error("configuration save recovery requires retry");
          }
          if (saved.kind === "secret-collision") return finish(entry, { kind: "rejected", code: saved.code, diagnostics: [], progress: entry.progress, retained: safeRetained(entry) });
          if (saved.kind === "stored") {
            entry.configurationRevision = saved.document.revision;
            entry.retained.configuration = true;
          }
        }
        progress(entry, phase, "completed", options);
      }
      signal.throwIfAborted();

      phase = "trust-decision";
      progress(entry, phase, "started", options);
      if (!entry.retained.trust) {
        const granted = await dependencies.trust.grant({ candidate: entry.candidate.trust, scope: entry.candidate.resolved.scope, ...(root === undefined ? {} : { projectRoot: root }) }, signal);
        if (granted.kind === "stale") return finish(entry, conflict(entry, "concurrent-mutation"));
        if (granted.kind === "project-stale") {
          if (granted.recorded === true) entry.retained.trust = true;
          return finish(entry, stale(entry, "project"));
        }
        if (granted.kind === "project-untrusted") {
          if (granted.recorded === true) entry.retained.trust = true;
          return finish(entry, { kind: "rejected", code: "PROJECT_UNTRUSTED", diagnostics: [], progress: entry.progress, retained: safeRetained(entry) });
        }
        if (granted.kind === "recovery-required") {
          entry.trustRecoveryPending = true;
          return pauseForWorkflowRecovery(entry, "retry-trust-recovery");
        }
        entry.retained.trust = true;
      }
      progress(entry, phase, "completed", options);
      signal.throwIfAborted();

      if (await dependencies.candidate.validate(entry.candidate, signal) !== "current") return finish(entry, stale(entry, "candidate"));
      if (await validateInstallAuthority(entry.candidate.snapshotBinding, signal) !== "current") {
        return finish(entry, stale(entry, entry.candidate.binding.scope.kind === "project" ? "project" : "capability"));
      }
      if (root !== undefined && dependencies.projectRoots.revalidate !== undefined) {
        try { await dependencies.projectRoots.revalidate(root, entry.candidate.resolved.scope, signal); }
        catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          return finish(entry, stale(entry, "project"));
        }
      }
      if (entry.candidate.binding.configurationRef !== undefined && entry.configurationRevision !== undefined) {
        const authority = await dependencies.configurationAuthority.readExact({
          configurationRef: entry.candidate.binding.configurationRef,
          plugin: entry.candidate.binding.plugin,
          scope: entry.candidate.binding.scope,
          descriptors: entry.candidate.plugin.configuration,
          expectedRevision: entry.configurationRevision,
        }, signal);
        if (authority.kind !== "current") return finish(entry, stale(entry, "configuration"));
      }

      phase = "activation-transaction";
      progress(entry, phase, "started", options);
      const lifecycle = await executeTrustedInstallLifecycle(
        entry.candidate,
        dependencies.configurationInput(entry.candidate, root).pathContext,
        dependencies.lifecycle,
        signal,
        entry.configurationRevision,
      );
      progress(entry, phase, "completed", options);
      return terminalFromLifecycle(entry, lifecycle);
    } catch (error) {
      if (error instanceof ProjectAuthorityStale) return finish(entry, stale(entry, "project"));
      if (error instanceof ConfigurationCleanupError) {
        entry.configurationRecovery = { kind: "retry-save", recovery: error.cleanup.recovery };
        return pauseForWorkflowRecovery(entry, "retry-configuration-recovery");
      }
      if (isCandidateContentCleanupError(error)) {
        retainCandidateCleanup(error);
        return finish(entry, { kind: "failed", code: "CLEANUP_FAILED", progress: entry.progress, retained: safeRetained(entry) });
      }
      if (signal.aborted && phase !== "activation-transaction") return finish(entry, cancelled(entry, phase));
      return finish(entry, { kind: "failed", code: "ADAPTER_FAILED", progress: entry.progress, retained: safeRetained(entry) });
    }
  }

  function missingInput(entry: TrustedInstallSessionEntry): TrustedInstallActivationResult {
    const issues: TrustedInstallInputIssue[] = entry.candidate.fields.flatMap((field) => field.required && field.state !== "configured" && field.state !== "defaulted"
      ? [{ code: field.sensitive && field.state === "unavailable" ? "SECRET_CUSTODY_UNAVAILABLE" as const : "CONFIG_REQUIRED" as const, key: field.key }]
      : []);
    issues.push({ code: "CONSENT_REQUIRED" });
    return TrustedInstallActivationResultSchema.parse({ kind: "needs-input", issues: sortedIssues(issues), session: view(entry) });
  }

  const application: TrustedInstallationService = Object.freeze({
    open,
    activate,
    async recover(
      request: Parameters<TrustedInstallationService["recover"]>[0],
      options: TrustedInstallExecutionOptions,
      callerSignal: AbortSignal,
    ) {
      if (quiesced) return TrustedInstallActivationResultSchema.parse({ kind: "disposed" });
      const lookup = await registry.lookup(request.token);
      if (lookup.kind !== "found") return TrustedInstallActivationResultSchema.parse({ kind: lookup.kind });
      const entry = lookup.entry;
      const submission = TrustedInstallSubmissionSchema.parse(request.submission);
      if (submission.expectedVersion !== entry.version) return stale(entry, "session");
      if (entry.configurationRecovery !== undefined) {
        // Recovery owns already-created credentials and must remain callable even
        // when cancellation aborted the original activation controller.
        const settled = await settleConfigurationRecovery(entry, callerSignal);
        if (settled === "pending") return pauseForWorkflowRecovery(entry, "retry-configuration-recovery");
        if (settled === "stale") return finish(entry, stale(entry, "configuration"));
      } else if (entry.trustRecoveryPending) {
        delete entry.trustRecoveryPending;
      } else {
        return entry.result ?? stale(entry, "session");
      }
      registry.restore(entry);
      return activate({ token: request.token, submission }, options, callerSignal);
    },
    async run(request: Parameters<TrustedInstallationService["run"]>[0], options: TrustedInstallRunOptions, signal: AbortSignal) {
      const opened = await open(request, signal);
      if (opened.kind !== "opened") {
        if (opened.kind === "stale") return { kind: "stale", reason: opened.reason, progress: [], retained: { configuration: false, trust: false } } as TrustedInstallActivationResult;
        return { kind: "rejected", code: opened.code, diagnostics: opened.diagnostics, progress: [], retained: { configuration: false, trust: false } } as TrustedInstallActivationResult;
      }
      const lookup = await registry.lookup(opened.session.token);
      if (lookup.kind !== "found") return { kind: lookup.kind } as TrustedInstallActivationResult;
      let submission = options.submission;
      if (submission === undefined && options.decisionProvider === undefined) return missingInput(lookup.entry);
      if (submission === undefined) {
        try {
          const decision = await options.decisionProvider!({ session: opened.session }, signal);
          if ("kind" in decision) return finish(lookup.entry, cancelled(lookup.entry, "input-validation"));
          submission = TrustedInstallSubmissionSchema.parse(decision);
        } catch (error) {
          if (signal.aborted) return finish(lookup.entry, cancelled(lookup.entry, "input-validation"));
          return finish(lookup.entry, { kind: "failed", code: "INTERACTION_FAILED", progress: lookup.entry.progress, retained: safeRetained(lookup.entry) });
        }
      }
      if (submission === undefined) throw new Error("trusted-install decision provider returned no submission");
      return activate({ token: opened.session.token, submission }, options, signal);
    },
    async status(request: Parameters<TrustedInstallationService["status"]>[0], signal: AbortSignal) {
      signal.throwIfAborted();
      const lookup = await registry.lookup(request.token);
      if (lookup.kind !== "found") return TrustedInstallStatusResultSchema.parse({ kind: lookup.kind });
      return TrustedInstallStatusResultSchema.parse({ kind: "found", session: view(lookup.entry), ...(lookup.entry.result === undefined ? {} : { result: lookup.entry.result }) });
    },
    async cancel(request: Parameters<TrustedInstallationService["cancel"]>[0], signal: AbortSignal) {
      signal.throwIfAborted();
      const lookup = await registry.lookup(request.token, false);
      if (lookup.kind !== "found") return TrustedInstallCancellationResultSchema.parse({ kind: lookup.kind });
      const entry = lookup.entry;
      entry.controller.abort(new DOMException("trusted-install cancelled", "AbortError"));
      if (entry.state !== "activating" && entry.result === undefined) await finish(entry, cancelled(entry, "input-validation"));
      return TrustedInstallCancellationResultSchema.parse({ kind: "accepted", state: entry.state });
    },
  });

  return Object.freeze({
    application,
    quiesce() { quiesced = true; registry.quiesce(); },
    async close() {
      const retryCandidateCleanup = async (): Promise<unknown[]> => {
        const failures: unknown[] = [];
        for (const cleanup of [...pendingCandidateCleanup]) {
          try {
            await cleanup.retry();
            pendingCandidateCleanup.delete(cleanup);
          } catch (error) {
            failures.push(error);
          }
        }
        return failures;
      };
      let registryFailure: unknown;
      try {
        await registry.close();
      } catch (error) {
        const nested = error instanceof AggregateError ? error.errors : [error];
        const nonCandidate = nested.filter((failure) => !retainCandidateCleanup(failure));
        const cleanupFailures = await retryCandidateCleanup();
        if (cleanupFailures.length === 0) {
          try { await registry.close(); }
          catch (retryError) { registryFailure = retryError; }
        } else {
          registryFailure = new AggregateError([...nonCandidate, ...cleanupFailures], "trusted-install close retry failed");
        }
      }
      const failures = await retryCandidateCleanup();
      if (registryFailure !== undefined) failures.unshift(registryFailure);
      if (failures.length > 0) throw new AggregateError(failures, "trusted-install cleanup failed");
    },
  });
}
