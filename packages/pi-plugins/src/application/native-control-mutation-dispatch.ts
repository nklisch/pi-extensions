import { NativeControlCommandRegistry, type NativeControlCommand } from "./native-control-registry.js";
import type { NativeControlApplicationDependencies, NativeControlDispatchContext } from "./ports/native-control-applications.js";
import type { NativeControlDispatchResult } from "./native-control-projection.js";
import { presentRecoveryRequired } from "./native-failure-presenter.js";
import { humanForSelectionFailure, projectNativeControlFailure, projectNativeControlResponse } from "./native-control-projection.js";
import { currentProjectFailure } from "./native-control-read-dispatch.js";
import type { MarketplaceRefreshResult } from "./update-contract.js";
import { createNativeControlSelectionService, type NativeControlSelectionService } from "./native-control-selection.js";
import { collectTrustedInstallSubmission } from "./native-control-install.js";
import { buildNativeLifecycleConfirmation } from "./native-control-lifecycle.js";
import { dispatchNativeControlPolicy } from "./native-control-update-policy.js";
import type { NativeLifecycleOperationPreviewResult, NativeLifecycleOperationResult } from "./native-lifecycle-operation-contract.js";
import type { TrustedInstallActivationResult, TrustedInstallOpenResult, TrustedInstallSessionView } from "./trusted-install-contract.js";

export interface NativeControlDispatcher {
  dispatch(command: NativeControlCommand, context: NativeControlDispatchContext, signal: AbortSignal): Promise<NativeControlDispatchResult | undefined>;
}

function pluginSelector(request: any) {
  return request.snapshotId === undefined
    ? { kind: "identity" as const, plugin: request.plugin, scope: request.scope }
    : { kind: "exact" as const, plugin: request.plugin, scope: request.scope, snapshotId: request.snapshotId, detailId: request.detailId };
}

function installStatus(command: NativeControlCommand["command"], result: TrustedInstallOpenResult | TrustedInstallActivationResult): NativeControlDispatchResult {
  const operation = result.kind === "opened" ? { kind: "trusted-install" as const, token: result.session.token }
    : result.kind === "needs-input" ? { kind: "trusted-install" as const, token: result.session.token }
    : result.kind === "recovery-required" && result.session !== undefined ? { kind: "trusted-install" as const, token: result.session.token }
    : undefined;
  const status = result.kind === "opened" || result.kind === "succeeded" ? "ok"
    : result.kind === "current-state" ? "no-change"
    : result.kind === "needs-input" ? "input-required"
    : result.kind === "stale" ? "stale"
    : result.kind === "conflict" ? "conflict"
    : result.kind === "unavailable" || result.kind === "expired" || result.kind === "disposed" ? "unavailable"
    : result.kind === "rejected" ? "rejected"
    : result.kind === "rolled-back" ? "partial"
    : result.kind === "recovery-required" ? "recovery-required"
    : result.kind === "cancelled" ? "cancelled"
    : "failed";
  return projectNativeControlResponse(command, result, {
    status,
    ...(operation === undefined ? {} : { operation }),
    ...(result.kind === "recovery-required" ? { human: [presentRecoveryRequired()] } : {}),
  });
}

function lifecycleStatus(command: NativeControlCommand["command"], result: NativeLifecycleOperationPreviewResult | NativeLifecycleOperationResult): NativeControlDispatchResult {
  const operation = result.kind === "opened" ? { kind: "lifecycle" as const, token: result.session.token } : undefined;
  const status = result.kind === "opened" || result.kind === "succeeded" ? "ok"
    : result.kind === "current-state" ? "no-change"
    : result.kind === "needs-action" ? "input-required"
    : result.kind === "stale" ? "stale"
    : result.kind === "conflict" ? "conflict"
    : result.kind === "unavailable" || result.kind === "expired" || result.kind === "disposed" ? "unavailable"
    : result.kind === "rejected" ? "rejected"
    : result.kind === "rolled-back" ? "partial"
    : result.kind === "recovery-required" ? "recovery-required"
    : result.kind === "cancelled" ? "cancelled"
    : "failed";
  return projectNativeControlResponse(command, result, {
    status,
    ...(operation === undefined ? {} : { operation }),
    ...(result.kind === "recovery-required" ? { human: [presentRecoveryRequired()] } : {}),
  });
}

export function foldMarketplaceRefreshStatus(result: MarketplaceRefreshResult): NativeControlDispatchResult["status"] {
  if (result.outcomes.length === 0) return "ok";
  if (result.outcomes.every((outcome) => outcome.kind === "not-configured")) return "not-found";
  if (result.outcomes.every((outcome) => outcome.kind === "cancelled")) return "cancelled";
  if (result.outcomes.every((outcome) => outcome.kind === "refreshed" || outcome.kind === "skipped-local")) return "ok";
  return "partial";
}

function inputFailure(result: unknown): NativeControlDispatchResult {
  return projectNativeControlFailure("input-required", "CONTROL_INPUT_REQUIRED", "provide-input");
}

async function activateSession(
  command: Extract<NativeControlCommand, { command: "install.apply" | "install.recover" | "install.run" }>,
  session: TrustedInstallSessionView,
  dependencies: NativeControlApplicationDependencies,
  context: NativeControlDispatchContext,
  signal: AbortSignal,
): Promise<NativeControlDispatchResult> {
  const collected = await collectTrustedInstallSubmission({
    executionId: context.executionId,
    input: context.input,
    channel: command.invocation.input,
    purpose: command.command === "install.recover" ? "trusted-install-recovery" : "trusted-install",
    session,
    signal,
  });
  if (collected.kind !== "submission") return inputFailure(collected);
  const result = command.command === "install.recover"
    ? await dependencies.trustedInstallation.recover({ token: session.token, submission: collected.submission }, { onProgress: context.progress.trusted }, signal)
    : await dependencies.trustedInstallation.activate({ token: session.token, submission: collected.submission }, { onProgress: context.progress.trusted }, signal);
  return installStatus(command.command, result);
}

async function lifecycle(
  command: Extract<NativeControlCommand, { command: "lifecycle.enable" | "lifecycle.disable" | "lifecycle.update" | "lifecycle.uninstall" | "project.sync" }>,
  dependencies: NativeControlApplicationDependencies,
  selection: NativeControlSelectionService,
  context: NativeControlDispatchContext,
  signal: AbortSignal,
): Promise<NativeControlDispatchResult> {
  const request: any = command.request;
  let ownerRequest: any;
  if (command.command === "project.sync") {
    const project = await selection.currentProject(signal);
    if (project.kind !== "trusted") return currentProjectFailure(project);
    ownerRequest = { operation: "project-sync", mode: request.mode, projectKey: project.projectKey };
  } else if (command.command === "lifecycle.update") {
    const selected = await selection.update({
      plugin: request.plugin,
      scope: request.scope,
      ...(request.snapshotId === undefined ? {} : { installed: { snapshotId: request.snapshotId, detailId: request.detailId } }),
      ...(request.candidateSnapshotId === undefined ? {} : { candidate: { snapshotId: request.candidateSnapshotId, detailId: request.candidateDetailId } }),
    }, signal);
    if (selected.kind !== "selected") return projectNativeControlFailure(selected.kind === "stale" ? "stale" : selected.kind === "ambiguous" ? "partial" : selected.kind === "unavailable" ? "unavailable" : "not-found", "CONTROL_TARGET_SELECTION_FAILED", "reinspect", humanForSelectionFailure(selected));
    ownerRequest = { operation: "update", target: { inspectionSnapshotId: selected.installed.snapshotId, detailId: selected.installed.summary.detailId }, candidate: { inspectionSnapshotId: selected.candidate.snapshotId, detailId: selected.candidate.summary.detailId } };
  } else {
    const selected = await selection.installed(pluginSelector(request), signal);
    if (selected.kind !== "selected") return projectNativeControlFailure(selected.kind === "stale" ? "stale" : selected.kind === "ambiguous" ? "partial" : selected.kind === "unavailable" ? "unavailable" : "not-found", "CONTROL_TARGET_SELECTION_FAILED", "reinspect", humanForSelectionFailure(selected));
    ownerRequest = { operation: command.command.slice("lifecycle.".length), target: { inspectionSnapshotId: selected.detail.snapshotId, detailId: selected.detail.summary.detailId } };
  }

  const preview = await dependencies.operations.preview(ownerRequest, signal);
  if (preview.kind !== "opened") return lifecycleStatus(command.command, preview);
  if (request.previewOnly === true) return lifecycleStatus(command.command, preview);
  const confirmation = await buildNativeLifecycleConfirmation({
    executionId: context.executionId,
    input: context.input,
    channel: command.invocation.input,
    session: preview.session,
    confirmed: request.confirmed === true,
    ...(request.persistentData === undefined ? {} : { persistentData: request.persistentData }),
    signal,
  });
  if (confirmation.kind !== "confirmation") return inputFailure(confirmation);
  const result = await dependencies.operations.apply({ token: preview.session.token, confirmation: confirmation.confirmation }, { onProgress: context.progress.lifecycle }, signal);
  return lifecycleStatus(command.command, result);
}

export function createNativeControlMutationDispatcher(dependencies: NativeControlApplicationDependencies): NativeControlDispatcher {
  const selection = createNativeControlSelectionService({ inspection: dependencies.inspection, currentProject: dependencies.currentProject });
  const dispatcher: NativeControlDispatcher = {
    async dispatch(command: NativeControlCommand, context: NativeControlDispatchContext, signal: AbortSignal): Promise<NativeControlDispatchResult | undefined> {
      const request: any = command.request;
      if (NativeControlCommandRegistry[command.command].safety !== "mutation") return undefined;
      if (context.readiness.status === "blocked") return projectNativeControlFailure("rejected", "CONTROL_READINESS_BLOCKED", "retry");
      switch (command.command) {
        case "marketplace.add": {
          const result = await dependencies.marketplace.registration.add({ source: request.source, scope: "user", origin: { kind: "native" } }, signal);
          const status = result.kind === "added" ? "ok" : result.kind === "unchanged" ? "no-change" : result.kind === "indeterminate" ? "partial" : "rejected";
          return projectNativeControlResponse(command.command, result, { status });
        }
        case "marketplace.remove": {
          if (!request.confirmed) return inputFailure({ code: "CONFIRMATION_REQUIRED" });
          const result = await dependencies.marketplace.registration.remove({ registrationId: request.registrationId, scope: "user" }, signal);
          const status = result.kind === "removed" ? "ok" : result.kind === "unchanged" ? "no-change" : result.kind === "indeterminate" ? "partial" : "rejected";
          return projectNativeControlResponse(command.command, result, { status });
        }
        case "marketplace.refresh": {
          const result = await dependencies.marketplace.refresh.refresh({ trigger: "explicit", scope: "user", ...(request.registrationIds === undefined ? {} : { registrationIds: request.registrationIds }) }, signal);
          return projectNativeControlResponse(command.command, result, { status: foldMarketplaceRefreshStatus(result) });
        }
        case "marketplace.adopt.import": {
          if (!request.confirmed) return inputFailure({ code: "CONFIRMATION_REQUIRED" });
          const result = await dependencies.marketplace.adoption.import({ candidateIds: request.candidateIds, scope: "user" }, signal);
          const status = result.outcomes.some((entry) => !["added", "unchanged", "registered"].includes(entry.outcome.kind)) ? "partial" : "ok";
          return projectNativeControlResponse(command.command, result, { status });
        }
        case "install.open": {
          const selected = await selection.candidate(pluginSelector(request), signal);
          if (selected.kind !== "selected") return projectNativeControlFailure(selected.kind === "stale" ? "stale" : selected.kind === "ambiguous" ? "partial" : selected.kind === "unavailable" ? "unavailable" : "not-found", "CONTROL_TARGET_SELECTION_FAILED", "reinspect", humanForSelectionFailure(selected));
          const result = await dependencies.trustedInstallation.open({ inspectionSnapshotId: selected.detail.snapshotId, detailId: selected.detail.summary.detailId }, signal);
          return installStatus(command.command, result);
        }
        case "install.apply":
        case "install.recover": {
          const status = await dependencies.trustedInstallation.status({ token: request.token }, signal);
          if (status.kind !== "found") return projectNativeControlFailure("not-found", "CONTROL_OPERATION_NOT_FOUND", "reinspect");
          return activateSession(command, status.session, dependencies, context, signal);
        }
        case "install.run": {
          const selected = await selection.candidate(pluginSelector(request), signal);
          if (selected.kind !== "selected") return projectNativeControlFailure(selected.kind === "stale" ? "stale" : selected.kind === "ambiguous" ? "partial" : selected.kind === "unavailable" ? "unavailable" : "not-found", "CONTROL_TARGET_SELECTION_FAILED", "reinspect", humanForSelectionFailure(selected));
          let unavailableInput: unknown;
          const result = await dependencies.trustedInstallation.run(
            { inspectionSnapshotId: selected.detail.snapshotId, detailId: selected.detail.summary.detailId },
            {
              onProgress: context.progress.trusted,
              async decisionProvider({ session }, providerSignal) {
                const collected = await collectTrustedInstallSubmission({
                  executionId: context.executionId,
                  input: context.input,
                  channel: command.invocation.input,
                  purpose: "trusted-install",
                  session,
                  signal: providerSignal,
                });
                if (collected.kind !== "submission") {
                  unavailableInput = collected;
                  return { kind: "cancelled" as const };
                }
                return collected.submission;
              },
            },
            signal,
          );
          return unavailableInput === undefined ? installStatus(command.command, result) : inputFailure(unavailableInput);
        }
        case "lifecycle.enable":
        case "lifecycle.disable":
        case "lifecycle.update":
        case "lifecycle.uninstall":
        case "project.sync":
          return lifecycle(command, dependencies, selection, context, signal);
        case "updates.policy.apply":
        case "updates.policy.set":
          return dispatchNativeControlPolicy(command, { updates: dependencies.updates, selection }, signal);
        case "config.host-precedence": {
          const result = await dependencies.config.hostPrecedence.setHostPrecedence(request, signal);
          const status = result.kind === "changed" ? "ok" : result.kind === "unchanged" ? "no-change" : result.kind === "stale" ? "stale" : "rejected";
          return projectNativeControlResponse(command.command, result, { status });
        }
        case "updates.notices.acknowledge": {
          const result = await dependencies.updates.acknowledge({ ids: request.ids }, signal);
          return projectNativeControlResponse(command.command, result, { status: result.missing.length > 0 ? "partial" : "ok" });
        }
        case "updates.automatic.run": {
          const result = await dependencies.updates.runAutomatic(request, signal);
          const status = result.outcomes.some((entry) => entry.kind === "recovery-required") ? "recovery-required" : result.outcomes.some((entry) => ["pending", "blocked", "retryable", "stale"].includes(entry.kind)) ? "partial" : "ok";
          return projectNativeControlResponse(command.command, result, { status });
        }
        default:
          return undefined;
      }
    },
  };
  return Object.freeze(dispatcher);
}
