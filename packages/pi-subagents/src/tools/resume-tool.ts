import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SubagentMode } from "#src/types";
import type { ResumeOutcome } from "#src/lifecycle/subagent-manager";
import type { Subagent } from "#src/lifecycle/subagent";
import { buildDetails, formatLifetimeTokens, textResult } from "#src/tools/helpers";
import { formatModelThinking, formatMs } from "#src/ui/display";

export interface ResumeToolManager {
  resume(id: string, prompt: string, mode: SubagentMode, timeoutSeconds: number | undefined, signal?: AbortSignal, onReserved?: (record: Subagent) => void): Promise<ResumeOutcome>;
  getRecord(id: string): Subagent | undefined;
}

export class ResumeTool {
  constructor(private readonly manager: ResumeToolManager) {}

  async execute(_toolCallId: string, params: { agent_id: string; prompt: string; mode?: SubagentMode; timeout_seconds?: number }, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, _ctx: unknown) {
    if (params.timeout_seconds != null && (!Number.isInteger(params.timeout_seconds) || params.timeout_seconds <= 0)) {
      return textResult("timeout_seconds must be a positive integer");
    }
    const mode = params.mode ?? "detached";
    let spinnerFrame = 0;
    const timer = setInterval(() => {
      if (!onUpdate || mode !== "joined") return;
      const record = this.manager.getRecord(params.agent_id);
      if (!record) return;
      onUpdate({ content: [{ type: "text", text: `${record.toolUses} tool uses...` }], details: buildDetails({
        displayName: record.type, description: record.description, subagentType: record.type,
        modelName: record.modelLabel, thinkingLevel: record.effectiveThinkingLevel, tags: [`mode: ${record.mode}`],
      }, record, {
        status: record.status,
        terminalReason: record.stateTerminalReason,
        durationMs: record.activeRuntimeMs,
        spinnerFrame: spinnerFrame++,
      }) });
    }, 500);
    let outcome: ResumeOutcome;
    try {
      outcome = await this.manager.resume(params.agent_id, params.prompt, mode, params.timeout_seconds, signal, (record) => {
        if (onUpdate && mode === "joined") onUpdate({ content: [{ type: "text", text: "Resuming..." }], details: buildDetails({
          displayName: record.type, description: record.description, subagentType: record.type,
          modelName: record.modelLabel, thinkingLevel: record.effectiveThinkingLevel, tags: [`mode: ${record.mode}`],
        }, record, {
          status: record.status,
          terminalReason: record.stateTerminalReason,
          durationMs: record.activeRuntimeMs,
        }) });
      });
    } finally {
      clearInterval(timer);
    }
    if (outcome.kind === "not_found") return textResult(`Agent not found: "${outcome.agentId}". It may have been cleaned up.`);
    if (outcome.kind === "wrong_state") return textResult(`Agent "${outcome.agentId}" cannot be resumed (status: ${outcome.status}). It must have a retained settled session.`);

    const record = outcome.kind === "joined" ? outcome.record : this.manager.getRecord(outcome.agentId);
    if (!record) return textResult(`Agent not found after resume: "${params.agent_id}".`);
    if (outcome.kind === "detached") {
      return textResult(`Resume detached for agent ${record.id}.\nRun ID: ${record.runId}\nMode: detached\nCompletion will send one notification.`, buildDetails({
        displayName: record.type,
        description: record.description,
        subagentType: record.type,
        modelName: record.modelLabel,
        thinkingLevel: record.effectiveThinkingLevel,
        tags: [`mode: ${record.mode}`],
      }, record, {
        status: record.status,
        terminalReason: record.stateTerminalReason,
        durationMs: record.activeRuntimeMs,
      }));
    }
    record.markConsumed();
    return textResult(`Agent ${record.id} ${record.status}.\nRun ID: ${record.runId}\nModel: ${formatModelThinking(record.modelLabel, record.effectiveThinkingLevel)}\nRuntime: ${formatMs(record.activeRuntimeMs)}\nReason: ${record.stateTerminalReason ?? "unknown"}\n\n${boundResult(record.result, record.outputFile)}`, buildDetails({
      displayName: record.type,
      description: record.description,
      subagentType: record.type,
      modelName: record.modelLabel,
      thinkingLevel: record.effectiveThinkingLevel,
      tags: [`mode: ${record.mode}`],
    }, record, { tokens: formatLifetimeTokens(record), durationMs: record.activeRuntimeMs, terminalReason: record.stateTerminalReason }));
  }

  toToolDefinition() {
    return defineTool({
      name: "resume_subagent" as const,
      label: "Resume Subagent",
      promptSnippet: "resume_subagent: Continue a retained subagent session.",
      description: "Continue a retained settled subagent session. Delivery defaults to detached; joined waits for the resumed run to settle.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "The retained subagent ID to resume." }),
        prompt: Type.String({ description: "The next task or instruction." }),
        mode: Type.Optional(Type.Union([Type.Literal("joined"), Type.Literal("detached")], { description: "Result delivery mode. Defaults to detached." })),
        timeout_seconds: Type.Optional(Type.Integer({ description: "Active runtime deadline in seconds; queued time is excluded.", minimum: 1 })),
      }),
      execute: (toolCallId: string, params: { agent_id: string; prompt: string; mode?: SubagentMode; timeout_seconds?: number }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => this.execute(toolCallId, params, signal, onUpdate as ((update: unknown) => void) | undefined, ctx),
    });
  }
}

const MAX_RESULT_OUTPUT = 12_000;
function boundResult(result: string | undefined, outputFile: string | undefined): string {
  const output = result?.trim() || "No output.";
  return output.length > MAX_RESULT_OUTPUT
    ? output.slice(0, MAX_RESULT_OUTPUT) + `\n\nOutput truncated. Full transcript: ${outputFile ?? "unavailable"}`
    : output;
}
