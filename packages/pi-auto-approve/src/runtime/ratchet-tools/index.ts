import {
  RATCHET_TOOL_PREFIX,
  type RatchetModeManager,
} from "../ratchet-mode.ts";
import { createAutoReviewerAdversarialCasesTool } from "./adversarial.ts";
import type { RatchetBatchCache } from "./batch-cache.ts";
import { createAutoReviewerListHistoryFamiliesTool } from "./history.ts";
import { RATCHET_TOOL_IDS } from "./ids.ts";
import { createAutoReviewerListPacksTool } from "./packs.ts";
import {
  createAutoReviewerGenerateProposalsTool,
  createAutoReviewerShowProposalTool,
} from "./proposals.ts";
import { createAutoReviewerReplayProposalTool } from "./replay.ts";
import { createAutoReviewerStatusTool } from "./status.ts";
import type { RatchetToolDependencies } from "./types.ts";
import { createAutoReviewerValidatePackTool } from "./validation.ts";

export { RATCHET_TOOL_IDS } from "./ids.ts";

export function registerRatchetAnalysisTools(
  manager: RatchetModeManager,
  deps: RatchetToolDependencies,
  batchCache: RatchetBatchCache,
): void {
  assertRatchetToolIdsUsePrefix();

  manager.registerRatchetTool(createAutoReviewerStatusTool(deps, manager));
  manager.registerRatchetTool(createAutoReviewerListPacksTool(deps));
  manager.registerRatchetTool(createAutoReviewerListHistoryFamiliesTool(deps));

  const sharedBatchCache = batchCache;
  manager.registerRatchetTool(
    createAutoReviewerGenerateProposalsTool(deps, sharedBatchCache),
  );
  manager.registerRatchetTool(
    createAutoReviewerShowProposalTool(sharedBatchCache),
  );
  manager.registerRatchetTool(
    createAutoReviewerReplayProposalTool(deps, sharedBatchCache),
  );
  manager.registerRatchetTool(
    createAutoReviewerValidatePackTool(deps, sharedBatchCache),
  );
  manager.registerRatchetTool(
    createAutoReviewerAdversarialCasesTool(deps, sharedBatchCache),
  );
}

function assertRatchetToolIdsUsePrefix(): void {
  for (const id of Object.values(RATCHET_TOOL_IDS)) {
    if (!id.startsWith(RATCHET_TOOL_PREFIX)) {
      throw new Error(
        `Ratchet tool id ${JSON.stringify(id)} must start with ${RATCHET_TOOL_PREFIX}`,
      );
    }
  }
}
