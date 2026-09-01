import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { Subagent } from "#src/lifecycle/subagent";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import type { AgentDetails } from "#src/ui/display";
import { describeActivity, formatMs, formatModelThinking } from "#src/ui/display";

const MAX_RESULT_OUTPUT = 12_000;

export interface GetResultToolManager { getRecord(id: string): Subagent | undefined; }

export class GetResultTool {
  constructor(private readonly manager: GetResultToolManager, private readonly registry: AgentConfigLookup) {}

  async execute(_toolCallId: string, params: { agent_id: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) {
    const record = this.manager.getRecord(params.agent_id);
    if (!record) return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
    if (!record.isActive()) record.markConsumed();

    const activity = describeActivity(record.activeTools, record.responseText);
    const text = record.isActive()
      ? `Agent ${record.id} is ${record.status}.\nRun ID: ${record.runId}\nMode: ${record.mode}\nModel: ${formatModelThinking(record.modelLabel, record.effectiveThinkingLevel)}\nRuntime: ${formatMs(record.activeRuntimeMs)} (running)\nActivity: ${activity}`
      : renderTerminalResult(record);
    const details: AgentDetails = {
      displayName: this.registry.resolveAgentConfig(record.type).displayName ?? record.type,
      description: record.description,
      subagentType: record.type,
      toolUses: record.toolUses,
      tokens: formatLifetimeTokens(record),
      durationMs: record.activeRuntimeMs,
      status: record.status,
      terminalReason: record.stateTerminalReason,
      modelName: record.modelLabel,
      thinkingLevel: record.effectiveThinkingLevel,
      turnCount: record.turnCount,
      maxTurns: record.maxTurns,
      activity,
      agentId: record.id,
      error: record.error,
    };
    return textResult(text, details);
  }

  toToolDefinition() {
    return defineTool({
      name: "get_subagent_result" as const,
      label: "Get Subagent Result",
      promptSnippet: "get_subagent_result: Read a bounded subagent result without waiting.",
      description: "Read a subagent's current status or bounded terminal result. This tool never waits and never dumps the full conversation. Use the transcript path when output is truncated.",
      parameters: Type.Object({ agent_id: Type.String({ description: "The subagent ID to inspect." }) }),
      execute: (toolCallId: string, params: { agent_id: string }, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => this.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
}

function renderTerminalResult(record: Subagent): string {
  const output = record.result?.trim() || "No output.";
  const bounded = output.length > MAX_RESULT_OUTPUT ? output.slice(0, MAX_RESULT_OUTPUT) + `\n\nOutput truncated. Full transcript: ${record.outputFile ?? "unavailable"}` : output;
  return `Agent ${record.id} ${record.status}.\nRun ID: ${record.runId}\nMode: ${record.mode}\nModel: ${formatModelThinking(record.modelLabel, record.effectiveThinkingLevel)}\nRuntime: ${formatMs(record.activeRuntimeMs)}\nReason: ${record.stateTerminalReason ?? "unknown"}\n\n${record.status === "error" ? `Error: ${record.error}\n\n` : ""}${bounded}`;
}
