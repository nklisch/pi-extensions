import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { GetResultTool, type GetResultToolManager } from "#src/tools/get-result-tool";
import type { Subagent } from "#src/types";
import { createTestSubagent, makeStubExecution } from "#test/helpers/make-subagent";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_CTX } from "#test/helpers/stub-ctx";

const testRegistry = new AgentTypeRegistry(() => new Map());

function makeManager(records: Map<string, Subagent> = new Map()): GetResultToolManager {
	return { getRecord: (id: string) => records.get(id) };
}

async function execute(
	manager: GetResultToolManager,
	params: { agent_id: string; wait?: boolean; verbose?: boolean },
	signal = new AbortController().signal,
) {
	const tool = new GetResultTool(manager, testRegistry);
	return tool.execute("tc-1", params, signal, undefined, STUB_CTX);
}

describe("GetResultTool", () => {
	it("returns tool definition with correct name", () => {
		expect(new GetResultTool(makeManager(), testRegistry).toToolDefinition().name).toBe("get_subagent_result");
	});

	it("includes promptSnippet", () => {
		expect(new GetResultTool(makeManager(), testRegistry).toToolDefinition().promptSnippet).toBe(
			"get_subagent_result: Inspect status or retrieve full results from a background agent.",
		);
	});

	it("tells agents that completion wakes them and polling is exceptional", () => {
		const description = new GetResultTool(makeManager(), testRegistry).toToolDefinition().description;
		expect(description).toContain("automatically wakes you");
		expect(description).toContain("do not poll");
		expect(description).toContain("full output");
		expect(description).toContain("verbose conversation");
		expect(description).toContain("synchronization point");
		expect(description).toContain("recovery");
	});

	it("returns not-found message for unknown agent ID", async () => {
		const result = await execute(makeManager(), { agent_id: "unknown" });
		expect(result.content[0].text).toContain("Agent not found");
	});

	it("returns status and result for completed agent and consumes it", async () => {
		const record = createTestSubagent();
		const result = await execute(makeManager(new Map([["agent-1", record]])), { agent_id: "agent-1" });
		expect(result.content[0].text).toContain("Agent: agent-1");
		expect(result.content[0].text).toContain("completed");
		expect(result.content[0].text).toContain("All done.");
		expect(record.consumed).toBe(true);
	});

	it("does not consume an in-progress agent", async () => {
		const record = createTestSubagent({ status: "running", completedAt: undefined });
		const result = await execute(makeManager(new Map([["agent-1", record]])), { agent_id: "agent-1" });
		expect(result.content[0].text).toContain("still running");
		expect(record.consumed).toBe(false);
	});

	it("shows an error and partial output for failed agents", async () => {
		const record = createTestSubagent({ status: "error", error: "timeout", result: "partial" });
		const result = await execute(makeManager(new Map([["agent-1", record]])), { agent_id: "agent-1" });
		expect(result.content[0].text).toContain("Error: timeout");
		expect(result.content[0].text).toContain("Partial output");
	});

	it("waits for the current run and then consumes it", async () => {
		const sessionStub = createSubagentSessionStub();
		sessionStub.runTurnLoop.mockResolvedValue({ responseText: "Finished after wait.", aborted: false, steered: false });
		const record = createTestSubagent({
			status: "running",
			completedAt: undefined,
			execution: makeStubExecution({ createSubagentSession: async () => toSubagentSession(sessionStub) }),
		});
		record.start();
		const result = await execute(makeManager(new Map([["agent-1", record]])), { agent_id: "agent-1", wait: true });
		expect(result.content[0].text).toContain("Finished after wait.");
		expect(record.consumed).toBe(true);
	});

	it("interrupts only the wait while leaving the agent active", async () => {
		const record = createTestSubagent({ status: "running", completedAt: undefined });
		const never = new Promise<void>(() => {});
		Object.defineProperty(record, "promise", { get: () => never });
		const controller = new AbortController();
		const resultPromise = execute(
			makeManager(new Map([["agent-1", record]])),
			{ agent_id: "agent-1", wait: true },
			controller.signal,
		);
		controller.abort();
		const result = await resultPromise;
		expect(result.content[0].text).toContain("still running");
		expect(record.status).toBe("running");
	});

	it("includes conversation and transcript pointer when verbose=true", async () => {
		const record = createTestSubagent();
		const stub = createSubagentSessionStub();
		stub.getConversation.mockReturnValue("[User]: hello");
		record.subagentSession = toSubagentSession(stub);
		const result = await execute(makeManager(new Map([["agent-1", record]])), { agent_id: "agent-1", verbose: true });
		expect(result.content[0].text).toContain("--- Agent Conversation ---");
		expect(result.content[0].text).toContain("[User]: hello");
	});
});
