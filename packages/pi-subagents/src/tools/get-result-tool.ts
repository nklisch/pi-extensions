import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { type AgentReport, formatAgentReport } from "#src/tools/get-result-report";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import type { Subagent } from "#src/types";
import { formatDuration, getDisplayName } from "#src/ui/display";

// ---- Deps interfaces ----

export interface GetResultToolManager {
	getRecord(id: string): Subagent | undefined;
}

// ---- Class ----

export class GetResultTool {
	constructor(
		private readonly manager: GetResultToolManager,
		private readonly registry: AgentConfigLookup,
	) {}

	async execute(
		_toolCallId: string,
		params: { agent_id: string; wait?: boolean; verbose?: boolean },
		signal: AbortSignal,
		_onUpdate: unknown,
		_ctx: unknown,
	) {
		const record = this.manager.getRecord(params.agent_id);
		if (!record) {
			return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
		}

		// A queued record is awaitable from spawn, and a resumed record republishes
		// its live promise. Interrupting this tool stops only the wait.
		if (params.wait) await record.waitUntilSettled(signal);

		// Pull delivery: only a terminal result was actually collected.
		if (!record.isActive()) record.markConsumed();

		return textResult(formatAgentReport(this.buildReport(record, params.verbose)));
	}

	private buildReport(record: Subagent, verbose?: boolean): AgentReport {
		return {
			id: record.id,
			displayName: getDisplayName(record.type, this.registry),
			modelLabel: record.modelLabel,
			status: record.status,
			toolUses: record.toolUses,
			tokens: formatLifetimeTokens(record),
			contextPercent: record.getContextPercent(),
			compactionCount: record.compactionCount,
			duration: formatDuration(record.startedAt, record.completedAt),
			description: record.description,
			result: record.result,
			error: record.error,
			stoppedWhileQueued: record.stoppedWhileQueued,
			conversation: verbose ? record.getConversation() : undefined,
			transcriptPath: record.outputFile,
		};
	}

	toToolDefinition() {
		return defineTool({
			name: "get_subagent_result" as const,
			label: "Get Agent Result",
			promptSnippet:
				"get_subagent_result: Inspect status or retrieve full results from a background agent.",
			description:
				"Background completion automatically wakes you with a result preview, so do not poll. " +
				"Use this tool only for full output, verbose conversation, an explicit status check or synchronization point, " +
				"or recovery after a missed notification.",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to check.",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description:
							"If true, wait for the agent to complete before returning. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),
			execute: (
				toolCallId: string,
				params: { agent_id: string; wait?: boolean; verbose?: boolean },
				signal: AbortSignal,
				onUpdate: unknown,
				ctx: unknown,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}
