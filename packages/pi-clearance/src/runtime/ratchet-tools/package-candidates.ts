import type { PolicyPack } from "../../policy/core.ts";
import {
  notRunWarning,
  proposalNotRunReason,
} from "../../replay/not-run-reasons.ts";
import type {
  AdversarialValidationReport,
  ProposalNotRunReason,
  ProposalValidationCheck,
  ReplayDelta,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import {
  ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
  REPLAY_DELTA_SCHEMA_VERSION,
} from "../../replay/proposal-schema.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";

export type PackageCandidateResolution =
  | { readonly ok: true; readonly candidatePack: PolicyPack }
  | { readonly ok: false; readonly reason: ProposalNotRunReason };

export function resolvePackageCandidateForProposal(input: {
  readonly proposal: StructuredRatchetProposal;
  readonly policy: ResolvedPolicy;
}): PackageCandidateResolution | undefined {
  const { proposal, policy } = input;
  if (
    proposal.kind !== "package-pack-enablement" ||
    proposal.change.kind !== "package-pack-enablement"
  ) {
    return undefined;
  }

  const packId = proposal.change.packId;
  const snapshot = policy.packageRegistration;
  const matches = snapshot.packs.filter(
    (contributed) => contributed.pack.id === packId,
  );

  if (matches.length === 1) {
    const match = matches[0];
    if (match !== undefined) {
      return { ok: true, candidatePack: match.pack };
    }
  }

  if (matches.length > 1) {
    return {
      ok: false,
      reason: proposalNotRunReason({
        code: "package-pack-ambiguous",
        message: `package pack ${JSON.stringify(packId)} is ambiguous across ${matches.length} package registrations; replay and adversarial validation require exactly one registered candidate`,
        details: {
          packId,
          requestId: snapshot.requestId,
          matches: matches.map((match) => ({
            packageName: match.source.packageName,
            packageVersion: match.source.packageVersion,
            packagePath: match.source.packagePath,
          })),
        },
      }),
    };
  }

  if (snapshot.requestId === null && snapshot.packs.length === 0) {
    return {
      ok: false,
      reason: proposalNotRunReason({
        code: "package-registry-unavailable",
        message: `package registry snapshot is unavailable; package pack ${JSON.stringify(packId)} cannot be replayed outside a live package-registration collection`,
        details: {
          packId,
          requestId: snapshot.requestId,
          issues: snapshot.issues,
        },
      }),
    };
  }

  return {
    ok: false,
    reason: proposalNotRunReason({
      code: "package-pack-missing",
      message: `package pack ${JSON.stringify(packId)} is not present in the current package-registration snapshot`,
      details: {
        packId,
        requestId: snapshot.requestId,
        registeredPackIds: snapshot.packs.map((pack) => pack.pack.id),
        issues: snapshot.issues,
      },
    }),
  };
}

export function packageAvailabilityValidationCheck(
  resolution: PackageCandidateResolution | undefined,
): ProposalValidationCheck | undefined {
  if (resolution === undefined) {
    return undefined;
  }
  if (resolution.ok) {
    return {
      status: "pass",
      code: "package-candidate-resolved",
      message:
        "package pack candidate resolved from the live package-registration snapshot",
    };
  }
  return {
    status: "pending",
    code: resolution.reason.code,
    message: resolution.reason.message,
    details: { notRun: resolution.reason },
  };
}

export function packageNotRunReplayDelta(
  reason: ProposalNotRunReason,
): ReplayDelta {
  const empty = emptySummarySnapshot();
  return {
    version: REPLAY_DELTA_SCHEMA_VERSION,
    status: "not-run",
    notRun: reason,
    baseline: empty,
    candidate: empty,
    changedCalls: 0,
    changedUniqueCommands: 0,
    transitions: [],
    improvement: {
      reviewToAllowCalls: 0,
      reviewToAllowUniqueCommands: 0,
      reviewReductionPercent: null,
      remainingReviewCalls: 0,
      unchangedReviewCalls: 0,
    },
    blocked: {
      unknownToolCalls: 0,
      unknownPathCalls: null,
      sealedFloorBlockCalls: 0,
      activeDenyBlockCalls: 0,
      lowFidelityCalls: 0,
      redactedCalls: 0,
    },
    regressions: [],
    changedFamilies: [],
    changedRecords: [],
    warnings: [notRunWarning(reason)],
  };
}

export function packageNotRunAdversarialReport(input: {
  readonly proposalId: string;
  readonly reason: ProposalNotRunReason;
}): AdversarialValidationReport {
  return {
    version: ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
    proposalId: input.proposalId,
    status: "not-run",
    notRun: input.reason,
    generatedCaseCount: 0,
    evaluatedCaseCount: 0,
    failedCaseCount: 0,
    skippedCaseCount: 0,
    cases: [],
    results: [],
    warnings: [notRunWarning(input.reason)],
  };
}

function emptySummarySnapshot(): ReplayDelta["baseline"] {
  return {
    totalRecords: 0,
    totalUniqueCommands: 0,
    replayStatusCounts: [],
    capturedOutcomeCounts: [],
    sourceCounts: [],
    modelReviewLoad: { calls: 0, uniqueCommands: 0 },
    lowFidelityCalls: 0,
    redactedCalls: 0,
    unmatchedAuditEntries: 0,
  };
}
