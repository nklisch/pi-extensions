export const PROPOSAL_TOOL_IDS = {
  propose: "clearance_propose",
  present: "clearance_present",
} as const;

export type ProposalToolId =
  (typeof PROPOSAL_TOOL_IDS)[keyof typeof PROPOSAL_TOOL_IDS];
