import type { ContentDigest } from "../domain/content-manifest.js";
import type { Sha256 } from "../domain/source.js";
import {
  NativeLifecycleOperationCancellationResultSchema,
  NativeLifecycleOperationConfirmationSchema,
  NativeLifecycleOperationPreviewResultSchema,
  NativeLifecycleOperationPreviewSchema,
  NativeLifecycleOperationRequestSchema,
  NativeLifecycleOperationResultSchema,
  NativeLifecycleOperationSessionViewSchema,
  NativeLifecycleOperationStatusResultSchema,
  type NativeLifecycleExecutionOptions,
  type NativeLifecycleOperationConfirmation,
  type NativeLifecycleOperationPreviewResult,
  type NativeLifecycleOperationRequest,
  type NativeLifecycleOperationResult,
  type NativeLifecycleOperationService,
  type NativeLifecycleProgressPhase,
  type NativeLifecycleRetainedPreflightEvidence,
  type NativeLifecycleRunOptions,
} from "./native-lifecycle-operation-contract.js";
import { deriveNativeLifecyclePreviewId } from "./native-lifecycle-operation-identifiers.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { hashContent } from "../domain/content-manifest.js";
import type { ConfigurationRecoveryCapability } from "./configuration-service.js";
import type { TrustedInstallConfigurationAuthority } from "./trusted-install-configuration.js";
import type { NativeLifecycleTargetService } from "./native-lifecycle-target.js";
import type { NativeLifecycleUpdateService } from "./native-lifecycle-update.js";
import {
  isCandidateContentCleanupError,
  type CandidateContentCleanupRecovery,
  type CandidateContentLease,
} from "./ports/candidate-content-lease.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleOperationIdPort } from "./ports/lifecycle-operation-id.js";
import { createNativeLifecycleOperationSessionRegistry, type NativeLifecycleOperationSessionEntry } from "./native-lifecycle-operation-session.js";
import {
  NativeLifecycleConfigurationRecoveryError,
  type createNativeLifecycleOperationExecutor,
} from "./native-lifecycle-operation.js";
import type { ProjectSyncService } from "./project-sync-service.js";

export type NativeLifecycleOperationServiceDependencies = Readonly<{
  targets: NativeLifecycleTargetService;
  updates: NativeLifecycleUpdateService;
  lifecycle: ReturnType<typeof createNativeLifecycleOperationExecutor>;
  configurationAuthority: TrustedInstallConfigurationAuthority;
  sync: ProjectSyncService;
  clock: LifecycleClock;
  sessionIds: LifecycleOperationIdPort;
  hostEpoch: ContentDigest;
  sha256: Sha256;
}>;

function effects() { return { state: "unchanged" as const, projectFile: "unchanged" as const, completedActionIds: [], pendingActionIds: [] }; }

export function createNativeLifecycleOperationService(dependencies: NativeLifecycleOperationServiceDependencies): Readonly<{
  application: NativeLifecycleOperationService;
  quiesce(): void;
  close(): Promise<void>;
}> {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("native lifecycle operation service dependencies are required");
  const sessions = createNativeLifecycleOperationSessionRegistry({ clock: dependencies.clock, sessionIds: dependencies.sessionIds, hostEpoch: dependencies.hostEpoch, sha256: dependencies.sha256 });
  const pendingCandidateCleanup = new Set<CandidateContentCleanupRecovery>();
  const pendingConfigurationRecovery = new Set<ConfigurationRecoveryCapability>();
  let closePromise: Promise<void> | undefined;

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
  async function releaseEntry(entry: NativeLifecycleOperationSessionEntry): Promise<"released" | "cleanup-failed"> {
    try {
      await sessions.release(entry);
      return "released";
    } catch (error) {
      const lease = entry.execution.kind === "lifecycle" ? entry.execution.context.update?.candidate.lease : undefined;
      retainCandidateCleanup(error, lease);
      return "cleanup-failed";
    }
  }
  function operationPhase(entry: NativeLifecycleOperationSessionEntry): NativeLifecycleProgressPhase {
    return entry.progress.at(-1)?.phase ?? "preflight";
  }
  function durablePhaseStarted(entry: NativeLifecycleOperationSessionEntry): boolean {
    return entry.progress.some((event) => event.state === "started" && [
      "configuration-custody", "trust-decision", "project-file-write", "lifecycle-transaction",
      "project-reconciliation", "uninstall-cleanup", "finalization", "completed",
    ].includes(event.phase));
  }
  function retainedFrom(value: unknown): NativeLifecycleRetainedPreflightEvidence | undefined {
    if (value === null || typeof value !== "object" || !("retainedPreflight" in value)) return undefined;
    return (value as { retainedPreflight?: NativeLifecycleRetainedPreflightEvidence }).retainedPreflight;
  }
  function failed(entry: NativeLifecycleOperationSessionEntry, code: "ADAPTER_FAILED" | "CLEANUP_FAILED", retainedPreflight?: NativeLifecycleRetainedPreflightEvidence): NativeLifecycleOperationResult {
    return NativeLifecycleOperationResultSchema.parse({
      kind: "failed",
      operation: entry.preview.operation,
      previewId: entry.preview.previewId,
      progress: entry.progress,
      diagnostics: [],
      effects: effects(),
      code,
      ...(retainedPreflight === undefined ? {} : { retainedPreflight }),
    });
  }

  function view(entry: NativeLifecycleOperationSessionEntry) {
    return NativeLifecycleOperationSessionViewSchema.parse({ token: entry.token, version: entry.version, state: entry.state, expiresAt: sessions.expiresAt(entry), preview: entry.preview, progress: entry.progress });
  }
  function immediateResult(request: NativeLifecycleOperationRequest, reason?: string): NativeLifecycleOperationResult {
    const previewId = deriveNativeLifecyclePreviewId({ hostEpoch: dependencies.hostEpoch, request, current: true }, dependencies.sha256);
    if (request.operation === "project-sync") return NativeLifecycleOperationResultSchema.parse({ kind: "current-state", operation: request.operation, previewId, progress: [], diagnostics: [], effects: effects(), reason: "project-converged", syncDigest: reason });
    return NativeLifecycleOperationResultSchema.parse({ kind: "current-state", operation: request.operation, previewId, progress: [], diagnostics: [], effects: effects(), reason: request.operation === "enable" ? "already-enabled" : request.operation === "disable" ? "already-disabled" : request.operation === "update" ? "revision-current" : "already-uninstalled" });
  }

  async function preview(requestInput: NativeLifecycleOperationRequest, signal: AbortSignal): Promise<NativeLifecycleOperationPreviewResult> {
    if (!sessions.isAccepting()) return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "DISPOSED", diagnostics: [] });
    const request = NativeLifecycleOperationRequestSchema.parse(requestInput);
    await sessions.reap();
    if (request.operation === "project-sync") {
      const seed = deriveNativeLifecyclePreviewId({ hostEpoch: dependencies.hostEpoch, request }, dependencies.sha256);
      const synced = await dependencies.sync.preview({ mode: request.mode, projectKey: request.projectKey, previewId: seed }, signal);
      if (synced.kind === "current-state") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "current-state", operation: request.operation, diagnostics: [] });
      if (synced.kind === "stale") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "stale", reason: synced.reason });
      if (synced.kind === "rejected") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "rejected", code: synced.code, diagnostics: [] });
      const previewId = deriveNativeLifecyclePreviewId({ hostEpoch: dependencies.hostEpoch, request, plan: synced.plan }, dependencies.sha256);
      const previewValue = NativeLifecycleOperationPreviewSchema.parse({ previewId, operation: request.operation, admission: synced.plan.requiredActions.length > 0 ? "needs-action" : synced.plan.conflicts.length > 0 ? "needs-input" : "ready", sync: synced.plan, diagnostics: [] });
      const entry = await sessions.create(previewValue, { kind: "project-sync", context: synced.context }, signal);
      return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "opened", session: view(entry) });
    }

    if (request.operation === "update") {
      let prepared: Awaited<ReturnType<NativeLifecycleUpdateService["acquire"]>>;
      try {
        prepared = await dependencies.updates.acquire({ target: request.target, candidate: request.candidate }, signal);
      } catch (error) {
        if (retainCandidateCleanup(error)) {
          return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] });
        }
        throw error;
      }
      if (prepared.kind === "current-state") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "current-state", operation: request.operation, diagnostics: [] });
      if (prepared.kind === "stale") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "stale", reason: prepared.reason });
      if (prepared.kind === "blocked") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "PENDING_TRANSITION", diagnostics: [] });
      if (prepared.kind === "cleanup-failed") {
        pendingCandidateCleanup.add(prepared.cleanup);
        return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] });
      }
      if (prepared.kind !== "ready") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: prepared.kind, code: "AVAILABLE_REVISION_CHANGED", diagnostics: [] });
      const update = prepared.update;
      const needsInput = update.candidate.fields.some((field) => field.required && field.state !== "configured" && field.state !== "defaulted");
      let configurationRevision: ContentDigest | null = null;
      if (update.candidate.binding.configurationRef !== undefined) {
        const current = await dependencies.configurationAuthority.readCurrent({
          configurationRef: update.candidate.binding.configurationRef,
          plugin: update.candidate.binding.plugin,
          scope: update.candidate.binding.scope,
          descriptors: update.candidate.plugin.configuration,
        }, signal);
        if (current.kind === "unavailable" || current.kind === "stale") {
          try { await update.candidate.lease.release(); }
          catch (error) { retainCandidateCleanup(error, update.candidate.lease); return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] }); }
          return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "stale", reason: "configuration" });
        }
        if (current.kind === "current") configurationRevision = current.document.revision;
      }
      const trustFingerprint = hashContent(new TextEncoder().encode(`native-lifecycle-trust-v1\0${canonicalJson(update.candidate.trust)}`), dependencies.sha256);
      const authority = { configurationRevision, trustFingerprint } as const;
      const previewId = deriveNativeLifecyclePreviewId({ hostEpoch: dependencies.hostEpoch, operation: request.operation, target: update.target.binding, update: update.binding, authority }, dependencies.sha256);
      const previewValue = NativeLifecycleOperationPreviewSchema.parse({ previewId, operation: request.operation, admission: needsInput ? "needs-input" : "ready", target: update.target.binding, update: { candidate: update.candidate.binding, updateCandidate: update.binding.updateCandidate, fields: update.candidate.fields, consent: update.candidate.consent, authority }, diagnostics: update.candidate.detail.diagnostics });
      try {
        const entry = await sessions.create(previewValue, { kind: "lifecycle", context: { operation: "update", previewId, target: update.target, update, diagnostics: update.candidate.detail.diagnostics } }, signal);
        return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "opened", session: view(entry) });
      } catch (error) {
        try {
          await update.candidate.lease.release();
        } catch (cleanupError) {
          retainCandidateCleanup(cleanupError, update.candidate.lease);
          return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] });
        }
        if (signal.aborted) throw signal.reason ?? error;
        return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "ADAPTER_FAILED", diagnostics: [] });
      }
    }

    const resolved = await dependencies.targets.resolve(request.target, signal);
    if (resolved.kind === "stale") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "stale", reason: resolved.reason });
    if (resolved.kind === "blocked") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "PENDING_TRANSITION", diagnostics: [] });
    if (resolved.kind !== "ready") return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "unavailable", code: "ADAPTER_FAILED", diagnostics: [] });
    if (request.operation === "enable" && resolved.target.binding.activation === "enabled" || request.operation === "disable" && resolved.target.binding.activation === "disabled") {
      return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "current-state", operation: request.operation, diagnostics: [] });
    }
    const previewId = deriveNativeLifecyclePreviewId({ hostEpoch: dependencies.hostEpoch, operation: request.operation, target: resolved.target.binding }, dependencies.sha256);
    const previewValue = NativeLifecycleOperationPreviewSchema.parse({ previewId, operation: request.operation, admission: "ready", target: resolved.target.binding, diagnostics: [] });
    const entry = await sessions.create(previewValue, { kind: "lifecycle", context: { operation: request.operation, previewId, target: resolved.target } }, signal);
    return NativeLifecycleOperationPreviewResultSchema.parse({ kind: "opened", session: view(entry) });
  }

  function validationFailure(entry: NativeLifecycleOperationSessionEntry, kind: "stale" | "conflict", reason: "session" | "operation-in-progress"): NativeLifecycleOperationResult {
    return NativeLifecycleOperationResultSchema.parse({ kind, operation: entry.preview.operation, previewId: entry.preview.previewId, progress: entry.progress, diagnostics: [], effects: effects(), reason });
  }
  function confirmationMatches(entry: NativeLifecycleOperationSessionEntry, confirmation: NativeLifecycleOperationConfirmation): boolean {
    if (confirmation.previewId !== entry.preview.previewId || confirmation.expectedVersion !== entry.version) return false;
    if (confirmation.kind === "deny") return true;
    if (entry.preview.operation === "update" && confirmation.kind === "confirm-update") {
      return entry.preview.update !== undefined &&
        confirmation.input.authority.configurationRevision === entry.preview.update.authority.configurationRevision &&
        confirmation.input.authority.trustFingerprint === entry.preview.update.authority.trustFingerprint;
    }
    return entry.preview.operation === "update" ? false
      : entry.preview.operation === "uninstall" ? confirmation.kind === "confirm-uninstall"
      : entry.preview.operation === "project-sync" ? confirmation.kind === "confirm-project-sync"
      : confirmation.kind === "confirm" && confirmation.operation === entry.preview.operation;
  }

  async function apply(request: Parameters<NativeLifecycleOperationService["apply"]>[0], options: NativeLifecycleExecutionOptions, callerSignal: AbortSignal): Promise<NativeLifecycleOperationResult> {
    if (!sessions.isAccepting()) return NativeLifecycleOperationResultSchema.parse({ kind: "disposed" });
    const confirmation = NativeLifecycleOperationConfirmationSchema.parse(request.confirmation);
    const lookup = await sessions.lookup(request.token);
    if (lookup.kind !== "found") return NativeLifecycleOperationResultSchema.parse({ kind: lookup.kind });
    const entry = lookup.entry;
    if (entry.result !== undefined) return entry.result;
    if (entry.state === "applying") return validationFailure(entry, "conflict", "operation-in-progress");
    if (!confirmationMatches(entry, confirmation)) return validationFailure(entry, "stale", "session");
    if (confirmation.kind === "deny") {
      entry.version += 1;
      let result = NativeLifecycleOperationResultSchema.parse({ kind: "cancelled", operation: entry.preview.operation, previewId: entry.preview.previewId, progress: entry.progress, diagnostics: [], effects: effects(), phase: "preflight" });
      if (await releaseEntry(entry) === "cleanup-failed") result = failed(entry, "CLEANUP_FAILED");
      sessions.finish(entry, result);
      return result;
    }
    entry.state = "applying";
    entry.version += 1;
    const signal = AbortSignal.any([callerSignal, entry.controller.signal]);
    const forwarded = async (event: Parameters<NonNullable<NativeLifecycleExecutionOptions["onProgress"]>>[0]) => {
      entry.progress = Object.freeze([...entry.progress, event].slice(-128));
      await options.onProgress?.(event);
    };
    let settleCompletion!: () => void;
    entry.completion = new Promise<void>((resolve) => { settleCompletion = resolve; });
    try {
      let result: NativeLifecycleOperationResult;
      if (entry.execution.kind === "lifecycle") result = await dependencies.lifecycle.execute(entry.execution.context, confirmation, { onProgress: forwarded }, signal);
      else {
        if (confirmation.kind !== "confirm-project-sync") result = validationFailure(entry, "stale", "session");
        else {
          const projected = await dependencies.sync.apply({ context: entry.execution.context, resolutions: confirmation.resolutions }, forwarded, signal);
          result = "previewId" in projected ? NativeLifecycleOperationResultSchema.parse({ ...projected, previewId: entry.preview.previewId }) : projected;
        }
      }
      if (await releaseEntry(entry) === "cleanup-failed") result = failed(entry, "CLEANUP_FAILED", retainedFrom(result));
      sessions.finish(entry, result);
      return result;
    } catch (error) {
      let result: NativeLifecycleOperationResult;
      if (error instanceof NativeLifecycleConfigurationRecoveryError) {
        pendingConfigurationRecovery.add(error.recovery);
        result = failed(entry, error.code, error.retainedPreflight);
      } else if (retainCandidateCleanup(error)) {
        result = failed(entry, "CLEANUP_FAILED", retainedFrom(error));
      } else if (signal.aborted && !durablePhaseStarted(entry)) {
        result = NativeLifecycleOperationResultSchema.parse({
          kind: "cancelled",
          operation: entry.preview.operation,
          previewId: entry.preview.previewId,
          progress: entry.progress,
          diagnostics: [],
          effects: effects(),
          phase: operationPhase(entry),
        });
      } else {
        result = failed(entry, "ADAPTER_FAILED");
      }
      if (await releaseEntry(entry) === "cleanup-failed") result = failed(entry, "CLEANUP_FAILED", retainedFrom(result));
      sessions.finish(entry, result);
      return result;
    } finally { settleCompletion(); delete entry.completion; }
  }

  const application: NativeLifecycleOperationService = Object.freeze({
    preview,
    apply,
    async run(request: Parameters<NativeLifecycleOperationService["run"]>[0], options: NativeLifecycleRunOptions, signal: AbortSignal) {
      const opened = await preview(request, signal);
      if (opened.kind === "current-state") {
        if (request.operation !== "project-sync") return immediateResult(request);
        const seed = deriveNativeLifecyclePreviewId({ hostEpoch: dependencies.hostEpoch, request, current: true }, dependencies.sha256);
        const current = await dependencies.sync.preview({ mode: request.mode, projectKey: request.projectKey, previewId: seed }, signal);
        return current.kind === "current-state"
          ? immediateResult(request, current.digest)
          : NativeLifecycleOperationResultSchema.parse({ kind: "stale", operation: request.operation, previewId: seed, progress: [], diagnostics: [], effects: effects(), reason: "project" });
      }
      if (opened.kind !== "opened") {
        const previewId = deriveNativeLifecyclePreviewId({ hostEpoch: dependencies.hostEpoch, request, outcome: opened }, dependencies.sha256);
        return NativeLifecycleOperationResultSchema.parse({ kind: opened.kind === "stale" ? "stale" : "rejected", operation: request.operation, previewId, progress: [], diagnostics: "diagnostics" in opened ? opened.diagnostics : [], effects: effects(), ...(opened.kind === "stale" ? { reason: opened.reason } : { code: opened.code }) });
      }
      let decision;
      try { decision = await options.decisionProvider(opened.session, signal); }
      catch (error) {
        if (signal.aborted) decision = { kind: "cancelled" as const };
        else {
          const lookup = await sessions.lookup(opened.session.token, false);
          if (lookup.kind !== "found") return NativeLifecycleOperationResultSchema.parse({ kind: lookup.kind });
          let result = failed(lookup.entry, "ADAPTER_FAILED");
          if (await releaseEntry(lookup.entry) === "cleanup-failed") result = failed(lookup.entry, "CLEANUP_FAILED");
          sessions.finish(lookup.entry, result);
          return result;
        }
      }
      if (decision.kind === "cancelled") {
        const confirmation = { kind: "deny" as const, previewId: opened.session.preview.previewId, expectedVersion: opened.session.version };
        return apply({ token: opened.session.token, confirmation }, options, signal);
      }
      return apply({ token: opened.session.token, confirmation: decision }, options, signal);
    },
    async status(request: Parameters<NativeLifecycleOperationService["status"]>[0], signal: AbortSignal) {
      signal.throwIfAborted();
      const lookup = await sessions.lookup(request.token);
      if (lookup.kind !== "found") return NativeLifecycleOperationStatusResultSchema.parse({ kind: lookup.kind });
      if (lookup.entry.result?.kind === "failed" && lookup.entry.result.code === "CLEANUP_FAILED" && !lookup.entry.released) {
        await releaseEntry(lookup.entry);
      }
      return NativeLifecycleOperationStatusResultSchema.parse({ kind: "found", session: view(lookup.entry), ...(lookup.entry.result === undefined ? {} : { result: lookup.entry.result }) });
    },
    async cancel(request: Parameters<NativeLifecycleOperationService["cancel"]>[0], signal: AbortSignal) {
      signal.throwIfAborted();
      const lookup = await sessions.lookup(request.token, false);
      if (lookup.kind !== "found") return NativeLifecycleOperationCancellationResultSchema.parse({ kind: lookup.kind });
      const entry = lookup.entry;
      entry.controller.abort(new DOMException("native operation cancelled", "AbortError"));
      if (entry.state !== "applying" && entry.result === undefined) {
        let result = NativeLifecycleOperationResultSchema.parse({ kind: "cancelled", operation: entry.preview.operation, previewId: entry.preview.previewId, progress: entry.progress, diagnostics: [], effects: effects(), phase: "preflight" });
        if (await releaseEntry(entry) === "cleanup-failed") result = failed(entry, "CLEANUP_FAILED");
        sessions.finish(entry, result);
      }
      return NativeLifecycleOperationCancellationResultSchema.parse({ kind: "accepted", state: entry.state });
    },
  });

  return Object.freeze({
    application,
    quiesce: sessions.quiesce,
    close(): Promise<void> {
      closePromise ??= (async () => {
        const failures: unknown[] = [];
        try {
          await sessions.close();
        } catch (error) {
          const nested = error instanceof AggregateError ? error.errors : [error];
          for (const failure of nested) {
            if (!retainCandidateCleanup(failure)) failures.push(failure);
          }
        }
        for (const cleanup of [...pendingCandidateCleanup]) {
          try {
            await cleanup.retry();
            pendingCandidateCleanup.delete(cleanup);
          } catch (error) {
            failures.push(error);
          }
        }
        for (const recovery of [...pendingConfigurationRecovery]) {
          try {
            const settlement = await recovery.settle(new AbortController().signal);
            if (settlement.kind === "recovery-required") {
              failures.push(new Error("native lifecycle configuration recovery remains pending"));
            } else {
              pendingConfigurationRecovery.delete(recovery);
            }
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) throw new AggregateError(failures, "native lifecycle operation cleanup failed");
      })();
      return closePromise;
    },
  });
}
