import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ReplayCorpus } from "../../replay/history.ts";
import type {
  ReplayDelta,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import { buildReplayDeltaForPolicies as defaultBuildReplayDeltaForPolicies } from "../../replay/replay-delta.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import { readRatchetReplayCorpus } from "./analysis.ts";
import type { RatchetToolDependencies } from "./types.ts";

export type PostWriteReplayStatus =
  | "not-applicable"
  | "passed"
  | "regression"
  | "not-run"
  | "failed";

export interface PostWriteReplayResult {
  readonly status: PostWriteReplayStatus;
  readonly proposalId: string;
  readonly applicable: boolean;
  readonly delta?: ReplayDelta;
  readonly reason?: string;
  readonly warnings: readonly string[];
}

export interface PostWriteReplayEngines {
  readonly readCorpus?: (ctx: ExtensionContext) => ReplayCorpus;
  readonly buildReplayDeltaForPolicies?: typeof defaultBuildReplayDeltaForPolicies;
}

export async function runPostWriteReplay(input: {
  readonly proposal: StructuredRatchetProposal;
  readonly beforePolicy: ResolvedPolicy;
  readonly afterPolicy: ResolvedPolicy;
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly engines?: PostWriteReplayEngines;
}): Promise<PostWriteReplayResult> {
  if (!isPostWriteReplayApplicable(input.proposal)) {
    return notApplicable(input.proposal, notApplicableReason(input.proposal));
  }

  try {
    const readCorpus = input.engines?.readCorpus ?? readRatchetReplayCorpus;
    const buildReplayDelta =
      input.engines?.buildReplayDeltaForPolicies ??
      defaultBuildReplayDeltaForPolicies;
    const corpus = readCorpus(input.ctx);
    const delta = await buildReplayDelta({
      corpus,
      baselinePolicy: input.beforePolicy.effectivePolicy,
      candidatePolicy: input.afterPolicy.effectivePolicy,
      unknownToolPosture: input.afterPolicy.config.unknownToolPosture,
      pathFacts: {
        baseline: {
          cwd: input.beforePolicy.config.cwd,
          projectScope: input.beforePolicy.config.projectScope,
        },
        candidate: {
          cwd: input.afterPolicy.config.cwd,
          projectScope: input.afterPolicy.config.projectScope,
        },
      },
    });

    switch (delta.status) {
      case "passed":
        return {
          status: "passed",
          proposalId: input.proposal.id,
          applicable: true,
          delta,
          warnings: delta.warnings,
        };
      case "regression":
        return {
          status: "regression",
          proposalId: input.proposal.id,
          applicable: true,
          delta,
          reason: `post-write replay found ${delta.regressions.length} regression(s) across ${delta.changedCalls} changed call(s)`,
          warnings: delta.warnings,
        };
      case "not-run":
        return {
          status: "not-run",
          proposalId: input.proposal.id,
          applicable: true,
          delta,
          reason:
            delta.warnings.find((warning) => warning.trim().length > 0) ??
            "post-write replay did not run",
          warnings: delta.warnings,
        };
    }
  } catch (error: unknown) {
    return {
      status: "failed",
      proposalId: input.proposal.id,
      applicable: true,
      reason: `post-write replay failed: ${errorMessage(error)}`,
      warnings: [],
    };
  }
}

export function isPostWriteReplayApplicable(
  proposal: StructuredRatchetProposal,
): boolean {
  if (
    proposal.applicationMode === "design-input-only" ||
    proposal.target.kind === "design-input"
  ) {
    return false;
  }

  switch (proposal.kind) {
    case "data-pack-policy":
    case "project-scope-config":
    case "package-pack-enablement":
      return true;
    case "reviewer-config":
    case "pack-file-authoring":
      return false;
  }
}

export function notApplicablePostWriteReplay(
  proposal: StructuredRatchetProposal,
  reason: string,
): PostWriteReplayResult {
  return notApplicable(proposal, reason);
}

export function notRunPostWriteReplay(
  proposal: StructuredRatchetProposal,
  reason: string,
): PostWriteReplayResult {
  return {
    status: "not-run",
    proposalId: proposal.id,
    applicable: isPostWriteReplayApplicable(proposal),
    reason,
    warnings: [],
  };
}

function notApplicable(
  proposal: StructuredRatchetProposal,
  reason: string,
): PostWriteReplayResult {
  return {
    status: "not-applicable",
    proposalId: proposal.id,
    applicable: false,
    reason,
    warnings: [],
  };
}

function notApplicableReason(proposal: StructuredRatchetProposal): string {
  if (
    proposal.applicationMode === "design-input-only" ||
    proposal.target.kind === "design-input"
  ) {
    return "design-input-only proposals do not write config and have no post-write replay";
  }
  if (proposal.kind === "reviewer-config") {
    return "reviewer config changes are not deterministic policy replay deltas";
  }
  return "proposal kind is not applicable to post-write replay";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
