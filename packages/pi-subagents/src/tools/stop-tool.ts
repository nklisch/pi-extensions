import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { StopOutcome } from "#src/lifecycle/subagent-manager";
import type { Subagent } from "#src/lifecycle/subagent";
import { buildDetails, formatLifetimeTokens, textResult } from "#src/tools/helpers";
import { formatModelThinking, formatMs } from "#src/ui/display";

export interface StopToolManager {
  stop(id: string, settlementTimeoutSeconds?: number, waitSignal?: AbortSignal): Promise<StopOutcome>;
}

export class StopTool {
  constructor(private readonly manager: StopToolManager) {}

  async execute(_toolCallId: string, params: { agent_id: string; settlement_timeout_seconds?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) {
    const timeout = params.settlement_timeout_seconds ?? 5;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) return textResult("settlement_timeout_seconds must be an integer from 1 to 30");
    const outcome = await this.manager.stop(params.agent_id, timeout, signal);
    if (outcome.kind === "not_found") return textResult(`Agent not found: "${outcome.agentId}". It may have been cleaned up.`, { kind: outcome.kind, agentId: outcome.agentId });
    if (outcome.kind === "already_terminal") return textResult(`Agent ${outcome.agentId} is already terminal (${outcome.record.status}, ${outcome.record.stateTerminalReason ?? "unknown"}).`, renderDetails(outcome.record));
    if (outcome.kind === "stop_pending") return textResult(`Stop requested for agent ${outcome.agentId}, but its run has not settled within ${timeout}s. It remains active; no hard kill was attempted.\nRun ID: ${outcome.runId}\nReason: ${outcome.reason}`, renderDetails(outcome.record));
    return textResult(`Agent ${outcome.agentId} stopped.\nRun ID: ${outcome.runId}\nReason: ${outcome.reason}\nRuntime: ${formatMs(outcome.record.activeRuntimeMs)}`, renderDetails(outcome.record));
  }

  toToolDefinition() {
    return defineTool({
      name: "stop_subagent" as const,
      label: "Stop Subagent",
      promptSnippet: "stop_subagent: Request cooperative cancellation of a subagent.",
      description: "Stop queued work immediately or request cooperative cancellation of a live subagent. The result distinguishes settled, already-terminal, not-found, and stop-pending outcomes; it never hard-kills JavaScript.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "The subagent ID to stop." }),
        settlement_timeout_seconds: Type.Optional(Type.Integer({ description: "How long to wait for cooperative settlement (1-30 seconds, default 5).", minimum: 1, maximum: 30 })),
      }),
      execute: (toolCallId: string, params: { agent_id: string; settlement_timeout_seconds?: number }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => this.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
}

function renderDetails(record: Subagent) {
  return buildDetails({
    displayName: record.type,
    description: record.description,
    subagentType: record.type,
    modelName: record.modelLabel,
    thinkingLevel: record.effectiveThinkingLevel,
    tags: [`mode: ${record.mode}`],
  }, record, {
    terminalReason: record.stateTerminalReason,
    tokens: formatLifetimeTokens(record),
    durationMs: record.activeRuntimeMs,
  });
}
