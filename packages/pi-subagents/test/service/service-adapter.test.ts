import { describe, expect, it, vi } from "vitest";
import { SubagentsServiceAdapter, toSubagentRecord } from "#src/service/service-adapter";
import type { SubagentManagerLike } from "#src/service/service-adapter";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { makeModel } from "#test/helpers/make-model";

function makeManager(record = createTestSubagent()): SubagentManagerLike {
  return {
    launch: vi.fn().mockResolvedValue({ kind: "detached", agentId: record.id, runId: record.runId }),
    resume: vi.fn().mockResolvedValue({ kind: "detached", agentId: record.id, runId: record.runId + 1 }),
    stop: vi.fn().mockResolvedValue({ kind: "already_terminal", agentId: record.id, runId: record.runId, record }),
    steer: vi.fn().mockResolvedValue({ kind: "delivered", runId: record.runId }),
    getRecord: vi.fn().mockReturnValue(record),
    listAgents: vi.fn().mockReturnValue([record]),
    waitForAll: vi.fn().mockResolvedValue(undefined),
    hasRunning: vi.fn().mockReturnValue(false),
    registerWorkspaceProvider: vi.fn().mockReturnValue(vi.fn()),
    registerLifecycleInterceptor: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  };
}
function makeRuntime(): any {
  const model = makeModel({ provider: "anthropic", id: "parent" });
  const registry = { find: vi.fn(), getAvailable: () => [] };
  return {
    currentCtx: { cwd: "/tmp", model, thinkingLevel: "medium", modelRegistry: registry, getSystemPrompt: () => "", sessionManager: { getSessionFile: () => "/parent.jsonl", getSessionId: () => "parent-id", getBranch: () => [] } },
    buildSnapshot: vi.fn(() => ({ cwd: "/tmp", systemPrompt: "", model, modelRegistry: registry })),
    getSessionInfo: vi.fn(() => ({ parentSessionFile: "/parent.jsonl", parentSessionId: "parent-id" })),
  };
}
function makeAdapter(manager = makeManager(), registry?: AgentTypeRegistry) {
  const runtime = makeRuntime();
  return { adapter: new SubagentsServiceAdapter(manager, (input) => input === "bad" ? "Model not found" : makeModel({ provider: "zai", id: input }), runtime, registry), manager, runtime };
}

describe("toSubagentRecord", () => {
  it("serializes an explicit allowlist including live metrics and terminal reason", () => {
    const record = createTestSubagent({ type: "Explore", mode: "detached", terminalReason: "completed", activeTools: ["read"], responseText: "reading" });
    const result = toSubagentRecord(record);
    expect(result).toMatchObject({ id: "agent-1", type: "Explore", runId: 1, mode: "detached", status: "completed", stopRequested: false, terminalReason: "completed", activeTools: ["read"], compactionCount: 0 });
    expect(result).not.toHaveProperty("subagentSession");
  });

  it("bounds large result output and keeps the transcript pointer", () => {
    const record = createTestSubagent({ result: "x".repeat(12_001), mode: "detached" });
    const result = toSubagentRecord(record);
    expect(result.result).toContain("Output truncated");
    expect(result.result).toContain("unavailable");
  });
});

describe("SubagentsServiceAdapter", () => {
  it("launches with resolved defaults and returns detached identity", async () => {
    const registry = new AgentTypeRegistry(() => new Map());
    const { adapter, manager, runtime } = makeAdapter(makeManager(), registry);
    const delivery = await adapter.launch("Explore", "inspect", { mode: "detached" });
    expect(delivery.kind).toBe("detached");
    expect(runtime.buildSnapshot).toHaveBeenCalledWith(false);
    expect(manager.launch).toHaveBeenCalledWith(expect.anything(), "Explore", "inspect", expect.objectContaining({ mode: "detached", description: "inspect", origin: "service" }));
  });

  it("requires a current session and resolves model overrides", async () => {
    const { adapter, manager, runtime } = makeAdapter();
    (runtime as any).currentCtx = undefined;
    await expect(adapter.launch("Explore", "task")).rejects.toThrow("No active session");
    runtime.currentCtx = makeRuntime().currentCtx;
    await adapter.launch("Explore", "task", { model: "zai-model" });
    expect(manager.launch).toHaveBeenCalledWith(expect.anything(), "Explore", "task", expect.objectContaining({ model: expect.objectContaining({ id: "zai-model" }) }));
  });

  it("returns joined serialized records and consumes them", async () => {
    const record = createTestSubagent({ mode: "joined" });
    const manager = makeManager(record);
    manager.launch = vi.fn().mockResolvedValue({ kind: "joined", record });
    const { adapter } = makeAdapter(manager);
    const delivery = await adapter.launch("Explore", "task", { mode: "joined" });
    expect(delivery).toMatchObject({ kind: "joined", record: { id: record.id, status: "completed" } });
    expect(record.consumed).toBe(true);
  });

  it("preserves resume, stop, steer, list, result, and lifecycle outcomes", async () => {
    const record = createTestSubagent();
    const manager = makeManager(record);
    const { adapter } = makeAdapter(manager);
    expect(await adapter.resume(record.id, "continue")).toMatchObject({ kind: "detached", agentId: record.id });
    expect(await adapter.stop(record.id)).toMatchObject({ kind: "already_terminal", agentId: record.id });
    expect(await adapter.steer(record.id, "redirect")).toMatchObject({ kind: "delivered", agentId: record.id });
    expect(adapter.list({ state: "terminal", limit: 1 })[0].id).toBe(record.id);
    expect(adapter.getResult(record.id)).toMatchObject({ kind: "result", record: { id: record.id } });
    expect(adapter.getRecord(record.id)?.id).toBe(record.id);
    expect(adapter.hasRunning()).toBe(false);
    await adapter.waitForAll();
  });

  it("returns missing records without flattening outcomes", async () => {
    const manager = makeManager();
    manager.getRecord = vi.fn().mockReturnValue(undefined);
    manager.resume = vi.fn().mockResolvedValue({ kind: "not_found", agentId: "missing" });
    manager.stop = vi.fn().mockResolvedValue({ kind: "not_found", agentId: "missing" });
    manager.steer = vi.fn().mockResolvedValue({ kind: "not_found", agentId: "missing" });
    const { adapter } = makeAdapter(manager);
    expect(await adapter.resume("missing", "continue")).toEqual({ kind: "not_found", agentId: "missing" });
    expect(await adapter.stop("missing")).toEqual({ kind: "not_found", agentId: "missing" });
    expect(await adapter.steer("missing", "hi")).toEqual({ kind: "not_found", agentId: "missing" });
    expect(adapter.getResult("missing")).toEqual({ kind: "not_found", agentId: "missing" });
  });
});
