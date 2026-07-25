import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RatchetBatchCache } from "../ratchet-tools/batch-cache.ts";
import type { RatchetToolDependencies } from "../ratchet-tools/types.ts";
import { createClearancePresentTool } from "./present.ts";
import { createClearanceProposeTool } from "./propose.ts";

/** Register the two proposal tools once at extension initialization. */
export function registerProposalTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  deps: RatchetToolDependencies,
  batchCache: RatchetBatchCache,
): void {
  const tools = [
    asPiToolDefinition(createClearanceProposeTool(deps, batchCache)),
    asPiToolDefinition(createClearancePresentTool(deps, batchCache)),
  ];
  for (const tool of tools) {
    // Registration alone makes the tools active and refreshed in-session;
    // reading or mutating the active set here would call runtime action
    // methods that pi forbids during extension loading.
    pi.registerTool(tool);
  }
}

function asPiToolDefinition(tool: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: unknown;
  readonly execute: ToolDefinition["execute"];
}): ToolDefinition {
  return tool as ToolDefinition;
}

export type { ProposalToolId } from "./ids.ts";
export { PROPOSAL_TOOL_IDS } from "./ids.ts";
export type {
  ClearancePresentDetails,
  ClearancePresentNotFoundDetails,
} from "./present.ts";
export { createClearancePresentTool } from "./present.ts";
export type { ClearanceProposeDetails } from "./propose.ts";
export { createClearanceProposeTool } from "./propose.ts";
