import type { HookSessionEvidence } from "../hooks/event-contract.js";

/**
 * Resolves an already-existing Plugin Host parent session. The coordinator does
 * not create sessions or infer ownership from child/package records.
 */
export interface SubagentHookSessionContextPort {
  resolve(
    parentSessionId: string,
    signal: AbortSignal,
  ): Promise<HookSessionEvidence | undefined>;
}
