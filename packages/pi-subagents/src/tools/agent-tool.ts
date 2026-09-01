/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions -- Pi SDK render types are intentionally narrow at this boundary */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { THINKING_LEVELS_DESCRIPTION } from "#src/config/thinking-levels";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { AgentSpawnConfig, DeliveryOutcome } from "#src/lifecycle/subagent-manager";
import type { Subagent } from "#src/lifecycle/subagent";
import { buildAgentGuidelines, buildDetails, buildTypeListText, formatLifetimeTokens, textResult } from "#src/tools/helpers";
import { renderAgentResult } from "#src/tools/result-renderer";
import { type ModelInfo, resolveSpawnConfig } from "#src/tools/spawn-config";
import type { ParentSessionInfo } from "#src/types";
import { describeActivity, type AgentDetails, formatModelThinking, formatMs, getDisplayName } from "#src/ui/display";

export interface AgentToolManager {
  launch(snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig): Promise<DeliveryOutcome>;
  getRecord(id: string): Subagent | undefined;
}

export interface AgentToolRuntime {
  buildSnapshot(inheritContext: boolean): ParentSnapshot;
  getModelInfo(): ModelInfo;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

export type AgentToolSettings = {
  readonly defaultMaxTurns: number | undefined;
  readonly fallbackSubagent?: string | false;
};

export class AgentTool {
  private readonly typeListText: string;
  private readonly availableTypesText: string;
  private readonly agentGuidelines: string[];

  constructor(
    private readonly manager: AgentToolManager,
    private readonly runtime: AgentToolRuntime,
    private readonly settings: AgentToolSettings,
    private readonly registry: AgentTypeRegistry,
    private readonly agentDir: string,
  ) {
    this.typeListText = buildTypeListText(registry, agentDir);
    this.availableTypesText = registry.getAvailableTypes().join(", ");
    this.agentGuidelines = buildAgentGuidelines(registry);
  }

  async execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: AgentToolResult<any>) => void) | undefined,
    _ctx: any,
  ) {
    this.registry.reload();
    const config = resolveSpawnConfig(params, this.registry, this.runtime.getModelInfo(), this.settings);
    if ("error" in config) return textResult(config.error);

    const snapshot = this.runtime.buildSnapshot(config.execution.inheritContext);
    const sessionInfo = this.runtime.getSessionInfo();
    const parentSession: ParentSessionInfo = { ...sessionInfo, toolCallId };
    let currentId: string | undefined;
    let spinnerFrame = 0;
    const update = (): void => {
      const record = currentId ? this.manager.getRecord(currentId) : undefined;
      if (!record || !onUpdate || config.execution.mode !== "joined") return;
      const details = buildDetails(config.presentation.detailBase, record, {
        durationMs: record.activeRuntimeMs,
        status: record.status,
        terminalReason: record.stateTerminalReason,
        tokens: formatLifetimeTokens(record),
        activity: record.stateTerminalReason ? undefined : describeActivity(record.activeTools, record.responseText),
        spinnerFrame: spinnerFrame++,
      });
      onUpdate({ content: [{ type: "text", text: `${record.toolUses} tool uses...` }], details: details as any });
    };
    const timer = setInterval(update, 500);

    let outcome: DeliveryOutcome;
    try {
      outcome = await this.manager.launch(snapshot, config.identity.subagentType, config.execution.prompt, {
        description: config.execution.description,
        model: config.execution.model,
        maxTurns: config.execution.effectiveMaxTurns,
        inheritContext: config.execution.inheritContext,
        thinkingLevel: config.execution.effectiveThinkingLevel,
        mode: config.execution.mode,
        timeoutSeconds: config.execution.timeoutSeconds,
        origin: "tool",
        invocation: config.execution.agentInvocation,
        parentSession,
        signal,
        onCreated: (record) => { currentId = record.id; update(); },
      });
      currentId = outcome.kind === "joined" ? outcome.record.id : outcome.agentId;
      update();
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(timer);
    }

    const record = this.manager.getRecord(currentId!);
    if (!record) return textResult(`Agent not found after launch: "${currentId}".`);
    if (outcome.kind === "detached") {
      return textResult(
        `Agent detached and ${record.status === "queued" ? "queued" : "started"}.\n` +
        `Agent ID: ${record.id}\nRun ID: ${record.runId}\nType: ${config.identity.displayName}\n` +
        `Mode: detached\nModel: ${formatModelThinking(record.modelLabel, record.effectiveThinkingLevel)}\n` +
        `Description: ${record.description}\n` +
        (record.status === "queued" ? "Admission: queued\n" : "") +
        "Completion will send one notification. Use get_subagent_result for the bounded final result.",
        buildDetails(config.presentation.detailBase, record, {
          status: record.status,
          terminalReason: record.stateTerminalReason,
          durationMs: record.activeRuntimeMs,
        }),
      );
    }

    record.markConsumed();
    const details = buildDetails(config.presentation.detailBase, record, {
      status: record.status,
      terminalReason: record.stateTerminalReason,
      tokens: formatLifetimeTokens(record),
      durationMs: record.activeRuntimeMs,
    });
    const fallback = config.identity.fellBack ? `Unknown agent type "${config.identity.rawType}" — using ${config.identity.subagentType}.\n\n` : "";
    const boundedResult = boundResult(record.result, record.outputFile);
    if (record.status === "error") {
      return textResult(`${fallback}Model: ${formatModelThinking(record.modelLabel, record.effectiveThinkingLevel)}\nRuntime: ${formatMs(record.activeRuntimeMs)}\nAgent failed: ${record.error}${boundedResult ? `\n\nPartial output:\n${boundedResult}` : ""}`, details);
    }
    return textResult(`${fallback}Model: ${formatModelThinking(record.modelLabel, record.effectiveThinkingLevel)}\nRuntime: ${formatMs(record.activeRuntimeMs)}\nAgent ${record.status}${record.stateTerminalReason ? ` (${record.stateTerminalReason.replaceAll("_", " ")})` : ""}.\n\n${boundedResult}`, details);
  }

  toToolDefinition() {
    const typeListText = this.typeListText;
    const availableTypesText = this.availableTypesText;
    const agentDir = this.agentDir;
    const registry = this.registry;
    const guidelines = [
      "- Use mode: joined when the parent needs the result in this turn; use mode: detached for independent work (default).",
      ...this.agentGuidelines,
      "- Provide clear, detailed prompts so the agent can work autonomously.",
      "- Detached completion automatically wakes you with one bounded result preview; do not poll.",
      "- Use resume_subagent to continue a retained session and stop_subagent to request cooperative cancellation.",
      '- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").',
      "- Use thinking to control extended thinking level.",
      "- Use inherit_context if the agent needs the parent conversation history.",
    ].join("\n");

    return defineTool({
      name: "subagent" as const,
      label: "Subagent",
      promptSnippet: "subagent: Launch a specialized agent for complex, multi-step tasks.",
      description: `Launch one specialized agent. Delivery defaults to detached; choose joined when this parent turn must receive the settled result.\n\nAvailable agent types:\n${typeListText}\n\nGuidelines:\n${guidelines}\n`,
      parameters: Type.Object({
        prompt: Type.String({ description: "The task for the agent to perform." }),
        description: Type.String({ description: "A short (3-5 word) description of the task." }),
        subagent_type: Type.String({ description: `The specialized agent type. Available types: ${availableTypesText}. Custom agents from .pi/agents/<name>.md or ${agentDir}/agents/<name>.md are also available.` }),
        model: Type.Optional(Type.String({ description: 'Optional model override: "provider/modelId" or fuzzy name.' })),
        thinking: Type.Optional(Type.String({ description: `Thinking level: ${THINKING_LEVELS_DESCRIPTION}.` })),
        max_turns: Type.Optional(Type.Integer({ description: "Maximum agentic turns. Use 0 or omit for unlimited.", minimum: 0 })),
        timeout_seconds: Type.Optional(Type.Integer({ description: "Active runtime deadline in seconds; queued time is excluded.", minimum: 1 })),
        mode: Type.Optional(Type.Union([Type.Literal("joined"), Type.Literal("detached")], { description: "Result delivery mode. Defaults to detached." })),
        inherit_context: Type.Optional(Type.Boolean({ description: "Fork parent conversation into the agent. Default: false." })),
      }),
      renderCall(args: Record<string, unknown>, theme: any) {
        const displayName = args.subagent_type ? getDisplayName(args.subagent_type as string, registry) : "Subagent";
        const desc = (args.description as string | undefined) ?? "";
        return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
      },
      renderResult(result: any, { expanded, isPartial }: any, theme: any) {
        const details = result.details as AgentDetails | undefined;
        if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(renderAgentResult(details, text, expanded, isPartial, theme), 0, 0);
      },
      execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((update: AgentToolResult<any>) => void) | undefined, ctx: any) => this.execute(toolCallId, params, signal, onUpdate, ctx),
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
