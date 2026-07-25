import { proposalRequiredAcknowledgementCodes } from "./proposal-acknowledgements.ts";
import type {
  ProposalValidation,
  ProposalValidationCheck,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";
import {
  proposalJsonRoundTrip,
  validateStructuredProposal,
} from "./proposal-schema.ts";

export type ProposalApprovalDecision =
  | "accept"
  | "accept-without-replay"
  | "reject"
  | "revise"
  | "skip"
  | "aborted";

export type ProposalApprovalRoute =
  | "writable"
  | "design-input-only"
  | "no-write";

export interface ProposalApprovalFailure {
  readonly code: string;
  readonly message: string;
  readonly check?: keyof StructuredRatchetProposal["validation"];
  readonly status?: ProposalValidationCheck["status"];
}

export interface ProposalApprovalGateInput {
  readonly proposal: StructuredRatchetProposal;
  readonly decision: ProposalApprovalDecision;
}

export type ProposalApprovalGateResult =
  | {
      readonly ok: true;
      readonly route: "writable";
      readonly warnings: readonly string[];
      readonly requiredAcknowledgementCodes: readonly string[];
    }
  | {
      readonly ok: true;
      readonly route: "design-input-only" | "no-write";
      readonly warnings: readonly string[];
      readonly requiredAcknowledgementCodes: readonly [];
    }
  | {
      readonly ok: false;
      readonly route: "no-write";
      readonly failures: readonly ProposalApprovalFailure[];
      readonly warnings: readonly string[];
    };

export function evaluateProposalApprovalGate(
  input: ProposalApprovalGateInput,
): ProposalApprovalGateResult {
  const warnings = [...input.proposal.warnings];

  if (
    input.decision !== "accept" &&
    input.decision !== "accept-without-replay"
  ) {
    return {
      ok: true,
      route: "no-write",
      warnings,
      requiredAcknowledgementCodes: [],
    };
  }

  const validationFailures = validateProposalTransport(input.proposal);
  if (validationFailures.length > 0) {
    return failure(validationFailures, warnings);
  }

  if (isDesignInputOnlyProposal(input.proposal)) {
    return {
      ok: true,
      route: "design-input-only",
      warnings,
      requiredAcknowledgementCodes: [],
    };
  }

  const failures = [
    ...provenanceFailures(input.proposal),
    ...validationStatusFailures(input.proposal, {
      allowPendingReplay: input.decision === "accept-without-replay",
    }),
    ...kindSpecificValidationFailures(input.proposal, {
      allowPendingReplay: input.decision === "accept-without-replay",
    }),
  ];
  const warningsWithReplayOverride =
    input.decision === "accept-without-replay"
      ? [
          ...warnings,
          "Human explicitly approved without replay evidence; this allow rule was not automatically validated against a captured corpus.",
        ]
      : warnings;
  if (failures.length > 0) {
    return failure(failures, warningsWithReplayOverride);
  }

  return {
    ok: true,
    route: "writable",
    warnings: warningsWithReplayOverride,
    requiredAcknowledgementCodes: requiredAcknowledgementCodes(input.proposal),
  };
}

export function isDesignInputOnlyProposal(
  proposal: StructuredRatchetProposal,
): boolean {
  return (
    proposal.applicationMode === "design-input-only" ||
    proposal.target.kind === "design-input"
  );
}

function validateProposalTransport(
  proposal: StructuredRatchetProposal,
): readonly ProposalApprovalFailure[] {
  const schema = validateStructuredProposal(proposal);
  if (!schema.ok) {
    return schema.errors.map((message, index) => ({
      code: `proposal-schema-invalid-${index}`,
      message,
      check: "schema" as const,
    }));
  }

  const jsonCompatibilityFailures = jsonCompatibilityErrors(schema.proposal);
  if (jsonCompatibilityFailures.length > 0) {
    return jsonCompatibilityFailures.map((message, index) => ({
      code: `proposal-json-incompatible-${index}`,
      message,
      check: "schema" as const,
    }));
  }

  try {
    proposalJsonRoundTrip(schema.proposal);
  } catch (error) {
    return [
      {
        code: "proposal-json-round-trip-invalid",
        message:
          error instanceof Error
            ? error.message
            : "structured proposal failed JSON round-trip validation",
        check: "schema",
      },
    ];
  }

  if (proposal.provenance.source !== "generated") {
    return [
      {
        code: "proposal-provenance-not-generated",
        message: `proposal provenance source must be "generated", got "${proposal.provenance.source}"`,
      },
    ];
  }

  return [];
}

function jsonCompatibilityErrors(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>(),
): readonly string[] {
  if (value === null) {
    return [];
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return [];
    case "number":
      return Number.isFinite(value) ? [] : [`${path}: non-finite number`];
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return [`${path}: ${typeof value} is not JSON-compatible`];
    case "object":
      break;
  }

  if (seen.has(value)) {
    return [`${path}: cyclic object is not JSON-compatible`];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const errors = value.flatMap((entry, index) =>
      jsonCompatibilityErrors(entry, `${path}[${index}]`, seen),
    );
    seen.delete(value);
    return errors;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return [`${path}: non-plain object is not JSON-compatible`];
  }

  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    seen.delete(value);
    return [`${path}: symbol-keyed properties are not JSON-compatible`];
  }

  const errors = Object.entries(value).flatMap(([key, entry]) =>
    jsonCompatibilityErrors(entry, `${path}.${key}`, seen),
  );
  seen.delete(value);
  return errors;
}

function provenanceFailures(
  proposal: StructuredRatchetProposal,
): readonly ProposalApprovalFailure[] {
  const expected = expectedWritableProvenance(proposal);
  if (expected === undefined) {
    return [
      {
        code: "proposal-target-not-writable",
        message: `proposal target "${proposal.target.kind}" is not a writable ratchet approval target`,
      },
    ];
  }

  if (proposal.intendedProvenance !== expected) {
    return [
      {
        code: "proposal-intended-provenance-mismatch",
        message: `proposal intendedProvenance must be "${expected}" for this target, got ${JSON.stringify(
          proposal.intendedProvenance,
        )}`,
      },
    ];
  }

  return [];
}

function expectedWritableProvenance(
  proposal: StructuredRatchetProposal,
): "user-global" | "user-project" | undefined {
  switch (proposal.target.kind) {
    case "user-global-config":
      return "user-global";
    case "user-project-overlay":
      return "user-project";
    case "package-pack-config":
      if (proposal.change.kind !== "package-pack-enablement") {
        return undefined;
      }
      return proposal.change.plan.request.scope === "global"
        ? "user-global"
        : "user-project";
    case "design-input":
      return undefined;
  }
}

/**
 * The human "approve without replay evidence" override exists for exactly one
 * situation: replay could not run because no captured corpus exists. Any
 * other pending replay reason (compile-failed, missing-path-facts, package
 * resolution, …) means the proposal itself is not validated — the override
 * must not waive it.
 */
function isNoCorpusPendingReplay(status: {
  readonly status: string;
  readonly details?: unknown;
}): boolean {
  if (status.status !== "pending") return false;
  const details = status.details;
  if (typeof details !== "object" || details === null) return false;
  const notRun = (details as { readonly notRun?: unknown }).notRun;
  if (typeof notRun !== "object" || notRun === null) return false;
  return (notRun as { readonly code?: unknown }).code === "no-captured-corpus";
}

function validationStatusFailures(
  proposal: StructuredRatchetProposal,
  options: { readonly allowPendingReplay: boolean } = {
    allowPendingReplay: false,
  },
): readonly ProposalApprovalFailure[] {
  const failures: ProposalApprovalFailure[] = [];
  for (const [check, status] of validationEntries(proposal.validation)) {
    if (
      status.status === "fail" ||
      (options.allowPendingReplay &&
        check === "replay" &&
        isNoCorpusPendingReplay(status))
    ) {
      if (
        options.allowPendingReplay &&
        check === "replay" &&
        isNoCorpusPendingReplay(status)
      ) {
        continue;
      }
      failures.push({
        code: "proposal-validation-check-failed",
        message: `${check}: ${status.message}`,
        check,
        status: status.status,
      });
    }
  }

  const schema = proposal.validation.schema;
  if (schema.status !== "pass") {
    failures.push({
      code: "proposal-schema-check-not-passing",
      message: `schema check must pass before approval writes; got ${schema.status}`,
      check: "schema",
      status: schema.status,
    });
  }

  return failures;
}

function kindSpecificValidationFailures(
  proposal: StructuredRatchetProposal,
  options: { readonly allowPendingReplay: boolean } = {
    allowPendingReplay: false,
  },
): readonly ProposalApprovalFailure[] {
  switch (proposal.kind) {
    case "data-pack-policy":
      return dataPackPolicyFailures(proposal, options);
    case "reviewer-config":
      // Config-schema and prompt-override checks are writer/post-write-owned for
      // reviewer proposals. validationStatusFailures() has already rejected
      // hard fails, so pending/skipped checks remain acceptable here.
      return [];
    case "project-scope-config":
      return deterministicPolicyAffectingFailures(
        proposal.validation,
        ["replay"],
        options,
      );
    case "package-pack-enablement":
      return deterministicPolicyAffectingFailures(
        proposal.validation,
        ["packageAvailability", "replay"],
        options,
      );
    case "pack-file-authoring":
      return [
        {
          code: "pack-file-authoring-not-writable",
          message:
            "pack-file-authoring proposals must route as design input, not writer plans",
        },
      ];
  }
}

function dataPackPolicyFailures(
  proposal: StructuredRatchetProposal,
  options: { readonly allowPendingReplay: boolean } = {
    allowPendingReplay: false,
  },
): readonly ProposalApprovalFailure[] {
  if (proposal.change.kind !== "policy-pack") {
    return [
      {
        code: "proposal-change-kind-mismatch",
        message: `data-pack-policy proposal must carry a policy-pack change, got "${proposal.change.kind}"`,
      },
    ];
  }

  const requiredChecks: (keyof ProposalValidation)[] = [
    "matcherCompile",
    "replay",
  ];

  if (proposal.change.effect === "allow") {
    requiredChecks.push("floorOverlap", "adversarial");
  }

  const failures = deterministicPolicyAffectingFailures(
    proposal.validation,
    requiredChecks,
    options,
  );

  if (proposal.change.effect !== "allow") {
    const floor = proposal.validation.floorOverlap;
    if (floor !== undefined && !isPassOrSkipped(floor)) {
      return [
        ...failures,
        statusFailure({
          check: "floorOverlap",
          status: floor,
          code: "floor-overlap-not-passing-or-skipped",
          message:
            "floorOverlap must pass or be skipped only when not applicable for non-allow policy proposals",
        }),
      ];
    }
  }

  return failures;
}

function deterministicPolicyAffectingFailures(
  validation: ProposalValidation,
  checks: readonly (keyof ProposalValidation)[],
  options: { readonly allowPendingReplay: boolean } = {
    allowPendingReplay: false,
  },
): readonly ProposalApprovalFailure[] {
  return checks.flatMap((check) => {
    const status = validation[check];
    if (status === undefined) {
      return [
        {
          code: `${check}-missing`,
          message: `${check} validation must pass before this proposal can be written`,
          check,
        } satisfies ProposalApprovalFailure,
      ];
    }
    if (
      options.allowPendingReplay &&
      check === "replay" &&
      isNoCorpusPendingReplay(status)
    ) {
      return [];
    }
    if (status.status !== "pass") {
      return [
        statusFailure({
          check,
          status,
          code: `${check}-not-passing`,
          message: `${check} validation must pass before this proposal can be written`,
        }),
      ];
    }
    return [];
  });
}

function requiredAcknowledgementCodes(
  proposal: StructuredRatchetProposal,
): readonly string[] {
  return proposalRequiredAcknowledgementCodes(proposal);
}

function validationEntries(
  validation: ProposalValidation,
): readonly (readonly [keyof ProposalValidation, ProposalValidationCheck])[] {
  return Object.entries(validation) as (readonly [
    keyof ProposalValidation,
    ProposalValidationCheck,
  ])[];
}

function isPassOrSkipped(check: ProposalValidationCheck): boolean {
  return check.status === "pass" || check.status === "skipped";
}

function statusFailure(input: {
  readonly check: keyof ProposalValidation;
  readonly status: ProposalValidationCheck;
  readonly code: string;
  readonly message: string;
}): ProposalApprovalFailure {
  return {
    code: input.code,
    message: `${input.message}; got ${input.status.status}: ${input.status.message}`,
    check: input.check,
    status: input.status.status,
  };
}

function failure(
  failures: readonly ProposalApprovalFailure[],
  warnings: readonly string[],
): ProposalApprovalGateResult {
  return {
    ok: false,
    route: "no-write",
    failures,
    warnings,
  };
}
