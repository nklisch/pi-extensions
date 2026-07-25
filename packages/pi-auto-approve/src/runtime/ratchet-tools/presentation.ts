// Apply-engine exports remain here for focused internal seams. The former
// per-proposal presentation tool is intentionally not exported or registered;
// all presentation goes through runtime/proposal-tools/present.ts.

export type {
  ProposalApplyDetails,
  ProposalApplyStatus,
  ProposalPresentationDecision,
  ProposalPresentationEngines,
} from "../proposal-tools/apply-engine.ts";
export {
  applyAcceptedWritableProposal,
  fillRequiredApprovalEvidence,
  resolveApprovalAndApply,
} from "../proposal-tools/apply-engine.ts";
