import type { NativeControlExecutionId } from "./native-control-contract.js";
import { collectNativeControlInput, toTrustedInstallSubmission } from "./native-control-input.js";
import type { NativeControlInputChannel } from "./native-control-registry.js";
import type { NativeControlInputPort, NativeControlInputResult, NativeControlInputPurpose } from "./ports/native-control-input.js";
import type { TrustedInstallSessionView, TrustedInstallSubmission } from "./trusted-install-contract.js";

export async function collectTrustedInstallSubmission(input: Readonly<{
  executionId: NativeControlExecutionId;
  input: NativeControlInputPort;
  channel: NativeControlInputChannel;
  purpose: Extract<NativeControlInputPurpose, "trusted-install" | "trusted-install-recovery" | "update">;
  session: TrustedInstallSessionView;
  signal: AbortSignal;
}>): Promise<Readonly<{ kind: "submission"; submission: TrustedInstallSubmission }> | Exclude<NativeControlInputResult, { kind: "supplied" }>> {
  const result = await collectNativeControlInput(input.input, {
    executionId: input.executionId,
    purpose: input.purpose,
    channel: input.channel,
    fields: input.session.fields,
    consent: input.session.consent,
    expectedVersion: input.session.version,
    expected: {
      plugin: input.session.binding.plugin,
      scope: input.session.binding.scope,
      immutableRevision: input.session.binding.immutableRevision,
      executableSurfaceDigest: input.session.binding.executableSurfaceDigest,
      consentId: input.session.consent.consentId,
    },
  }, input.signal);
  if (result.kind !== "supplied") return result;
  return Object.freeze({ kind: "submission" as const, submission: toTrustedInstallSubmission({
    executionId: input.executionId,
    purpose: input.purpose,
    channel: input.channel,
    fields: input.session.fields,
    consent: input.session.consent,
    expectedVersion: input.session.version,
    expected: {
      plugin: input.session.binding.plugin,
      scope: input.session.binding.scope,
      immutableRevision: input.session.binding.immutableRevision,
      executableSurfaceDigest: input.session.binding.executableSurfaceDigest,
      consentId: input.session.consent.consentId,
    },
  }, result) });
}
