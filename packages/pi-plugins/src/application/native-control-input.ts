import { SensitiveValue } from "./sensitive-value.js";
import type {
  NativeControlInputIssue,
  NativeControlInputPort,
  NativeControlInputRequest,
  NativeControlInputResult,
} from "./ports/native-control-input.js";
import type { TrustedInstallSubmission } from "./trusted-install-contract.js";

export const unavailableNativeControlInput: NativeControlInputPort = Object.freeze({
  async collect(_request: NativeControlInputRequest, signal: AbortSignal): Promise<NativeControlInputResult> {
    signal.throwIfAborted();
    return Object.freeze({ kind: "unavailable" as const, code: "NO_INPUT_CHANNEL" as const });
  },
});

function issue(code: NativeControlInputIssue["code"], key?: string): NativeControlInputIssue {
  return Object.freeze({ code, ...(key === undefined ? {} : { key }) });
}

/**
 * Validate adapter output against the exact owner disclosure. The adapter owns
 * custody; this layer only classifies keys/sensitivity and deliberately leaves
 * type/path/configuration policy to the existing installation/lifecycle owner.
 */
export function validateNativeControlInput(
  request: NativeControlInputRequest,
  result: NativeControlInputResult,
): NativeControlInputResult {
  if (result.kind !== "supplied") return result;
  const fields = new Map(request.fields.map((field) => [field.key, field]));
  const seen = new Set<string>();
  const issues: NativeControlInputIssue[] = [];
  for (const entry of result.nonSensitive) {
    const field = fields.get(entry.key);
    if (seen.has(entry.key)) issues.push(issue("INPUT_DUPLICATE_KEY", entry.key));
    else if (field === undefined) issues.push(issue("INPUT_UNKNOWN_KEY", entry.key));
    else if (field.sensitive) issues.push(issue("INPUT_SENSITIVITY_MISMATCH", entry.key));
    seen.add(entry.key);
  }
  for (const entry of result.sensitive) {
    const field = fields.get(entry.key);
    if (seen.has(entry.key)) issues.push(issue("INPUT_DUPLICATE_KEY", entry.key));
    else if (field === undefined) issues.push(issue("INPUT_UNKNOWN_KEY", entry.key));
    else if (!field.sensitive || !(entry.value instanceof SensitiveValue)) issues.push(issue("INPUT_SENSITIVITY_MISMATCH", entry.key));
    seen.add(entry.key);
  }
  for (const field of request.fields) {
    if (field.required && field.state === "missing" && !seen.has(field.key)) issues.push(issue("INPUT_REQUIRED", field.key));
  }
  if (request.consent !== undefined) {
    if (result.decision.kind !== "grant" && result.decision.kind !== "deny") issues.push(issue("INPUT_DECISION_REQUIRED"));
    else if (result.decision.consentId !== request.consent.consentId) issues.push(issue("INPUT_EXPECTATION_STALE"));
  }
  if (request.expected.consentId !== undefined &&
      (result.decision.kind !== "grant" || result.decision.consentId !== request.expected.consentId)) {
    issues.push(issue("INPUT_EXPECTATION_STALE"));
  }
  return issues.length === 0 ? result : Object.freeze({ kind: "invalid" as const, issues: Object.freeze(issues) });
}

export async function collectNativeControlInput(
  port: NativeControlInputPort,
  request: NativeControlInputRequest,
  signal: AbortSignal,
): Promise<NativeControlInputResult> {
  signal.throwIfAborted();
  const result = await port.collect(request, signal);
  signal.throwIfAborted();
  return validateNativeControlInput(request, result);
}

export function toTrustedInstallSubmission(
  request: NativeControlInputRequest,
  result: Extract<NativeControlInputResult, { kind: "supplied" }>,
): TrustedInstallSubmission {
  if (request.expectedVersion === undefined || request.consent === undefined ||
      (result.decision.kind !== "grant" && result.decision.kind !== "deny")) {
    throw new TypeError("trusted installation input is missing exact session evidence");
  }
  return Object.freeze({
    expectedVersion: request.expectedVersion,
    nonSensitive: Object.freeze([...result.nonSensitive]),
    sensitive: Object.freeze([...result.sensitive]),
    consent: result.decision.kind === "grant"
      ? Object.freeze({ kind: "grant" as const, consentId: request.consent.consentId })
      : Object.freeze({ kind: "deny" as const, consentId: request.consent.consentId }),
  });
}

export function inputRequiredIssues(result: NativeControlInputResult): readonly NativeControlInputIssue[] {
  if (result.kind === "invalid") return result.issues;
  if (result.kind === "unavailable") return Object.freeze([issue("INPUT_DECISION_REQUIRED")]);
  return Object.freeze([]);
}
