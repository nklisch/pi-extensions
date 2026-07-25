import type {
  PackEnablementAcknowledgement,
  PackEnablementPlan,
  PackEnablementWarning,
} from "../packs/enablement.ts";
import {
  applyPackEnablementCommand,
  type PackEnablementCommandApplyDependencies,
} from "../packs/enablement-command.ts";
import type { PackReplayImpactSummary } from "../packs/validation.ts";
import { packReplayImpactToReplayDelta } from "./proposal-replay-delta.ts";
import {
  assertStructuredProposal,
  PROPOSAL_SCHEMA_VERSION,
  type ProposalEvidence,
  type ProposalTrustNote,
  type ProposalValidation,
  type ProposalValidationCheck,
  type StructuredRatchetProposal,
} from "./proposal-schema.ts";

export interface PackEnablementProposalInput {
  readonly plan: PackEnablementPlan;
  readonly createdAt: string;
  readonly evidence: ProposalEvidence;
  readonly replayImpact?: PackReplayImpactSummary;
}

export interface ApplyPackEnablementProposalInput {
  readonly proposal: StructuredRatchetProposal;
  readonly acknowledgement: PackEnablementAcknowledgement;
}

export type ApplyPackEnablementProposalResult = Awaited<
  ReturnType<typeof applyPackEnablementCommand>
>;

/**
 * Convert a validated pack-enable preview plan into the structured proposal
 * transport. Generation remains read-only: `applicationMode` records that the
 * writer may apply later only after explicit confirmation and acknowledgements.
 */
export function packEnablementPlanToStructuredProposal(
  input: PackEnablementProposalInput,
): StructuredRatchetProposal {
  const { plan } = input;
  const proposal: StructuredRatchetProposal = {
    version: PROPOSAL_SCHEMA_VERSION,
    id: plan.id,
    kind: "package-pack-enablement",
    title: `${capitalize(plan.request.action)} ${plan.request.packId}`,
    summary: summaryFor(plan),
    reason: reasonFor(plan),
    createdAt: input.createdAt,
    provenance: { source: "generated" },
    intendedProvenance:
      plan.request.scope === "global" ? "user-global" : "user-project",
    // Pack-enablement apply is controlled by the exact stored plan plus the
    // writer's required acknowledgement codes. Replay status is surfaced as
    // operator evidence below, but it is not itself an application gate unless
    // a future planner encodes that gate into the plan/writer contract.
    applicationMode: "writable-after-approval",
    target: targetFor(plan),
    change: {
      kind: "package-pack-enablement",
      packId: plan.request.packId,
      enable: plan.request.action === "enable",
      metadataWarnings: plan.warnings
        .filter((warning) => warning.source === "metadata")
        .map((warning) => warning.message),
      plan,
    },
    evidence: evidenceWithReplay(input.evidence, input.replayImpact),
    examples: [],
    fixtureSuggestions: [],
    validation: validationFor(plan, input.replayImpact),
    trustNotes: trustNotesFor(plan),
    warnings: plan.warnings.map(formatWarning),
  };

  return assertStructuredProposal(proposal);
}

/** Apply a persisted structured package-pack-enablement proposal through the shared writer. */
export async function applyPackEnablementProposal(
  input: ApplyPackEnablementProposalInput,
  dependencies: PackEnablementCommandApplyDependencies,
): Promise<ApplyPackEnablementProposalResult> {
  const change = input.proposal.change;
  if (
    input.proposal.kind !== "package-pack-enablement" ||
    change.kind !== "package-pack-enablement"
  ) {
    return {
      ok: false,
      planId: input.proposal.id,
      targetPath: proposalTargetPath(input.proposal),
      reason: `proposal "${input.proposal.id}" is not a package-pack-enablement proposal`,
      wrote: false,
      restored: false,
      errors: [],
      cacheInvalidated: false,
    };
  }

  return await applyPackEnablementCommand(
    {
      // The structured schema validates this JSON snapshot against the plan
      // fields the writer consumes. `before/after.packs` remain opaque JSON in
      // transport but the writer only deep-compares and patches them.
      plan: change.plan as unknown as PackEnablementPlan,
      acknowledgement: input.acknowledgement,
    },
    dependencies,
  );
}

function targetFor(
  plan: PackEnablementPlan,
): StructuredRatchetProposal["target"] {
  return {
    kind: "package-pack-config",
    path: plan.targetPath,
    packId: plan.request.packId,
  };
}

function proposalTargetPath(proposal: StructuredRatchetProposal): string {
  const target = proposal.target;
  if (
    target.kind === "user-global-config" ||
    target.kind === "user-project-overlay" ||
    target.kind === "package-pack-config"
  ) {
    return target.path;
  }
  return "";
}

function validationFor(
  plan: PackEnablementPlan,
  replayImpact: PackReplayImpactSummary | undefined,
): ProposalValidation {
  return {
    schema: check("pass", "schema-ok", "proposal conforms to schema"),
    packageAvailability:
      plan.request.action === "enable"
        ? check(
            "pass",
            "package-availability-ok",
            `pack ${plan.request.packId} was validated during preview`,
          )
        : check(
            "skipped",
            "package-availability-skipped-for-disable",
            "disable is a safe tightening direction and does not require package availability",
          ),
    configSchema: check(
      "pending",
      "config-schema-pending",
      "writer validates the target config again at apply time",
    ),
    trust: trustCheck(plan),
    replay: replayCheck(replayImpact),
  };
}

function trustCheck(plan: PackEnablementPlan): ProposalValidationCheck {
  if (plan.requiredAcknowledgementCodes.length > 0) {
    return check(
      "pending",
      "warning-ack-required",
      "operator must acknowledge required warnings before apply",
    );
  }

  return check("pass", "trust-ok", "no trust acknowledgement required");
}

function replayCheck(
  replayImpact: PackReplayImpactSummary | undefined,
): ProposalValidationCheck {
  if (replayImpact === undefined) {
    return check(
      "pending",
      "replay-not-run",
      "no replay impact was supplied for this proposal",
    );
  }

  if (replayImpact.status === "regression") {
    return check(
      "fail",
      "replay-regression",
      "replay impact contains unsafe status transitions; advisory evidence only, not an apply gate",
      packReplayImpactToReplayDelta(replayImpact),
    );
  }

  return check(
    replayImpact.status === "passed" ? "pass" : "pending",
    replayImpact.status === "passed" ? "replay-ok" : "replay-not-run",
    replayImpact.status === "passed"
      ? "replay impact was supplied and found no regressions"
      : "replay impact was not run",
    packReplayImpactToReplayDelta(replayImpact),
  );
}

function check(
  status: ProposalValidationCheck["status"],
  code: string,
  message: string,
  details?: unknown,
): ProposalValidationCheck {
  return {
    status,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function trustNotesFor(plan: PackEnablementPlan): readonly ProposalTrustNote[] {
  const notes: ProposalTrustNote[] = [
    {
      kind: "package-pack-enablement",
      message:
        "This proposal changes user-owned enablement config only; it does not install package code or apply during generation.",
      severity: "info",
    },
  ];

  for (const warning of plan.warnings) {
    if (!warning.requiresAcknowledgement) {
      continue;
    }
    notes.push({
      kind: warning.source,
      message: warning.message,
      severity: warning.level,
    });
  }

  return notes;
}

function evidenceWithReplay(
  evidence: ProposalEvidence,
  replayImpact: PackReplayImpactSummary | undefined,
): ProposalEvidence {
  if (replayImpact === undefined) {
    return evidence;
  }

  return {
    ...evidence,
    replayDelta: packReplayImpactToReplayDelta(replayImpact),
  };
}

function summaryFor(plan: PackEnablementPlan): string {
  const direction = plan.request.action === "enable" ? "Enable" : "Disable";
  return `${direction} ${plan.request.subject} pack "${plan.request.packId}" in ${plan.request.scope} config.`;
}

function reasonFor(plan: PackEnablementPlan): string {
  const acknowledgement =
    plan.requiredAcknowledgementCodes.length === 0
      ? "No warning acknowledgements are required."
      : `Requires acknowledgement: ${plan.requiredAcknowledgementCodes.join(", ")}.`;
  return `${summaryFor(plan)} ${acknowledgement}`;
}

function formatWarning(warning: PackEnablementWarning): string {
  return `[${warning.level}][${warning.source}] ${warning.code}: ${warning.message}`;
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}
