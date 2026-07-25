import { collectNativeControlInput } from "./native-control-input.js";
import type { NativeControlExecutionId } from "./native-control-contract.js";
import type { NativeControlInputChannel } from "./native-control-registry.js";
import type { NativeControlInputPort, NativeControlInputResult } from "./ports/native-control-input.js";
import type {
  NativeLifecycleOperationConfirmation,
  NativeLifecycleOperationSessionView,
} from "./native-lifecycle-operation-contract.js";

export async function buildNativeLifecycleConfirmation(input: Readonly<{
  executionId: NativeControlExecutionId;
  input: NativeControlInputPort;
  channel: NativeControlInputChannel;
  session: NativeLifecycleOperationSessionView;
  confirmed: boolean;
  persistentData?: "keep" | "delete-confirmed";
  signal: AbortSignal;
}>): Promise<Readonly<{ kind: "confirmation"; confirmation: NativeLifecycleOperationConfirmation }> | Exclude<NativeControlInputResult, { kind: "supplied" }> | Readonly<{ kind: "input-required" }>> {
  const { preview } = input.session;
  if (!input.confirmed && preview.operation !== "update" && preview.operation !== "project-sync") return { kind: "input-required" };
  if (preview.operation === "enable" || preview.operation === "disable") {
    return { kind: "confirmation", confirmation: { kind: "confirm", previewId: preview.previewId, expectedVersion: input.session.version, operation: preview.operation } };
  }
  if (preview.operation === "uninstall") {
    if (input.persistentData === undefined) return { kind: "input-required" };
    return { kind: "confirmation", confirmation: { kind: "confirm-uninstall", previewId: preview.previewId, expectedVersion: input.session.version, persistentData: input.persistentData } };
  }
  if (preview.operation === "project-sync") {
    if (preview.sync === undefined) return { kind: "input-required" };
    if (preview.sync.conflicts.length === 0 && input.confirmed) {
      return { kind: "confirmation", confirmation: { kind: "confirm-project-sync", previewId: preview.previewId, expectedVersion: input.session.version, resolutions: [] } };
    }
    const supplied = await collectNativeControlInput(input.input, {
      executionId: input.executionId,
      purpose: "project-sync-resolution",
      channel: input.channel,
      fields: [],
      expected: {},
    }, input.signal);
    if (supplied.kind !== "supplied") return supplied;
    if (supplied.decision.kind !== "project-sync") return { kind: "input-required" };
    return { kind: "confirmation", confirmation: { kind: "confirm-project-sync", previewId: preview.previewId, expectedVersion: input.session.version, resolutions: supplied.decision.resolutions } };
  }
  if (preview.update === undefined) return { kind: "input-required" };
  const supplied = await collectNativeControlInput(input.input, {
    executionId: input.executionId,
    purpose: "update",
    channel: input.channel,
    fields: preview.update.fields,
    consent: preview.update.consent,
    expectedVersion: input.session.version,
    expected: {
      plugin: preview.update.candidate.plugin,
      scope: preview.update.candidate.scope,
      immutableRevision: preview.update.candidate.immutableRevision,
      executableSurfaceDigest: preview.update.candidate.executableSurfaceDigest,
      consentId: preview.update.consent.consentId,
    },
  }, input.signal);
  if (supplied.kind !== "supplied") return supplied;
  if (supplied.decision.kind !== "grant" || supplied.decision.consentId !== preview.update.consent.consentId) return { kind: "input-required" };
  return {
    kind: "confirmation",
    confirmation: {
      kind: "confirm-update",
      previewId: preview.previewId,
      expectedVersion: input.session.version,
      input: {
        nonSensitive: supplied.nonSensitive,
        sensitive: supplied.sensitive,
        consent: { kind: "grant", consentId: preview.update.consent.consentId },
        authority: preview.update.authority,
      },
    },
  };
}
