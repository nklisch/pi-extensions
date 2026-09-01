import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { GetResultTool } from "#src/tools/get-result-tool";
import { ListTool } from "#src/tools/list-tool";
import { resolveSpawnConfig } from "#src/tools/spawn-config";
import { ResumeTool } from "#src/tools/resume-tool";
import { SteerTool } from "#src/tools/steer-tool";
import { StopTool } from "#src/tools/stop-tool";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { makeModel } from "#test/helpers/make-model";

const registry = new AgentTypeRegistry(() => new Map());
const signal = new AbortController().signal;
function text(result: any): string { return result.content[0].text; }

function getTool(record?: ReturnType<typeof createTestSubagent>) {
  return new GetResultTool({ getRecord: vi.fn(() => record) }, registry);
}

describe("retained get-result tool behavior", () => {
  it("declares the bounded result tool", () => {
    const definition = getTool().toToolDefinition();
    expect(definition.name).toBe("get_subagent_result");
    expect(definition.promptSnippet).toContain("bounded");
    expect(definition.description).toContain("never dumps the full conversation");
  });

  it("reports an unknown agent without throwing", async () => {
    const result = await getTool().execute("call", { agent_id: "missing" }, signal, undefined, undefined);
    expect(text(result)).toContain('Agent not found: "missing"');
  });

  it("returns a running status and does not consume the record", async () => {
    const record = createTestSubagent({ status: "running", result: undefined, completedAt: undefined, activeTools: ["read"] });
    const result = await getTool(record).execute("call", { agent_id: record.id }, signal, undefined, undefined);
    expect(text(result)).toContain("is running");
    expect(text(result)).toContain("Activity: reading");
    expect(record.consumed).toBe(false);
  });

  it("returns a terminal result and consumes it", async () => {
    const record = createTestSubagent({ result: "done", terminalReason: "completed" });
    const result = await getTool(record).execute("call", { agent_id: record.id }, signal, undefined, undefined);
    expect(text(result)).toContain("Agent agent-1 completed");
    expect(text(result)).toContain("Reason: completed");
    expect(text(result)).toContain("done");
    expect(record.consumed).toBe(true);
  });

  it("reports terminal provider errors and partial output", async () => {
    const record = createTestSubagent({ status: "error", error: "provider down", result: "partial", terminalReason: "provider_failure" });
    const result = await getTool(record).execute("call", { agent_id: record.id }, signal, undefined, undefined);
    expect(text(result)).toContain("Error: provider down");
    expect(text(result)).toContain("partial");
  });

  it("bounds terminal result output", async () => {
    const record = createTestSubagent({ result: "x".repeat(12_001) });
    const result = await getTool(record).execute("call", { agent_id: record.id }, signal, undefined, undefined);
    expect(text(result)).toContain("Output truncated");
    expect(text(result)).toContain("Full transcript");
  });

  it("includes live details for terminal and running records", async () => {
    const record = createTestSubagent({ turnCount: 4, maxTurns: 8, lifetimeUsage: { input: 10, output: 20, cacheWrite: 0 } });
    const result = await getTool(record).execute("call", { agent_id: record.id }, signal, undefined, undefined);
    expect(result.details).toMatchObject({ agentId: record.id, turnCount: 4, maxTurns: 8, tokens: "30 token" });
  });
});

describe("retained steer tool behavior", () => {
  it("declares the steer tool", () => { expect(new SteerTool({ steer: vi.fn() }, { emit: vi.fn() }).toToolDefinition().name).toBe("steer_subagent"); });

  it("reports a missing target", async () => {
    const result = await new SteerTool({ steer: vi.fn(async () => ({ kind: "not_found" as const, agentId: "missing" })) }, { emit: vi.fn() }).execute("call", { agent_id: "missing", message: "go" }, signal, undefined, undefined);
    expect(text(result)).toContain("Agent not found");
  });

  it("reports a rejected target status", async () => {
    const result = await new SteerTool({ steer: vi.fn(async () => ({ kind: "rejected" as const, runId: 2, status: "completed" as const })) }, { emit: vi.fn() }).execute("call", { agent_id: "done", message: "go" }, signal, undefined, undefined);
    expect(text(result)).toContain("cannot be steered");
    expect(text(result)).toContain("completed");
  });

  it("reports buffered steering and emits its event", async () => {
    const emit = vi.fn();
    const result = await new SteerTool({ steer: vi.fn(async () => ({ kind: "buffered" as const, runId: 1 })) }, { emit }).execute("call", { agent_id: "a", message: "focus" }, signal, undefined, undefined);
    expect(text(result)).toContain("buffered");
    expect(emit).toHaveBeenCalledWith("subagents:steered", expect.objectContaining({ id: "a", runId: 1, message: "focus" }));
  });

  it("reports delivered steering", async () => {
    const result = await new SteerTool({ steer: vi.fn(async () => ({ kind: "delivered" as const, runId: 3 })) }, { emit: vi.fn() }).execute("call", { agent_id: "a", message: "focus" }, signal, undefined, undefined);
    expect(text(result)).toContain("delivered");
    expect(text(result)).toContain("Run ID: 3");
  });

  it("forwards the target and message exactly", async () => {
    const steer = vi.fn(async () => ({ kind: "delivered" as const, runId: 1 }));
    await new SteerTool({ steer }, { emit: vi.fn() }).execute("call", { agent_id: "agent", message: "do not summarize" }, signal, undefined, undefined);
    expect(steer).toHaveBeenCalledWith("agent", "do not summarize");
  });
});

describe("retained list and stop tool behavior", () => {
  it("renders an empty list message", async () => {
    const result = await new ListTool({ listAgents: () => [] }).execute("call", {}, signal, undefined, undefined);
    expect(text(result)).toContain("No subagents match");
  });

  it("renders bounded identity, mode, status, and description", async () => {
    const record = createTestSubagent({ id: "a", mode: "detached", description: "inspect code" });
    const result = await new ListTool({ listAgents: () => [record] }).execute("call", {}, signal, undefined, undefined);
    expect(text(result)).toContain("a run=1 detached completed");
    expect(text(result)).toContain("inspect code");
  });

  it("omits stale activity text for terminal records", async () => {
    const record = createTestSubagent({ id: "done", responseText: "stale final activity" });
    const result = await new ListTool({ listAgents: () => [record] }).execute("call", {}, signal, undefined, undefined);
    expect(text(result)).not.toContain("stale final activity");
  });

  it("filters active records", async () => {
    const active = createTestSubagent({ id: "active", status: "running", result: undefined, completedAt: undefined });
    const done = createTestSubagent({ id: "done" });
    const result = await new ListTool({ listAgents: () => [active, done] }).execute("call", { state: "active" }, signal, undefined, undefined);
    expect(text(result)).toContain("active"); expect(text(result)).not.toContain("done run");
  });

  it("filters terminal records", async () => {
    const active = createTestSubagent({ id: "active", status: "running", result: undefined, completedAt: undefined });
    const done = createTestSubagent({ id: "done" });
    const result = await new ListTool({ listAgents: () => [active, done] }).execute("call", { state: "terminal" }, signal, undefined, undefined);
    expect(text(result)).toContain("done"); expect(text(result)).not.toContain("active run");
  });

  it("rejects an out-of-range list limit", async () => {
    const result = await new ListTool({ listAgents: () => [] }).execute("call", { limit: 101 }, signal, undefined, undefined);
    expect(text(result)).toContain("limit must be");
  });

  it("reports an already-terminal stop", async () => {
    const record = createTestSubagent({ id: "done" });
    const result = await new StopTool({ stop: vi.fn(async () => ({ kind: "already_terminal" as const, agentId: "done", runId: 1, record })) }).execute("call", { agent_id: "done" }, signal, undefined, undefined);
    expect(text(result)).toContain("already terminal"); expect(text(result)).toContain("completed");
  });

  it("reports a settled stop reason", async () => {
    const record = createTestSubagent({ id: "a", status: "stopped", terminalReason: "explicit_stop" });
    const result = await new StopTool({ stop: vi.fn(async () => ({ kind: "stopped" as const, agentId: "a", runId: 1, reason: "explicit_stop" as const, record })) }).execute("call", { agent_id: "a", settlement_timeout_seconds: 3 }, signal, undefined, undefined);
    expect(text(result)).toContain("Agent a stopped"); expect(text(result)).toContain("explicit_stop");
  });

  it("reports a stop-pending outcome without claiming settlement", async () => {
    const record = createTestSubagent({ id: "a", status: "running", result: undefined, completedAt: undefined });
    const result = await new StopTool({ stop: vi.fn(async () => ({ kind: "stop_pending" as const, agentId: "a", runId: 1, reason: "runtime_timeout" as const, record })) }).execute("call", { agent_id: "a" }, signal, undefined, undefined);
    expect(text(result)).toContain("has not settled"); expect(text(result)).toContain("runtime_timeout");
  });

  it("reports a missing stop target", async () => {
    const result = await new StopTool({ stop: vi.fn(async () => ({ kind: "not_found" as const, agentId: "missing" })) }).execute("call", { agent_id: "missing" }, signal, undefined, undefined);
    expect(text(result)).toContain("Agent not found");
  });

  it("validates stop settlement bounds before calling the manager", async () => {
    const stop = vi.fn();
    const result = await new StopTool({ stop }).execute("call", { agent_id: "a", settlement_timeout_seconds: 31 }, signal, undefined, undefined);
    expect(text(result)).toContain("settlement_timeout_seconds"); expect(stop).not.toHaveBeenCalled();
  });
});

describe("retained resume tool behavior", () => {
  it("reports a missing resume target", async () => {
    const result = await new ResumeTool({ resume: vi.fn(async () => ({ kind: "not_found" as const, agentId: "missing" })), getRecord: vi.fn() }).execute("call", { agent_id: "missing", prompt: "continue" }, signal, undefined, undefined);
    expect(text(result)).toContain("Agent not found");
  });

  it("reports a retained-session state rejection", async () => {
    const result = await new ResumeTool({ resume: vi.fn(async () => ({ kind: "wrong_state" as const, agentId: "done", status: "completed" as const })), getRecord: vi.fn() }).execute("call", { agent_id: "done", prompt: "continue" }, signal, undefined, undefined);
    expect(text(result)).toContain("cannot be resumed");
  });

  it("returns detached resume identity", async () => {
    const record = createTestSubagent({ id: "a", mode: "detached", status: "running", result: undefined, completedAt: undefined });
    const result = await new ResumeTool({ resume: vi.fn(async () => ({ kind: "detached" as const, agentId: "a", runId: 2 })), getRecord: vi.fn(() => record) }).execute("call", { agent_id: "a", prompt: "continue" }, signal, undefined, undefined);
    expect(text(result)).toContain("Resume detached for agent a"); expect(text(result)).toContain("Run ID: 1");
  });

  it("returns and consumes a joined resume result", async () => {
    const record = createTestSubagent({ id: "a", mode: "joined", result: "continued" });
    const result = await new ResumeTool({ resume: vi.fn(async () => ({ kind: "joined" as const, record })), getRecord: vi.fn(() => record) }).execute("call", { agent_id: "a", prompt: "continue", mode: "joined" }, signal, undefined, undefined);
    expect(text(result)).toContain("Agent a completed"); expect(text(result)).toContain("continued"); expect(record.consumed).toBe(true);
  });

  it("validates resume timeout before manager dispatch", async () => {
    const resume = vi.fn();
    const result = await new ResumeTool({ resume, getRecord: vi.fn() }).execute("call", { agent_id: "a", prompt: "continue", timeout_seconds: 0 }, signal, undefined, undefined);
    expect(text(result)).toContain("timeout_seconds"); expect(resume).not.toHaveBeenCalled();
  });

  it("sends an initial joined progress update on reservation", async () => {
    const record = createTestSubagent({ id: "a", mode: "joined", result: "continued" });
    const updates = vi.fn();
    const resume = vi.fn(async (_id: string, _prompt: string, _mode: "joined" | "detached", _timeout: number | undefined, _signal: AbortSignal | undefined, reserved?: (record: any) => void) => { reserved?.(record); return { kind: "joined" as const, record }; });
    await new ResumeTool({ resume, getRecord: vi.fn(() => record) }).execute("call", { agent_id: "a", prompt: "continue", mode: "joined" }, signal, updates, undefined);
    expect(updates).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: "text", text: "Resuming..." }] }));
  });
});

describe("retained spawn configuration contracts", () => {
  const model = makeModel({ provider: "anthropic", id: "parent", reasoning: true });
  const models = { find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined, getAll: () => [model], getAvailable: () => [model] };
  const info = { parentModel: model, parentThinkingLevel: "medium" as const, modelRegistry: models };
  const params = { prompt: "work", description: "task", subagent_type: "general-purpose" };

  it("resolves a known agent type", () => { const result = resolveSpawnConfig(params, registry, info, { defaultMaxTurns: undefined }); expect("identity" in result && result.identity.subagentType).toBe("general-purpose"); });
  it("defaults delivery mode to detached", () => { const result = resolveSpawnConfig(params, registry, info, { defaultMaxTurns: undefined }); expect("execution" in result && result.execution.mode).toBe("detached"); });
  it("uses joined mode from invocation parameters", () => { const result = resolveSpawnConfig({ ...params, mode: "joined" }, registry, info, { defaultMaxTurns: undefined }); expect("execution" in result && result.execution.mode).toBe("joined"); });
  it("normalizes zero max turns to unlimited", () => { const result = resolveSpawnConfig({ ...params, max_turns: 0 }, registry, info, { defaultMaxTurns: undefined }); expect("execution" in result && result.execution.effectiveMaxTurns).toBeUndefined(); });
  it("normalizes positive max turns", () => { const result = resolveSpawnConfig({ ...params, max_turns: 4 }, registry, info, { defaultMaxTurns: undefined }); expect("execution" in result && result.execution.effectiveMaxTurns).toBe(4); });
  it("rejects negative max turns", () => { const result = resolveSpawnConfig({ ...params, max_turns: -1 }, registry, info, { defaultMaxTurns: undefined }); expect(result).toMatchObject({ error: expect.stringContaining("max_turns") }); });
  it("rejects non-positive timeout seconds", () => { const result = resolveSpawnConfig({ ...params, timeout_seconds: 0 }, registry, info, { defaultMaxTurns: undefined }); expect(result).toMatchObject({ error: expect.stringContaining("timeout_seconds") }); });
  it("rejects removed delivery fields", () => { const result = resolveSpawnConfig({ ...params, run_in_background: true }, registry, info, { defaultMaxTurns: undefined }); expect(result).toMatchObject({ error: expect.stringContaining("Removed field") }); });
  it("resolves an explicit model override", () => { const result = resolveSpawnConfig({ ...params, model: "anthropic/parent" }, registry, info, { defaultMaxTurns: undefined }); expect("execution" in result && result.execution.model).toBe(model); });
  it("builds invocation tags from execution options", () => { const result = resolveSpawnConfig({ ...params, mode: "joined", thinking: "high", inherit_context: true, timeout_seconds: 4 }, registry, info, { defaultMaxTurns: undefined }); expect("presentation" in result && result.presentation.agentTags).toEqual(expect.arrayContaining(["thinking: high", "inherit context", "mode: joined", "timeout: 4s"])); });
});
