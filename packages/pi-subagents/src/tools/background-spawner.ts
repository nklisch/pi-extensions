import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { AgentSpawnConfig } from "#src/lifecycle/subagent-manager";
import { textResult } from "#src/tools/helpers";
import { formatModelThinking } from "#src/ui/display";
import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";
import type { ParentSessionInfo, Subagent } from "#src/types";

/** Narrow manager interface for the background spawner. */
export interface BackgroundManagerDeps {
  spawn(snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig): string;
  getRecord(id: string): Subagent | undefined;
}

/** All values the background spawner needs beyond the resolved config. */
export interface BackgroundParams {
  config: ResolvedSpawnConfig;
  snapshot: ParentSnapshot;
  parentSession: ParentSessionInfo;
  settings: { readonly maxConcurrent: number };
}

/**
 * Spawn a background agent and return the tool result immediately.
 * Owns: launch message formatting.
 */
export function spawnBackground(
  manager: BackgroundManagerDeps,
  params: BackgroundParams,
) {
  const { identity, execution, presentation } = params.config;

  let id: string;
  try {
    id = manager.spawn(params.snapshot, identity.subagentType, execution.prompt, {
      parentSession: params.parentSession,
      description: execution.description,
      model: execution.model,
      maxTurns: execution.effectiveMaxTurns,
      inheritContext: execution.inheritContext,
      thinkingLevel: execution.effectiveThinkingLevel,
      isBackground: true,
      origin: "tool",
      invocation: execution.agentInvocation,
    });
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err));
  }

  const record = manager.getRecord(id);

  const isQueued = record?.status === "queued";
  return textResult(
    `Agent ${isQueued ? "queued" : "started"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${identity.displayName}\n` +
      `Model: ${formatModelThinking(
        record?.modelLabel ?? presentation.modelName,
        record?.effectiveThinkingLevel ?? execution.effectiveThinkingLevel,
      )}\n` +
      `Runtime: 0.0s\n` +
      `Description: ${execution.description}\n` +
      (identity.fellBack ? `Fallback: requested ${identity.rawType}; using ${identity.subagentType}\n` : "") +
      (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
      (isQueued
        ? `Position: queued (max ${params.settings.maxConcurrent} concurrent)\n`
        : "") +
      `\nCompletion will automatically notify and wake you with a result preview. Continue other work; do not poll.\n` +
      `Use steer_subagent to redirect this agent while it runs.\n` +
      `Use get_subagent_result only for full output, verbose conversation, an explicit status check or synchronization point, or recovery after a missed notification.\n` +
      `Do not duplicate this agent's work.`,
    {
      ...presentation.detailBase,
      thinkingLevel: record?.effectiveThinkingLevel ?? execution.effectiveThinkingLevel,
      toolUses: 0,
      tokens: "",
      durationMs: 0,
      status: "background" as const,
      agentId: id,
    },
  );
}
