import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createRatchetProposalDecisionEntry,
  type RatchetProposalDecisionEntry,
} from "../../audit/entry.ts";
import type { StructuredRatchetProposal } from "../../replay/proposal-schema.ts";
import type { PostWriteReplayResult } from "./post-write-replay.ts";
import type { RatchetToolDependencies } from "./types.ts";

export interface RatchetProposalDecisionAuditResult {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly error?: string;
}

export async function recordRatchetProposalDecision(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly toolCallId?: string;
  readonly batchId: string;
  readonly proposal: StructuredRatchetProposal;
  readonly decision: RatchetProposalDecisionEntry["decision"];
  readonly write: RatchetProposalDecisionEntry["write"];
  readonly postWriteReplay: PostWriteReplayResult;
}): Promise<RatchetProposalDecisionAuditResult> {
  const entry = createRatchetProposalDecisionEntry({
    entryType: "ratchet.proposal-decision",
    projectPath: input.ctx.cwd,
    ...optionalSessionId(input.ctx),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    batchId: input.batchId,
    proposalId: input.proposal.id,
    proposalKind: input.proposal.kind,
    applicationMode: input.proposal.applicationMode,
    decision: input.decision,
    targetKind: input.proposal.target.kind,
    ...optionalTargetPath(input.proposal),
    write: input.write,
    postWriteReplay: postWriteReplayAuditDetails(input.postWriteReplay),
  });

  try {
    await input.deps.audit.log(entry);
    return { attempted: true, ok: true };
  } catch (error: unknown) {
    return { attempted: true, ok: false, error: errorMessage(error) };
  }
}

function postWriteReplayAuditDetails(
  replay: PostWriteReplayResult,
): NonNullable<RatchetProposalDecisionEntry["postWriteReplay"]> {
  return {
    status: replay.status,
    ...(replay.delta === undefined
      ? {}
      : { changedCalls: replay.delta.changedCalls }),
    ...(replay.delta === undefined
      ? {}
      : { regressionCount: regressionCallCount(replay.delta.regressions) }),
  };
}

function regressionCallCount(
  regressions: NonNullable<PostWriteReplayResult["delta"]>["regressions"],
): number {
  return regressions.reduce((total, regression) => total + regression.calls, 0);
}

function optionalTargetPath(proposal: StructuredRatchetProposal): {
  readonly targetPath?: string;
} {
  return "path" in proposal.target ? { targetPath: proposal.target.path } : {};
}

function optionalSessionId(ctx: ExtensionContext): {
  readonly sessionId?: string;
} {
  const maybeContext = ctx as ExtensionContext & {
    readonly sessionManager?: {
      readonly getSessionId?: () => string | undefined;
    };
  };

  try {
    const sessionId = maybeContext.sessionManager?.getSessionId?.();
    return sessionId === undefined ? {} : { sessionId };
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
