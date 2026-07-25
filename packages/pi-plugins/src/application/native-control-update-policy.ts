import type { NativeUpdateManagementService } from "./native-update-management-service.js";
import type { NativeControlSelectionService } from "./native-control-selection.js";
import { bindPolicyChange, currentProjectFailure } from "./native-control-read-dispatch.js";
import type { NativeControlDispatchResult } from "./native-control-projection.js";
import { projectNativeControlFailure, projectNativeControlResponse } from "./native-control-projection.js";
import type { NativeControlCommand } from "./native-control-registry.js";

function applyStatus(result: Awaited<ReturnType<NativeUpdateManagementService["applyPolicy"]>>) {
  if (result.kind === "changed") return "ok" as const;
  if (result.kind === "unchanged") return "no-change" as const;
  if (result.kind === "stale") return "stale" as const;
  if (result.kind === "rejected") return result.code === "CONSENT_REQUIRED" || result.code === "CONSENT_INVALID" ? "input-required" as const : "rejected" as const;
  return "failed" as const;
}

export async function dispatchNativeControlPolicy(
  command: Extract<NativeControlCommand, { command: "updates.policy.apply" | "updates.policy.set" }>,
  dependencies: Readonly<{ updates: NativeUpdateManagementService; selection: NativeControlSelectionService }>,
  signal: AbortSignal,
): Promise<NativeControlDispatchResult> {
  const request: any = command.request;
  const binding = await bindPolicyChange(request.change, dependencies.selection, signal);
  if (binding.kind !== "bound") return currentProjectFailure(binding.project);
  const change = binding.change;
  if (command.command === "updates.policy.apply") {
    const result = await dependencies.updates.applyPolicy({
      change: change as never,
      expectedPreviewId: request.previewId,
      ...(request.consentId === undefined ? {} : { consent: { kind: "grant", consentId: request.consentId } }),
    }, signal);
    return projectNativeControlResponse(command.command, result, { status: applyStatus(result) });
  }

  const preview = await dependencies.updates.previewPolicy(change as never, signal);
  if (preview.kind === "rejected") return projectNativeControlResponse(command.command, preview, { status: "rejected" });
  if (request.previewId !== undefined && request.previewId !== preview.preview.previewId) return projectNativeControlFailure("stale", "CONTROL_POLICY_PREVIEW_STALE", "reparse");
  if (preview.preview.consent.required && request.consentId === undefined) {
    return projectNativeControlResponse(command.command, preview, { status: "input-required" });
  }
  const result = await dependencies.updates.applyPolicy({
    change: change as never,
    expectedPreviewId: preview.preview.previewId,
    ...(request.consentId === undefined ? {} : { consent: { kind: "grant", consentId: request.consentId } }),
  }, signal);
  return projectNativeControlResponse(command.command, result, { status: applyStatus(result) });
}
