import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ mcpServers: {} })),
  loadCache: vi.fn(() => null),
}));

const managerSpies = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  closeAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: class {
    setSamplingConfig() {}
    setElicitationConfig() {}
    getConnection() { return undefined; }
    connect(...args: unknown[]) { return managerSpies.connect(...args); }
    close(...args: unknown[]) { return managerSpies.close(...args); }
    closeAll(...args: unknown[]) { return managerSpies.closeAll(...args); }
  },
}));

vi.mock("../config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.ts")>();
  return { ...actual, loadMcpConfig: spies.loadConfig };
});

vi.mock("../metadata-cache.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../metadata-cache.ts")>();
  return { ...actual, loadMetadataCache: spies.loadCache };
});

import mcpAdapter from "../index.ts";
import { createMcpAdapter } from "../programmatic.ts";

function initialSource() {
  const source = {
    schemaVersion: 1 as const,
    identity: {
      schemaVersion: 1 as const,
      scope: { kind: "user" },
      plugin: "ordering@community",
      revision: `sha256:${"1".repeat(64)}`,
      projectionDigest: `sha256:${"2".repeat(64)}`,
    },
    servers: {
      qualified: {
        componentId: `component-v1:mcp-server:${"a".repeat(64)}`,
        nativeKey: "native",
        transport: "stdio" as const,
        options: { schemaVersion: 1, auth: { kind: "none" } },
        projection: { schemaVersion: 1 },
        launchTemplate: { schemaVersion: 1, transport: "stdio", command: "template", args: [], env: [] },
        toolAliases: [],
        provenance: [{ host: "claude", documentKind: "mcp", path: "plugin.mcp.json" }],
      },
    },
  };
  const canonical = (value: any): string => value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const digest = createHash("sha256")
    .update(`mcp-source-registration-v1\0${canonical(source)}`)
    .digest("hex");
  return {
    registration: { schemaVersion: 1 as const, source, digest: `sha256:${digest}` },
    launchValues: {
      resolve: vi.fn(async () => ({ transport: "stdio" as const, command: "command", args: [] })),
      dispose: vi.fn(async () => undefined),
    },
    runtimeLeases: {
      acquire: vi.fn(async () => Object.freeze({})),
      release: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined),
    },
  };
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools: unknown[] = [];
  const api = {
    registerTool: vi.fn((tool: unknown) => tools.push(tool)),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
    getAllTools: vi.fn(() => []),
    sendMessage: vi.fn(),
  } as any;
  return { api, handlers, tools };
}

beforeEach(() => {
  spies.loadConfig.mockClear();
  spies.loadCache.mockClear();
  spies.loadConfig.mockReturnValue({ mcpServers: {} });
  spies.loadCache.mockReturnValue(null);
  managerSpies.connect.mockReset();
  managerSpies.connect.mockRejectedValue(new Error("spawn failed"));
  managerSpies.close.mockClear();
  managerSpies.closeAll.mockClear();
});

describe("programmatic adapter construction", () => {
  it("installs initial sources before tool registration without file/cache discovery", async () => {
    const initial = initialSource();
    const adapter = createMcpAdapter({ fileDiscovery: "disabled", initialSources: [initial] });
    expect(await adapter.runtime.inspectSources(new AbortController().signal))
      .toHaveLength(1);
    expect(initial.launchValues.resolve).not.toHaveBeenCalled();

    const pi = createPi();
    adapter.extension(pi.api);

    expect(spies.loadConfig).not.toHaveBeenCalled();
    expect(spies.loadCache).not.toHaveBeenCalled();
    expect(pi.api.registerTool).toHaveBeenCalledTimes(1);
    expect(pi.api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("keeps the ordinary default extension behavior unchanged", () => {
    const direct = createPi();
    mcpAdapter(direct.api);
    const directCalls = {
      config: spies.loadConfig.mock.calls.length,
      cache: spies.loadCache.mock.calls.length,
      flags: direct.api.registerFlag.mock.calls,
      commands: direct.api.registerCommand.mock.calls.map((call: unknown[]) => call[0]),
      tools: direct.api.registerTool.mock.calls.map((call: any[]) => call[0].name),
    };

    spies.loadConfig.mockClear();
    spies.loadCache.mockClear();
    const composed = createPi();
    createMcpAdapter({ fileDiscovery: "enabled" }).extension(composed.api);

    expect(spies.loadConfig).toHaveBeenCalledTimes(directCalls.config);
    expect(spies.loadCache).toHaveBeenCalledTimes(directCalls.cache);
    expect(composed.api.registerFlag.mock.calls).toEqual(directCalls.flags);
    expect(composed.api.registerCommand.mock.calls.map((call: unknown[]) => call[0]))
      .toEqual(directCalls.commands);
    expect(composed.api.registerTool.mock.calls.map((call: any[]) => call[0].name))
      .toEqual([...directCalls.tools, "mcp_sources"]);
  });

  it("renders status and capabilities as short human-readable text, never raw specs", async () => {
    const initial = initialSource();
    const adapter = createMcpAdapter({ fileDiscovery: "disabled", initialSources: [initial] });
    const pi = createPi();
    adapter.extension(pi.api);
    const tool = pi.tools[0] as { execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown }> };
    const signal = new AbortController().signal;

    const status = await tool.execute("t1", { action: "status" }, signal);
    expect(status.content[0]!.text).toContain("MCP: 0/1 servers connected");
    expect(status.content[0]!.text).toContain("qualified");
    expect(status.content[0]!.text).not.toContain('"');
    expect(status.content[0]!.text.split("\n").length).toBeLessThanOrEqual(3);

    const capabilities = await tool.execute("t2", { action: "capabilities" }, signal);
    expect(capabilities.content[0]!.text).toContain("MCP runtime ready");
    expect(capabilities.content[0]!.text).not.toContain('"');
    expect(capabilities.content[0]!.text.split("\n").length).toBeLessThanOrEqual(3);

    const identity = JSON.stringify(initial.registration.source.identity);
    const missing = await tool.execute("t3", { action: "list", source: identity, server: "unknown" }, signal);
    expect(missing.content[0]!.text).toContain("isn't registered");
    expect(missing.content[0]!.text).not.toContain('"');

    // The fake launch template spawns a nonexistent command, so the server
    // cannot start; search degrades to a short honest note, never a stack or spec.
    const search = await tool.execute("t4", { action: "search", source: identity, query: "echo" }, signal);
    expect(search.content[0]!.text).toContain("No tools matching");
    expect(search.content[0]!.text).toContain("couldn't be searched: qualified");
    expect(search.content[0]!.text.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("guards call output: truncates text, passes images through, bounds details", async () => {
    const initial = initialSource();
    const adapter = createMcpAdapter({ fileDiscovery: "disabled", initialSources: [initial] });
    const pi = createPi();
    adapter.extension(pi.api);
    await pi.handlers.get("session_start")?.({}, { cwd: process.cwd(), hasUI: false });
    const tool = pi.tools[0] as {
      execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        details: any;
      }>;
    };
    const signal = new AbortController().signal;

    // Addressed by display name (nativeKey), not the opaque mcp-server-v1 key.
    managerSpies.connect.mockResolvedValue({
      status: "connected",
      tools: [{ name: "shot" }],
      resources: [],
      client: {
        callTool: vi.fn().mockResolvedValue({
          content: [
            { type: "text", text: `capture ok\n${"x".repeat(200 * 1024)}` },
            { type: "image", data: "a".repeat(5000), mimeType: "image/png" },
          ],
        }),
      },
    });
    const big = await tool.execute("c1", { action: "call", server: "native", tool: "shot", args: "{}" }, signal);
    const text = big.content.find((block) => block.type === "text");
    const image = big.content.find((block) => block.type === "image");
    expect(text?.text).toContain("capture ok");
    expect(text?.text).toContain("[MCP text output truncated");
    expect(text?.text).toContain("Full text saved to:");
    expect(text?.text?.length).toBeLessThan(60 * 1024);
    expect(image?.data).toBe("a".repeat(5000));
    expect(image?.mimeType).toBe("image/png");
    expect(big.details.outputGuard?.truncated).toBe(true);
    // The raw result exceeds the details budget, so it is summarized with a
    // spill path instead of dumped into the session.
    expect(big.details.mcpResult?.omitted).toBe(true);
    expect(big.details.mcpResult?.fullResultPath).toBeTruthy();

    // Small results pass through unguarded in shape, with raw details kept.
    managerSpies.connect.mockResolvedValue({
      status: "connected",
      tools: [{ name: "echo" }],
      resources: [],
      client: { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) },
    });
    const small = await tool.execute("c2", { action: "call", server: "native", tool: "echo", args: "{}" }, signal);
    expect(small.content).toEqual([{ type: "text", text: "ok" }]);
    expect(small.details.mcpResult).toEqual({ content: [{ type: "text", text: "ok" }] });

    // Tool failures surface as an Error-prefixed result, not raw JSON.
    managerSpies.connect.mockResolvedValue({
      status: "connected",
      tools: [{ name: "echo" }],
      resources: [],
      client: { callTool: vi.fn().mockResolvedValue({ isError: true, content: [{ type: "text", text: "boom" }] }) },
    });
    const failed = await tool.execute("c3", { action: "call", server: "native", tool: "echo", args: "{}" }, signal);
    expect(failed.content[0]).toEqual({ type: "text", text: "Error: boom" });
    expect(failed.details.error).toBe("tool_error");

    // Unknown server names fail with guidance toward the accepted tokens.
    const unknown = await tool.execute("c4", { action: "call", server: "nope", tool: "echo", args: "{}" }, signal);
    expect(unknown.content[0]?.text).toContain("display name");
    expect(unknown.content[0]?.text).toContain("mcp-server-v1:");
  });

  it("rejects malformed initial sources before any Pi tool can be registered", () => {
    expect(() => createMcpAdapter({
      fileDiscovery: "disabled",
      initialSources: [{
        registration: { schemaVersion: 1, source: { schemaVersion: 1, identity: {}, servers: {} }, digest: "bad" },
        launchValues: { resolve: vi.fn(), dispose: vi.fn() },
        runtimeLeases: { acquire: vi.fn(), release: vi.fn(), drain: vi.fn() },
      } as any],
    })).toThrow("MCP programmatic runtime operation failed");
  });
});
