import type { AdoptionService } from "./adoption-service.js";
import type { MarketplaceCatalogService } from "./marketplace-catalog-service.js";
import type { MarketplaceRegistrationService } from "./marketplace-registration-service.js";
import type { NativeInspectionService } from "./native-inspection-contract.js";
import { NativeInspectionError } from "./native-inspection-service.js";
import type { NativeLifecycleOperationService } from "./native-lifecycle-operation-contract.js";
import type { NativeUpdateManagementService } from "./native-update-management-service.js";
import type { TrustedInstallationService } from "./trusted-install-contract.js";
import type { NativeControlHostStatusPort } from "./ports/native-control-applications.js";
import { createNativeControlHelp, nativeControlGrammarMetadata } from "./native-control-help.js";
import type { NativeControlCommand } from "./native-control-registry.js";
import type {
  NativeControlCurrentProjectResult,
  NativeControlSelectionFailure,
  NativeControlSelectionService,
} from "./native-control-selection.js";
import { humanForSelectionFailure,
  projectNativeControlFailure,
  projectNativeControlResponse,
  type NativeControlDispatchResult,
} from "./native-control-projection.js";

export type NativeControlReadDependencies = Readonly<{
  marketplace: Readonly<{
    registration: Pick<MarketplaceRegistrationService, "list">;
    catalog: Pick<MarketplaceCatalogService, "search">;
    adoption: Pick<AdoptionService, "preview">;
  }>;
  inspection: NativeInspectionService;
  trustedInstallation: Pick<TrustedInstallationService, "status" | "cancel">;
  operations: Pick<NativeLifecycleOperationService, "status" | "cancel">;
  updates: Pick<NativeUpdateManagementService, "previewPolicy" | "status" | "notifications">;
  status: NativeControlHostStatusPort;
  selection: NativeControlSelectionService;
}>;

function selectionFailure(failure: NativeControlSelectionFailure): NativeControlDispatchResult {
  const human = humanForSelectionFailure(failure);
  switch (failure.kind) {
    case "not-found": return projectNativeControlFailure("not-found", "CONTROL_TARGET_NOT_FOUND", "reinspect", human);
    case "ambiguous": return projectNativeControlFailure("partial", "CONTROL_TARGET_AMBIGUOUS", "confirm-exact", human);
    case "stale": return projectNativeControlFailure("stale", "CONTROL_SELECTION_STALE", "reinspect", human);
    case "invalid": return projectNativeControlFailure("not-found", "CONTROL_IDENTIFIER_INVALID", "reinspect", human);
    case "unavailable": return projectNativeControlFailure("unavailable", "CONTROL_SELECTION_UNAVAILABLE", "retry", human);
    case "wrong-subject": return projectNativeControlFailure("not-found", "CONTROL_TARGET_WRONG_SUBJECT", "reinspect", human);
  }
}

export function currentProjectFailure(
  project: Exclude<NativeControlCurrentProjectResult, { kind: "trusted" }>,
): NativeControlDispatchResult {
  switch (project.kind) {
    case "untrusted":
      return projectNativeControlFailure("rejected", "CONTROL_PROJECT_UNTRUSTED", "confirm-exact");
    case "stale":
      return projectNativeControlFailure("stale", "CONTROL_PROJECT_STALE", "reparse");
    case "unavailable":
      return projectNativeControlFailure("unavailable", "CONTROL_PROJECT_UNAVAILABLE", "retry");
  }
}

function pluginSelector(request: any) {
  return request.snapshotId === undefined
    ? { kind: "identity" as const, plugin: request.plugin, scope: request.scope }
    : { kind: "exact" as const, plugin: request.plugin, scope: request.scope, snapshotId: request.snapshotId, detailId: request.detailId };
}

export function createNativeControlReadDispatcher(dependencies: NativeControlReadDependencies) {
  return Object.freeze({
    async dispatch(command: NativeControlCommand, signal: AbortSignal): Promise<NativeControlDispatchResult | undefined> {
      signal.throwIfAborted();
      const request: any = command.request;
      switch (command.command) {
        case "presentation":
          return Object.freeze({ status: "presentation-required" as const, data: nativeControlGrammarMetadata() as never, diagnostics: Object.freeze([]), human: Object.freeze([]) });
        case "help":
          return projectNativeControlResponse("help", createNativeControlHelp(request.path));
        case "grammar":
          return projectNativeControlResponse("grammar", nativeControlGrammarMetadata());
        case "marketplace.list": {
          const result = await dependencies.marketplace.registration.list({ scope: "user", limit: request.limit }, signal);
          return projectNativeControlResponse(command.command, result);
        }
        case "marketplace.adopt.preview": {
          const result = await dependencies.marketplace.adoption.preview({ compareScope: "user" }, signal);
          return projectNativeControlResponse(command.command, result);
        }
        case "browse": {
          const result = await dependencies.marketplace.catalog.search(request, signal);
          return projectNativeControlResponse(command.command, result, { ...(result.nextCursor === undefined ? {} : { next: result.nextCursor }) });
        }
        case "inspection.list": {
          for (let attempt = 0; attempt < (request.cursor === undefined ? 2 : 1); attempt += 1) {
            try {
              const result = await dependencies.inspection.list({ subjects: ["installed"], ...request }, signal);
              return projectNativeControlResponse(command.command, result, { ...(result.nextCursor === undefined ? {} : { next: result.nextCursor }) });
            } catch (error) {
              if (!(error instanceof NativeInspectionError) || error.code !== "SNAPSHOT_STALE") throw error;
              // An unbound list means "current authority" and may recapture
              // once. Cursor-bound pagination remains exact and reports stale
              // rather than silently switching snapshots.
              if (request.cursor !== undefined || attempt === 1) {
                return projectNativeControlFailure("stale", "CONTROL_SELECTION_STALE", "reinspect");
              }
            }
          }
          return projectNativeControlFailure("stale", "CONTROL_SELECTION_STALE", "reinspect");
        }
        case "inspection.show": {
          const installed = await dependencies.selection.installed(pluginSelector(request), signal);
          if (installed.kind === "selected") return projectNativeControlResponse(command.command, { kind: "found", detail: installed.detail });
          if (installed.kind !== "not-found" && installed.kind !== "wrong-subject") return selectionFailure(installed);
          const candidate = await dependencies.selection.candidate(pluginSelector(request), signal);
          if (candidate.kind !== "selected") return selectionFailure(candidate);
          return projectNativeControlResponse(command.command, { kind: "found", detail: candidate.detail });
        }
        case "inspection.diagnose": {
          if (request.plugin === undefined) {
            const result = await dependencies.inspection.diagnose({ target: { kind: "host" }, includeAdoption: request.includeAdoption }, signal);
            return projectNativeControlResponse(command.command, result);
          }
          const installed = await dependencies.selection.installed(pluginSelector(request), signal);
          const selected = installed.kind === "selected" ? installed : installed.kind === "not-found" || installed.kind === "wrong-subject"
            ? await dependencies.selection.candidate(pluginSelector(request), signal)
            : installed;
          if (selected.kind === "unavailable") {
            // The exact detail cannot be reconstructed, but host diagnosis is
            // still authoritative and includes startup/recovery blocks for the
            // requested owner. Do not replace useful corruption evidence with
            // a generic selection failure.
            const result = await dependencies.inspection.diagnose({ target: { kind: "host" }, includeAdoption: request.includeAdoption }, signal);
            return projectNativeControlResponse(command.command, result);
          }
          if (selected.kind !== "selected") return selectionFailure(selected);
          const result = await dependencies.inspection.diagnose({ target: { kind: "detail", snapshotId: selected.detail.snapshotId, detailId: selected.detail.summary.detailId }, includeAdoption: request.includeAdoption }, signal);
          return projectNativeControlResponse(command.command, result);
        }
        case "updates.status": {
          const result = await dependencies.updates.status(request, signal);
          return projectNativeControlResponse(command.command, result);
        }
        case "updates.policy.preview": {
          const binding = await bindPolicyChange(request.change, dependencies.selection, signal);
          if (binding.kind !== "bound") return currentProjectFailure(binding.project);
          const result = await dependencies.updates.previewPolicy(binding.change as never, signal);
          const status = result.kind === "rejected" ? "rejected" : "ok";
          return projectNativeControlResponse(command.command, result, { status });
        }
        case "updates.notices.list": {
          const result = await dependencies.updates.notifications(request, signal);
          return projectNativeControlResponse(command.command, result, { ...(result.next === undefined ? {} : { next: result.next }) });
        }
        case "status":
          return projectNativeControlResponse(command.command, dependencies.status.snapshot());
        case "operation.status": {
          if (request.token.startsWith("trusted-install-session-v1:")) {
            const result = await dependencies.trustedInstallation.status({ token: request.token }, signal);
            const status = result.kind === "found" ? "ok" : "not-found";
            return projectNativeControlResponse(command.command, result, { status, ...(result.kind === "found" ? { operation: { kind: "trusted-install" as const, token: request.token } } : {}) });
          }
          const result = await dependencies.operations.status({ token: request.token }, signal);
          const status = result.kind === "found" ? "ok" : "not-found";
          return projectNativeControlResponse(command.command, result, { status, ...(result.kind === "found" ? { operation: { kind: "lifecycle" as const, token: request.token } } : {}) });
        }
        case "operation.cancel": {
          if (request.token.startsWith("trusted-install-session-v1:")) {
            const result = await dependencies.trustedInstallation.cancel({ token: request.token }, signal);
            return projectNativeControlResponse(command.command, result, { status: result.kind === "accepted" ? "ok" : "not-found" });
          }
          const result = await dependencies.operations.cancel({ token: request.token }, signal);
          return projectNativeControlResponse(command.command, result, { status: result.kind === "accepted" ? "ok" : "not-found" });
        }
        default:
          return undefined;
      }
    },
  });
}

export type NativeControlPolicyBinding =
  | Readonly<{ kind: "bound"; change: unknown }>
  | Readonly<{ kind: "project-failure"; project: Exclude<NativeControlCurrentProjectResult, { kind: "trusted" }> }>;

export async function bindPolicyChange(
  change: any,
  selection: NativeControlSelectionService,
  signal: AbortSignal,
): Promise<NativeControlPolicyBinding> {
  if (change.target.kind === "global") return { kind: "bound", change };
  if (change.target.scope === "user") return { kind: "bound", change: { ...change, target: { ...change.target, scope: { kind: "user" } } } };
  const project = await selection.currentProject(signal);
  if (project.kind !== "trusted") return { kind: "project-failure", project };
  return { kind: "bound", change: { ...change, target: { ...change.target, scope: project.scope } } };
}
