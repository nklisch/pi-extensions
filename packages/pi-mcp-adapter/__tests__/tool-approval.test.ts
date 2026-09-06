import { describe, expect, it, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeDescribe, executeSearch } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import { ensureToolCallApproved, isToolCallApprovalRequired } from "../tool-approval.ts";
import {
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpConfig,
  type McpToolApprovalRequest,
  type ToolMetadata,
} from "../types.ts";

const tool: ToolMetadata = {
  name: "demo_search-records",
  originalName: "search-records",
  description: "Search records",
};

function createState(options: {
  approveTools?: boolean | string[];
  decision?: "Allow once" | "Allow for session (same arguments)" | "Deny";
  interactive?: boolean;
  broker?: (request: McpToolApprovalRequest) => void;
} = {}) {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "called" }] });
  const select = vi.fn().mockResolvedValue(options.decision ?? "Allow once");
  const connection = {
    status: "connected",
    client: { callTool },
    tools: [{ name: "search-records", description: "Search records" }],
    resources: [],
    prompts: [],
  };
  const state = {
    config: {
      mcpServers: {
        demo: {
          command: "demo",
          ...(options.approveTools === undefined ? {} : { approveTools: options.approveTools }),
        },
      },
    },
    toolMetadata: new Map([["demo", [tool]]]),
    resourceCounts: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    approvedToolCalls: new Map<string, true>(),
    ...(options.broker
      ? { approvalEvents: { emit: vi.fn((channel: string, data: unknown) => {
          expect(channel).toBe(MCP_TOOL_APPROVAL_REQUEST_EVENT);
          options.broker?.(data as McpToolApprovalRequest);
        }) } }
      : {}),
    manager: {
      getConnection: () => connection,
      getRequestOptions: () => undefined,
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    },
    failureTracker: new Map(),
    failureMessages: new Map(),
    ...(options.interactive === false ? {} : { ui: { select } }),
  } as unknown as McpExtensionState;
  return { state, callTool, select };
}

describe("tool approval", () => {
  it("matches original, prefixed, normalized, and read_* resource tool names", () => {
    const cases: Array<{ config: McpConfig; meta: ToolMetadata }> = [
      {
        config: { mcpServers: { demo: { approveTools: ["search_records"] } } },
        meta: tool,
      },
      {
        config: { mcpServers: { demo: { approveTools: ["demo_search_records"] } } },
        meta: tool,
      },
      {
        config: { mcpServers: { "docs-mcp": {} }, settings: { approveTools: ["docs_read_*"] } },
        meta: { name: "docs_read_handbook", originalName: "read_handbook", description: "Read handbook", resourceUri: "docs://handbook" },
      },
    ];

    for (const { config, meta } of cases) {
      expect(isToolCallApprovalRequired(config, Object.keys(config.mcpServers)[0], meta)).toBe(true);
    }
  });

  it("fails closed headlessly with a structured approval_required result", async () => {
    const { state, callTool } = createState({ approveTools: true, interactive: false });

    const result = await executeCall(state, tool.name, { query: "private" });

    expect(result.details).toEqual({
      mode: "call",
      error: "approval_required",
      server: "demo",
      tool: "search-records",
    });
    expect(result.content[0].text).toContain("approval-gated");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("returns approval_denied without throwing or invoking proxy or direct tools", async () => {
    const proxy = createState({ approveTools: true, decision: "Deny" });
    await expect(executeCall(proxy.state, tool.name, {})).resolves.toMatchObject({
      details: { error: "approval_denied", server: "demo", tool: "search-records" },
    });
    expect(proxy.callTool).not.toHaveBeenCalled();

    const direct = createState({ approveTools: true, decision: "Deny" });
    const execute = createDirectToolExecutor(() => direct.state, () => null, {
      serverName: "demo",
      originalName: "search-records",
      prefixedName: "demo_search-records",
      description: "Search records",
    });
    await expect(execute("call-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { error: "approval_denied", server: "demo", tool: "search-records" },
    });
    expect(direct.callTool).not.toHaveBeenCalled();
  });

  it("caches only Allow for session decisions", async () => {
    const session = createState({ approveTools: true, decision: "Allow for session (same arguments)" });
    await ensureToolCallApproved(session.state, "demo", tool, {}, undefined);
    await ensureToolCallApproved(session.state, "demo", tool, {}, undefined);
    expect(session.select).toHaveBeenCalledTimes(1);
    expect(session.state.approvedToolCalls.size).toBe(1);

    const once = createState({ approveTools: true, decision: "Allow once" });
    await ensureToolCallApproved(once.state, "demo", tool, {}, undefined);
    await ensureToolCallApproved(once.state, "demo", tool, {}, undefined);
    expect(once.select).toHaveBeenCalledTimes(2);
    expect(once.state.approvedToolCalls.size).toBe(0);
  });

  it("lets a broker allow a gated call without showing the built-in prompt", async () => {
    const { state, callTool, select } = createState({
      approveTools: true,
      interactive: false,
      broker: (request) => {
        expect(request).toMatchObject({
          serverName: "demo",
          originalToolName: "search-records",
          prefixedToolName: "demo_search-records",
          args: { query: "private" },
          origin: "proxy",
        });
        expect(request.claim(() => "allow_once")).toBe(true);
      },
    });

    const result = await executeCall(state, tool.name, { query: "private" });

    expect(result.details).not.toHaveProperty("error");
    expect(callTool).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });

  it("lets a broker deny even when approveTools does not match", async () => {
    const { state, callTool } = createState({
      broker: (request) => {
        expect(request.claim(() => "deny")).toBe(true);
      },
    });

    await expect(executeCall(state, tool.name, {})).resolves.toMatchObject({
      details: { error: "approval_denied", server: "demo", tool: "search-records" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("marks direct MCP tool calls with the direct origin", async () => {
    const { state, callTool } = createState({
      approveTools: true,
      interactive: false,
      broker: (request) => {
        expect(request.origin).toBe("direct");
        expect(request.claim(() => "allow_once")).toBe(true);
      },
    });
    const execute = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search-records",
      prefixedName: "demo_search-records",
      description: "Search records",
    });

    await execute("call-1", {}, undefined, undefined, {} as never);

    expect(callTool).toHaveBeenCalledOnce();
  });

  it("falls back to the built-in prompt when a broker abstains", async () => {
    const { state, select } = createState({
      approveTools: true,
      decision: "Allow once",
      broker: (request) => {
        expect(request.claim(() => "abstain")).toBe(true);
      },
    });

    await ensureToolCallApproved(state, "demo", tool, {}, undefined);
    expect(select).toHaveBeenCalledOnce();
  });

  it("uses broker allow_for_session decisions for the existing session cache", async () => {
    const broker = vi.fn((request: McpToolApprovalRequest) => {
      expect(request.claim(() => "allow_for_session")).toBe(true);
    });
    const { state } = createState({ approveTools: true, broker });

    await ensureToolCallApproved(state, "demo", tool, {}, undefined);
    await ensureToolCallApproved(state, "demo", tool, {}, undefined);

    expect(broker).toHaveBeenCalledOnce();
    expect(state.approvedToolCalls.size).toBe(1);
  });

  it.each(["broker", "dialog"])("binds %s session consent to canonical wire arguments and exact tool identity", async (source) => {
    const broker = vi.fn((request: McpToolApprovalRequest) => {
      request.claim(() => "allow_for_session");
    });
    const { state, select } = createState({
      approveTools: true, decision: "Allow for session (same arguments)",
      ...(source === "broker" ? { broker } : {}),
    });
    const decisions = source === "broker" ? broker : select;
    const approve = (args: Record<string, unknown> | undefined, server = "demo", meta = tool) =>
      ensureToolCallApproved(state, server, meta, args);
    await approve({ query: "secret-canary", nested: { b: 2, a: 1 }, list: [1, 2] });
    await approve({ list: [1, 2], nested: { a: 1, b: 2 }, query: "secret-canary" });
    expect(decisions).toHaveBeenCalledTimes(1);
    await approve({ query: "delete-all", nested: { a: 1, b: 2 }, list: [1, 2] });
    await approve({ query: "secret-canary", nested: { a: 9, b: 2 }, list: [1, 2] });
    await approve({ query: "secret-canary", nested: { a: 1, b: 2 }, list: [2, 1] });
    expect(decisions).toHaveBeenCalledTimes(4);
    // Configure both servers so dialog decisions are required on each.
    state.config.mcpServers.other = { approveTools: true };
    await approve({}, "other");
    await approve({}, "demo", { ...tool, originalName: "delete-records" });
    await approve(undefined);
    await approve({ omitted: undefined });
    expect(decisions).toHaveBeenCalledTimes(7);
    expect([...state.approvedToolCalls.keys()].join()).not.toContain("secret-canary");
  });

  it("re-enters a denying broker for changed arguments after session consent", async () => {
    const broker = vi.fn((request: McpToolApprovalRequest) => {
      request.claim(() => request.args.query === "read" ? "allow_for_session" : "deny");
    });
    const { state, callTool } = createState({ broker });
    await executeCall(state, tool.name, { query: "read" });
    for (let i = 0; i < 2; i++) {
      await expect(executeCall(state, tool.name, { query: "delete" })).resolves.toMatchObject({
        details: { error: "approval_denied" },
      });
    }
    expect(callTool).toHaveBeenCalledOnce();
    expect(broker).toHaveBeenCalledTimes(3);
  });

  it("requires headless approval for changed arguments after dialog session consent", async () => {
    const { state } = createState({ approveTools: true, decision: "Allow for session (same arguments)" });
    await ensureToolCallApproved(state, "demo", tool, { query: "read" });
    state.ui = undefined;
    await expect(ensureToolCallApproved(state, "demo", tool, { query: "read" })).resolves.toEqual({ ok: true });
    await expect(ensureToolCallApproved(state, "demo", tool, { query: "delete" })).resolves.toEqual({
      ok: false, reason: "approval_required_headless",
    });
  });

  it("uses JSON wire semantics without losing special own property names", async () => {
    const { state, select } = createState({ approveTools: true, decision: "Allow for session (same arguments)" });
    const approve = (args: Record<string, unknown>) => ensureToolCallApproved(state, "demo", tool, args);
    await approve({ value: new Date("2026-01-01T00:00:00Z"), list: [undefined, NaN] });
    await approve({ list: [null, null], value: "2026-01-01T00:00:00.000Z" });
    expect(select).toHaveBeenCalledTimes(1);
    await approve(JSON.parse('{"__proto__":{"delete":false},"constructor":1}'));
    await approve(JSON.parse('{"constructor":1,"__proto__":{"delete":true}}'));
    await approve({ constructor: 1 });
    expect(select).toHaveBeenCalledTimes(4);
  });

  it.each(["broker", "dialog"])("does not cache serialization failures in the %s path", async (source) => {
    const broker = vi.fn((request: McpToolApprovalRequest) => { request.claim(() => "allow_for_session"); });
    const { state, select } = createState({ approveTools: true, decision: "Allow for session (same arguments)",
      ...(source === "broker" ? { broker } : {}),
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const args of [cyclic, { value: 1n }, { toJSON() { throw new Error("no JSON"); } }, { toJSON() { return undefined; } }]) {
      await expect(ensureToolCallApproved(state, "demo", tool, args)).resolves.toEqual({ ok: true });
    }
    expect(source === "broker" ? broker : select).toHaveBeenCalledTimes(4);
    expect(state.approvedToolCalls.size).toBe(0);
  });

  it("requires brokers to claim synchronously", async () => {
    const { state } = createState({ approveTools: true, interactive: false, broker: (request) => {
      queueMicrotask(() => request.claim(() => "allow_once"));
    } });

    await expect(ensureToolCallApproved(state, "demo", tool, {}, undefined)).resolves.toEqual({
      ok: false,
      reason: "approval_required_headless",
    });
  });

  it("fails closed when a claimed broker returns an invalid decision", async () => {
    const { state, callTool } = createState({ broker: (request) => {
      request.claim(() => undefined as never);
    } });

    await expect(executeCall(state, tool.name, {})).resolves.toMatchObject({
      details: { error: "approval_denied", server: "demo", tool: "search-records" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("fails closed when a claimed broker throws", async () => {
    const { state } = createState({ broker: (request) => {
      request.claim(() => {
        throw new Error("broker failed");
      });
    } });

    await expect(ensureToolCallApproved(state, "demo", tool, {}, undefined)).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("propagates aborts while a claimed broker is pending", async () => {
    const { state } = createState({ broker: (request) => {
      request.claim(() => new Promise(() => {}));
    } });
    const controller = new AbortController();
    const reason = new Error("broker stopped");
    reason.name = "AbortError";

    const pending = ensureToolCallApproved(state, "demo", tool, {}, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("propagates aborts while the approval dialog is open", async () => {
    const { state, select } = createState({ approveTools: true });
    select.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new Error("stopped");
    reason.name = "AbortError";

    const pending = ensureToolCallApproved(state, "demo", tool, {}, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("marks gated tools in describe and search output without hiding them", async () => {
    const { state } = createState({ approveTools: true });

    expect((await executeDescribe(state, tool.name)).content[0].text).toContain("search-records (requires approval)");
    expect(executeSearch(state, "search", false, undefined, false).content[0].text).toContain("(requires approval)");
  });
});
