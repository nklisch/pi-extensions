import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";

import type { RatchetModeManager } from "./ratchet-mode.ts";

const PROPOSAL_FLOW_GUIDANCE = [
  "## Clearance proposal flow guidance",
  "- Agent-authored policy batches are always available: call clearance_propose, then call clearance_present to show the deterministic summary card.",
  "- Only an explicit user approval from the presented card may write user-owned config; never apply proposals or write policy directly.",
].join("\n");

function formatRatchetToolGuidance(toolNames: readonly string[]): string {
  if (toolNames.length === 0) {
    return "- No ratchet tools are registered yet.";
  }

  return `- Registered ratchet tools: ${toolNames.join(", ")}.`;
}

function buildRatchetModeGuidance(manager: RatchetModeManager): string {
  const { ratchetToolNames } = manager.getStatus();

  return [
    "## Ratchet mode guidance",
    "- Ratchet mode is active; ratchet-only analysis tools are temporarily available.",
    formatRatchetToolGuidance(ratchetToolNames),
    "- Prefer structured corpus, replay, and proposal tools over reading raw logs directly.",
    "- Replay candidate changes across the full corpus before recommending them.",
    "- Read docs/PACK_AUTHORING.md before authoring custom packs.",
    "- Proposal writes require explicit Pi UI approval; do not write config or policy files directly as a substitute for proposal approval.",
  ].join("\n");
}

export function createRatchetModePromptInjector(
  manager: RatchetModeManager,
): ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> {
  return (event) => ({
    systemPrompt: [
      event.systemPrompt,
      ...(manager.isRatchetActive() ? [buildRatchetModeGuidance(manager)] : []),
      PROPOSAL_FLOW_GUIDANCE,
    ].join("\n\n"),
  });
}
