import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { toSubagentRecord } from "#src/service/service-adapter";
import { textResult } from "#src/tools/helpers";

export interface ListToolManager {
  listAgents(): import("#src/lifecycle/subagent").Subagent[];
}

export class ListTool {
  constructor(private readonly manager: ListToolManager) {}

  async execute(_toolCallId: string, params: { state?: "active" | "terminal" | "all"; limit?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) {
    const state = params.state ?? "all";
    const limit = params.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return textResult("limit must be an integer from 1 to 100");
    const records = this.manager.listAgents()
      .filter((record) => state === "all" || (state === "active" ? record.isActive() : !record.isActive()))
      .slice(0, limit)
      .map(toSubagentRecord);
    const lines = records.length === 0
      ? ["No subagents match the requested state."]
      : records.map((record) => [
        `${record.id} run=${record.runId} ${record.mode} ${record.status}${record.stopRequested ? " stop_requested" : ""}`,
        `  ${record.modelLabel} · thinking: ${record.thinkingLevel} · ${record.activeRuntimeMs}ms${record.status === "queued" || record.status === "running" ? ` · ${record.currentActivity.slice(0, 160)}` : ""}`,
        record.terminalReason ? `  reason=${record.terminalReason}` : undefined,
        record.activeTools.length > 0 ? `  tools=${record.activeTools.join(",")}` : undefined,
        `  ${record.description}`,
      ].filter((line): line is string => line !== undefined).join("\n"));
    return textResult(lines.join("\n"), records);
  }

  toToolDefinition() {
    return defineTool({
      name: "list_subagents" as const,
      label: "List Subagents",
      promptSnippet: "list_subagents: Inspect bounded subagent fleet state.",
      description: "List a bounded newest-first summary of active, terminal, or all subagents, including run identity, delivery mode, exact model/thinking, active runtime, live activity, tools, and terminal reason.",
      parameters: Type.Object({
        state: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("terminal"), Type.Literal("all")], { description: "Which records to include. Defaults to all." })),
        limit: Type.Optional(Type.Integer({ description: "Maximum records, 1-100, default 20.", minimum: 1, maximum: 100 })),
      }),
      execute: (toolCallId: string, params: { state?: "active" | "terminal" | "all"; limit?: number }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => this.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
}
