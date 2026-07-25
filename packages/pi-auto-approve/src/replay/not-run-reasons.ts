import type {
  ProposalNotRunReason,
  ProposalNotRunReasonCode,
  ProposalValidationStatus,
} from "./proposal-schema.ts";

export const PROPOSAL_NOT_RUN_SKIPPED_CODES = [
  "unsupported-kind",
  "no-cases",
  "model-evaluation-required",
  "design-input-only",
] as const satisfies readonly ProposalNotRunReasonCode[];

export const PROPOSAL_NOT_RUN_PENDING_CODES = [
  "missing-candidate-pack",
  "compile-failed",
  "package-registry-unavailable",
  "package-pack-missing",
  "package-pack-ambiguous",
  "missing-path-facts",
  "replay-impact-not-run",
] as const satisfies readonly ProposalNotRunReasonCode[];

const SKIPPED_CODES = new Set<ProposalNotRunReasonCode>(
  PROPOSAL_NOT_RUN_SKIPPED_CODES,
);
const PENDING_CODES = new Set<ProposalNotRunReasonCode>(
  PROPOSAL_NOT_RUN_PENDING_CODES,
);

export function proposalNotRunReason(input: {
  readonly code: ProposalNotRunReasonCode;
  readonly message: string;
  readonly severity?: ProposalNotRunReason["severity"];
  readonly details?: unknown;
}): ProposalNotRunReason {
  const base = {
    code: input.code,
    message: input.message,
    severity: input.severity ?? defaultSeverityForNotRunCode(input.code),
  } as const;
  return input.details === undefined
    ? base
    : { ...base, details: input.details };
}

export function notRunWarning(reason: ProposalNotRunReason): string {
  return reason.message;
}

export function validationStatusForNotRunReason(
  reason: ProposalNotRunReason | undefined,
): Extract<ProposalValidationStatus, "pending" | "skipped"> {
  if (reason === undefined) {
    return "pending";
  }
  if (SKIPPED_CODES.has(reason.code)) {
    return "skipped";
  }
  if (PENDING_CODES.has(reason.code)) {
    return "pending";
  }

  // Defensive fail-closed fallback for unvalidated in-memory objects. Schema
  // validation rejects unknown codes at boundaries, but callers should still
  // avoid accidentally treating an unfamiliar not-run state as skipped.
  return "pending";
}

function defaultSeverityForNotRunCode(
  code: ProposalNotRunReasonCode,
): ProposalNotRunReason["severity"] {
  return validationStatusForNotRunReason({
    code,
    message: code,
    severity: "warning",
  }) === "skipped"
    ? "info"
    : "warning";
}
