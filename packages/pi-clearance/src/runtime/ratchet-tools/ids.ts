export const RATCHET_TOOL_IDS = {
  status: "clearance_status",
  listPacks: "clearance_list_packs",
  listHistoryFamilies: "clearance_list_history_families",
  generateProposals: "clearance_generate_proposals",
  showProposal: "clearance_show_proposal",
  replayProposal: "clearance_replay_proposal",
  validatePack: "clearance_validate_pack",
  adversarialCases: "clearance_adversarial_cases",
} as const;

export type RatchetToolId =
  (typeof RATCHET_TOOL_IDS)[keyof typeof RATCHET_TOOL_IDS];
