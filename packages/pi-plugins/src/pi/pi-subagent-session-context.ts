import type { PiSessionBindingPort } from "../composition/packaged-plugin-host-contract.js";
import type { PiProjectContextAdapters } from "./pi-project-context.js";
import { HookSessionEvidenceSchema } from "../runtime/hooks/event-contract.js";
import type { SubagentHookSessionContextPort } from "../runtime/subagents/subagent-hook-session-context.js";

/** Resolve only the exact current Plugin Host parent session. */
export function createPiSubagentSessionContext(input: Readonly<{
  binding: PiSessionBindingPort;
  project: PiProjectContextAdapters;
}>): SubagentHookSessionContextPort {
  return Object.freeze({
    async resolve(parentSessionId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      const binding = input.binding.current();
      if (parentSessionId !== binding.sessionId) return undefined;
      return HookSessionEvidenceSchema.parse({
        sessionId: binding.sessionId,
        ...(binding.sessionFile === undefined ? {} : { transcriptPath: binding.sessionFile }),
        cwd: binding.cwd,
        currentProject: input.project.current(),
        piProjectTrusted: input.binding.isProjectTrusted(),
      });
    },
  });
}
