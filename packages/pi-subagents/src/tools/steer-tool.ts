import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ManagerSteerOutcome } from "#src/lifecycle/subagent-manager";
import { textResult } from "#src/tools/helpers";

export interface SteerToolManager { steer(id: string, message: string): Promise<ManagerSteerOutcome>; }
export interface SteerToolEvents { emit(name: string, data: unknown): void; }

export class SteerTool {
  constructor(private readonly manager: SteerToolManager, private readonly events: SteerToolEvents) {}

  async execute(_toolCallId: string, params: { agent_id: string; message: string }, _signal: AbortSignal, _onUpdate: unknown, _ctx: unknown) {
    const outcome = await this.manager.steer(params.agent_id, params.message);
    if (outcome.kind === "not_found") return textResult(`Agent not found: "${outcome.agentId}". It may have been cleaned up.`, outcome);
    if (outcome.kind === "rejected") return textResult(`Agent "${params.agent_id}" cannot be steered (status: ${outcome.status}).`, { ...outcome, agentId: params.agent_id });
    this.events.emit("subagents:steered", { id: params.agent_id, runId: outcome.runId, outcome: outcome.kind, message: params.message });
    return textResult(`Steering message ${outcome.kind} for agent ${params.agent_id}.\nRun ID: ${outcome.runId}.`, { ...outcome, agentId: params.agent_id });
  }

  toToolDefinition() {
    return defineTool({
      name: "steer_subagent" as const,
      label: "Steer Subagent",
      promptSnippet: "steer_subagent: Send a message to a running subagent.",
      description: "Send a steering message to a running subagent. The structured outcome distinguishes delivered, buffered, rejected, and not-found cases.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "The running subagent ID." }),
        message: Type.String({ description: "The message to add to the subagent's conversation." }),
      }),
      execute: (toolCallId: string, params: { agent_id: string; message: string }, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => this.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
}
