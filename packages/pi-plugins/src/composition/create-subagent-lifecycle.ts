import type { SubagentLifecyclePort } from "../application/ports/subagent-lifecycle.js";
import { createPublishedPiSubagentsLifecyclePort } from "../runtime/subagents/pi-subagents-lifecycle.js";

/**
 * Select the only supported production lifecycle adapter. Package identity and
 * its documented root-export access remain inside the concrete adapter.
 */
export async function createPublishedSubagentLifecyclePort(): Promise<
  SubagentLifecyclePort | undefined
> {
  return createPublishedPiSubagentsLifecyclePort();
}
