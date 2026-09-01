import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import type { SubagentsService } from "#src/service/service";
import type { ServiceRuntimeLike, SubagentManagerLike } from "#src/service/service-adapter";
import { SubagentsServiceAdapter, toSubagentRecord } from "#src/service/service-adapter";
import { makeModel } from "#test/helpers/make-model";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

function runtime(overrides: Partial<ServiceRuntimeLike> = {}): ServiceRuntimeLike {
  return {
    currentCtx: {
      cwd: "/project", model: makeModel({ provider: "anthropic", id: "parent" }),
      modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
      getSystemPrompt: () => "parent", sessionManager: { getSessionFile: () => "/parent.jsonl", getSessionId: () => "parent-id", getBranch: () => [] },
    } as any,
    buildSnapshot: vi.fn((_inherit: boolean): ParentSnapshot => STUB_SNAPSHOT),
    getSessionInfo: vi.fn(() => ({ parentSessionFile: "/parent.jsonl", parentSessionId: "parent-id" })),
    ...overrides,
  };
}

function manager(): ReturnType<typeof makeManager> {
  return makeManager();
}
function makeManager() {
  const record = createTestSubagent({ id: "a-1", status: "completed", result: "done" });
  const serviceResult = { kind: "detached" as const, agentId: record.id, runId: record.runId };
  return {
    record,
    launch: vi.fn(async (): Promise<any> => serviceResult),
    resume: vi.fn(async (): Promise<any> => ({ kind: "not_found", agentId: "missing" })),
    stop: vi.fn(async (): Promise<any> => ({ kind: "not_found", agentId: "missing" })),
    steer: vi.fn(async (): Promise<any> => ({ kind: "not_found", agentId: "missing" })),
    getRecord: vi.fn((id: string) => id === record.id ? record : undefined),
    listAgents: vi.fn(() => [record]),
    waitForAll: vi.fn(async () => {}),
    hasRunning: vi.fn(() => false),
    registerWorkspaceProvider: vi.fn(() => vi.fn()),
    registerLifecycleInterceptor: vi.fn(() => ({ dispose: vi.fn(async () => {}) })),
  } satisfies SubagentManagerLike & { record: typeof record };
}

function adapter(mgr: ReturnType<typeof manager>, runtimeOverrides: Partial<ServiceRuntimeLike> = {}, registry?: AgentTypeRegistry) {
  const models = { find: () => undefined, getAll: () => [], getAvailable: () => [] };
  return new SubagentsServiceAdapter(mgr, vi.fn(() => makeModel({ provider: "anthropic", id: "resolved" })), runtime(runtimeOverrides), registry, { fallbackSubagent: false });
}

describe("retained public record serialization", () => {
  it("includes stable record identity and execution fields", () => {
    const record = createTestSubagent({ id: "abc", type: "Explore", description: "task", terminalReason: "completed", toolUses: 5, compactionCount: 1 });
    expect(toSubagentRecord(record)).toMatchObject({ id: "abc", type: "Explore", description: "task", runId: 1, mode: "detached", status: "completed", terminalReason: "completed", toolUses: 5, compactionCount: 1, lifetimeUsage: { input: 500, output: 500, cacheWrite: 0 } });
  });

  it("uses an explicit serialization allowlist for a complete record", () => {
    const result = toSubagentRecord(createTestSubagent());
    expect(Object.keys(result).sort()).toEqual([
      "activeRuntimeMs", "activeTools", "compactionCount", "completedAt", "currentActivity", "description", "id", "lifetimeUsage", "mode", "modelLabel", "result", "runId", "startedAt", "status", "stopRequested", "terminalReason", "thinkingLevel", "toolUses", "type",
    ]);
  });

  it("does not expose session or collaborator internals", () => {
    const record = createTestSubagent({ invocation: { modelName: "haiku" }, toolCallId: "call-1" });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("subagentSession");
    expect(result).not.toHaveProperty("execution");
    expect(result).not.toHaveProperty("invocation");
    expect(result).not.toHaveProperty("abortController");
    expect(result).not.toHaveProperty("promise");
  });

  it("omits optional terminal values when absent", () => {
    const record = createTestSubagent({ status: "running", result: undefined, error: undefined, completedAt: undefined });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("completedAt");
    expect(result).toMatchObject({ status: "running", stopRequested: false });
  });

  it("bounds serialized result output and points to the transcript", () => {
    const record = createTestSubagent({ result: "x".repeat(12_010), execution: undefined as never });
    const result = toSubagentRecord(record);
    expect(result.result).toHaveLength(12_000 + "\n\nOutput truncated. Full transcript: unavailable".length);
    expect(result.result).toContain("Output truncated");
  });
});

describe("retained service list and result contracts", () => {
  it("returns a serialized record for a known id", () => {
    const mgr = manager();
    const service = adapter(mgr);
    expect(service.getRecord("a-1")).toMatchObject({ id: "a-1", status: "completed" });
    expect(service.getRecord("missing")).toBeUndefined();
  });

  it("lists all records through the manager order", () => {
    const mgr = manager();
    const service = adapter(mgr);
    expect(service.list().map((record) => record.id)).toEqual(["a-1"]);
    expect(mgr.listAgents).toHaveBeenCalledOnce();
  });

  it("filters active records", () => {
    const mgr = manager();
    const active = createTestSubagent({ id: "running", status: "running", result: undefined, completedAt: undefined });
    mgr.listAgents.mockReturnValue([mgr.record, active]);
    expect(adapter(mgr).list({ state: "active" }).map((record) => record.id)).toEqual(["running"]);
  });

  it("filters terminal records", () => {
    const mgr = manager();
    const active = createTestSubagent({ id: "running", status: "running", result: undefined, completedAt: undefined });
    mgr.listAgents.mockReturnValue([active, mgr.record]);
    expect(adapter(mgr).list({ state: "terminal" }).map((record) => record.id)).toEqual(["a-1"]);
  });

  it("applies a bounded list limit", () => {
    const mgr = manager();
    const second = createTestSubagent({ id: "b-2" });
    mgr.listAgents.mockReturnValue([mgr.record, second]);
    expect(adapter(mgr).list({ limit: 1 })).toHaveLength(1);
  });

  it("rejects an invalid list limit", () => {
    expect(() => adapter(manager()).list({ limit: 0 })).toThrow(/limit/);
    expect(() => adapter(manager()).list({ limit: 101 })).toThrow(/limit/);
  });

  it("returns a result and marks terminal records consumed", () => {
    const mgr = manager();
    const result = adapter(mgr).getResult("a-1");
    expect(result.kind).toBe("result");
    expect(mgr.record.consumed).toBe(true);
  });

  it("returns not-found results without touching records", () => {
    const mgr = manager();
    expect(adapter(mgr).getResult("missing")).toEqual({ kind: "not_found", agentId: "missing" });
  });
});

describe("retained service launch resolution", () => {
  it("requires an active parent session", async () => {
    const mgr = manager();
    const service = adapter(mgr, { currentCtx: undefined });
    await expect(service.launch("Explore", "work")).rejects.toThrow(/active session/);
  });

  it("reloads agent definitions before launching", async () => {
    const mgr = manager();
    const registry = new AgentTypeRegistry(() => new Map());
    const reload = vi.spyOn(registry, "reload");
    await adapter(mgr, {}, registry).launch("Explore", "work");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("uses the configured fallback agent type for an unknown request", async () => {
    const mgr = manager();
    const service = new SubagentsServiceAdapter(mgr, vi.fn(() => makeModel({ id: "resolved" })), runtime(), new AgentTypeRegistry(() => new Map()), { fallbackSubagent: "Explore" });
    await service.launch("typo", "work");
    expect(mgr.launch).toHaveBeenCalledWith(expect.anything(), "Explore", "work", expect.anything());
  });

  it("resolves an explicit model through the parent registry", async () => {
    const mgr = manager();
    const resolved = makeModel({ provider: "anthropic", id: "haiku" });
    const resolveModel = vi.fn(() => resolved);
    const ctx = runtime();
    const service = new SubagentsServiceAdapter(mgr, resolveModel, ctx);
    await service.launch("Explore", "work", { model: "haiku" });
    expect(resolveModel).toHaveBeenCalledWith("haiku", ctx.currentCtx!.modelRegistry);
    expect(mgr.launch).toHaveBeenCalledWith(expect.anything(), "Explore", "work", expect.objectContaining({ model: resolved }));
  });

  it("propagates model resolution failures", async () => {
    const mgr = manager();
    const service = new SubagentsServiceAdapter(mgr, () => "Model not found: bad", runtime());
    await expect(service.launch("Explore", "work", { model: "bad" })).rejects.toThrow("Model not found");
  });

  it("uses the prompt prefix as the default description", async () => {
    const mgr = manager();
    await adapter(mgr).launch("Explore", "x".repeat(200));
    expect(mgr.launch).toHaveBeenCalledWith(expect.anything(), "Explore", expect.any(String), expect.objectContaining({ description: "x".repeat(80) }));
  });

  it("passes mode, timeout, max turns, and context to manager launch", async () => {
    const mgr = manager();
    await adapter(mgr).launch("Explore", "work", { mode: "joined", timeoutSeconds: 12, maxTurns: 3, inheritContext: true, thinkingLevel: "high" });
    expect(mgr.launch).toHaveBeenCalledWith(expect.anything(), "Explore", "work", expect.objectContaining({ mode: "joined", timeoutSeconds: 12, maxTurns: 3, inheritContext: true, thinkingLevel: "off", origin: "service" }));
  });

  it("marks joined launch records consumed and serializes them", async () => {
    const mgr = manager();
    mgr.launch.mockResolvedValue({ kind: "joined", record: mgr.record });
    const result = await adapter(mgr).launch("Explore", "work", { mode: "joined" });
    expect(result.kind).toBe("joined");
    expect(mgr.record.consumed).toBe(true);
    if (result.kind === "joined") expect(result.record).not.toHaveProperty("subagentSession");
  });

  it("returns detached launch identity without serializing internals", async () => {
    const result = await adapter(manager()).launch("Explore", "work");
    expect(result).toEqual({ kind: "detached", agentId: "a-1", runId: 1 });
  });

  it("rejects invalid max turns and timeout values", async () => {
    await expect(adapter(manager()).launch("Explore", "work", { maxTurns: -1 })).rejects.toThrow(/maxTurns/);
    await expect(adapter(manager()).launch("Explore", "work", { timeoutSeconds: 0 })).rejects.toThrow(/timeoutSeconds/);
  });
});

describe("retained service control delegation", () => {
  it("delegates stop and preserves the stop report", async () => {
    const mgr = manager();
    mgr.stop.mockResolvedValue({ kind: "already_terminal", agentId: "a-1", runId: 1, record: mgr.record });
    const result = await adapter(mgr).stop("a-1");
    expect(mgr.stop).toHaveBeenCalledWith("a-1", 5);
    expect(result).toMatchObject({ kind: "already_terminal", agentId: "a-1", record: { id: "a-1" } });
  });

  it("delegates steer outcomes with agent identity", async () => {
    const mgr = manager();
    mgr.steer.mockResolvedValue({ kind: "buffered", runId: 2 });
    expect(await adapter(mgr).steer("a-1", "continue")).toEqual({ kind: "buffered", runId: 2, agentId: "a-1" });
    expect(mgr.steer).toHaveBeenCalledWith("a-1", "continue");
  });

  it("delegates waitForAll and hasRunning", async () => {
    const mgr = manager();
    mgr.hasRunning.mockReturnValue(true);
    await adapter(mgr).waitForAll();
    expect(adapter(mgr).hasRunning()).toBe(true);
    expect(mgr.waitForAll).toHaveBeenCalledOnce();
    expect(mgr.hasRunning).toHaveBeenCalledOnce();
  });

  it("delegates workspace provider registration and returns its disposer", () => {
    const mgr = manager();
    const disposer = vi.fn();
    mgr.registerWorkspaceProvider.mockReturnValue(disposer);
    const provider: WorkspaceProvider = { prepare: vi.fn(async () => undefined) };
    expect(adapter(mgr).registerWorkspaceProvider(provider)).toBe(disposer);
    expect(mgr.registerWorkspaceProvider).toHaveBeenCalledWith(provider);
  });

  it("delegates lifecycle interceptor registration", () => {
    const mgr = manager();
    const registration = { dispose: vi.fn(async () => {}) };
    mgr.registerLifecycleInterceptor.mockReturnValue(registration);
    const interceptor = { beforeStart: () => ({ action: "continue" as const }) };
    expect(adapter(mgr).registerLifecycleInterceptor(interceptor)).toBe(registration);
    expect(mgr.registerLifecycleInterceptor).toHaveBeenCalledWith(interceptor);
  });

  it("exposes the service through the public interface shape", () => {
    const service: SubagentsService = adapter(manager());
    expect(typeof service.launch).toBe("function");
    expect(typeof service.resume).toBe("function");
    expect(typeof service.getResult).toBe("function");
    expect(typeof service.registerWorkspaceProvider).toBe("function");
  });
});
