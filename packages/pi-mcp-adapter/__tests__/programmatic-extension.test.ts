import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

let savedAgentDir: string | undefined;

beforeEach(() => {
  // The runtime's discovery inventory persists under the agent dir; keep
  // every test's cache writes inside a throwaway dir.
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
  spies.loadConfig.mockClear();
  spies.loadCache.mockClear();
  spies.loadConfig.mockReturnValue({ mcpServers: {} });
  spies.loadCache.mockReturnValue(null);
  managerSpies.connect.mockReset();
  managerSpies.connect.mockRejectedValue(new Error("spawn failed"));
  managerSpies.close.mockClear();
  managerSpies.closeAll.mockClear();
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
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

describe("programmatic gateway discovery", () => {
  type ExecutedTool = {
    execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
      content: Array<{ type: string; text?: string }>;
      details: any;
    }>;
  };

  function connectedWith(tools: unknown[], callToolImpl?: () => Promise<unknown>) {
    managerSpies.connect.mockResolvedValue({
      status: "connected",
      tools,
      resources: [],
      client: {
        callTool: callToolImpl ?? vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      },
    });
  }

  async function startedAdapter(initial = initialSource()) {
    const adapter = createMcpAdapter({ fileDiscovery: "disabled", initialSources: [initial] });
    const pi = createPi();
    adapter.extension(pi.api);
    await pi.handlers.get("session_start")?.({}, { cwd: process.cwd(), hasUI: false });
    return { adapter, pi, tool: pi.tools[0] as ExecutedTool };
  }

  const echoSchema = {
    type: "object",
    properties: { locator: { oneOf: [{ kind: { const: "element" } }, { kind: { const: "coordinate" } }] } },
    required: ["locator"],
  };

  it("registers explicit discovery guidance naming the gateway tool", () => {
    const adapter = createMcpAdapter({ fileDiscovery: "disabled", initialSources: [initialSource()] });
    const pi = createPi();
    adapter.extension(pi.api);
    const definition = pi.tools[0] as { promptGuidelines?: string[] };
    expect(definition.promptGuidelines).toHaveLength(2);
    expect(definition.promptGuidelines![0]).toContain('mcp({action:"schema"');
    expect(definition.promptGuidelines![1]).toContain('mcp({action:"search"');
    const renderers = pi.tools[0] as { renderCall?: unknown; renderResult?: unknown };
    expect(typeof renderers.renderCall).toBe("function");
    expect(typeof renderers.renderResult).toBe("function");
  });

  it("serves batched raw schemas in one call and reports missing tools", async () => {
    const { tool } = await startedAdapter();
    connectedWith([
      { name: "echo", description: "Echo back the input.", inputSchema: echoSchema },
      { name: "shot", description: "Take a screenshot.", inputSchema: { type: "object", properties: {} } },
    ]);
    const signal = new AbortController().signal;
    const result = await tool.execute("s1", { action: "schema", server: "native", tool: ["echo", "nope"] }, signal);
    const text = result.content[0]!.text!;
    expect(text).toContain("### echo (native)");
    expect(text).toContain("Echo back the input.");
    expect(text).toContain('"oneOf"');
    expect(text).toContain('"const": "element"');
    expect(text).toContain("Not found on native: nope");
    expect(result.details.mode).toBe("schema");
    expect(result.details.tools).toEqual(["echo"]);
    expect(result.details.missing).toEqual(["nope"]);
    // One server launch served the whole batch.
    expect(managerSpies.connect).toHaveBeenCalledTimes(1);
  });

  it("appends the exact input schema to tool errors without another launch", async () => {
    const { tool } = await startedAdapter();
    connectedWith(
      [{ name: "echo", description: "Echo.", inputSchema: echoSchema }],
      vi.fn().mockResolvedValue({ isError: true, content: [{ type: "text", text: "missing field `locator`" }] }),
    );
    const signal = new AbortController().signal;
    const result = await tool.execute("e1", { action: "call", server: "native", tool: "echo", args: "{}" }, signal);
    const text = result.content[0]!.text!;
    expect(text).toContain("Error: missing field `locator`");
    expect(text).toContain("Input schema for echo:");
    expect(text).toContain('"const": "element"');
    expect(managerSpies.connect).toHaveBeenCalledTimes(1);
  });

  it("rejects an array of tools for call — batching belongs to the schema action", async () => {
    const { tool } = await startedAdapter();
    const result = await tool.execute("e2", { action: "call", server: "native", tool: ["echo"] }, new AbortController().signal);
    expect(result.content[0]!.text).toContain("single tool name");
  });

  it("renders the warmed tool-name inventory in the system prompt block", async () => {
    const { pi, tool } = await startedAdapter();
    connectedWith([
      { name: "echo", description: "Echo." },
      { name: "shot", description: "Screenshot." },
    ]);
    await tool.execute("l1", { action: "list", server: "native" }, new AbortController().signal);

    const handler = pi.handlers.get("before_agent_start")!;
    const result = await handler({ systemPrompt: "BASE" });
    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("## MCP servers available through the `mcp` tool");
    expect(result.systemPrompt).toContain("native (2 tools): echo, shot");
    expect(result.systemPrompt).toContain('mcp({action:"schema",server:"<server>",tool:["<name>",...]})');
  });

  it("marks never-reached servers as not yet enumerated instead of launching them", async () => {
    const { pi } = await startedAdapter();
    const handler = pi.handlers.get("before_agent_start")!;
    const result = await handler({ systemPrompt: "BASE" });
    expect(result.systemPrompt).toContain("native — tools not yet enumerated");
    expect(result.systemPrompt).toContain('mcp({action:"list",server:"native"})');
    expect(managerSpies.connect).not.toHaveBeenCalled();
  });

  it("serves the inventory from the persisted cache in a fresh runtime", async () => {
    const initial = initialSource();
    const first = await startedAdapter(initial);
    connectedWith([{ name: "echo", description: "Echo." }]);
    await first.tool.execute("l1", { action: "list", server: "native" }, new AbortController().signal);
    const launchesDuringWarm = managerSpies.connect.mock.calls.length;

    // A second runtime over the same source (new session) sees the names
    // without any server launch — the cache is keyed by the exact identity.
    const second = await startedAdapter(initial);
    const result = await second.pi.handlers.get("before_agent_start")!({ systemPrompt: "BASE" });
    expect(result.systemPrompt).toContain("native (1 tools): echo");
    expect(managerSpies.connect.mock.calls.length).toBe(launchesDuringWarm);
  });

  it("collapses very large servers behind list instead of flooding the prompt", async () => {
    const { pi, tool } = await startedAdapter();
    const manyTools = Array.from({ length: 60 }, (_, index) => ({ name: `tool_${index}` }));
    connectedWith(manyTools);
    await tool.execute("l1", { action: "list", server: "native" }, new AbortController().signal);

    const result = await pi.handlers.get("before_agent_start")!({ systemPrompt: "BASE" });
    expect(result.systemPrompt).toContain("native — 60 tools; run mcp({action:\"list\",server:\"native\"}) to enumerate");
    expect(result.systemPrompt).not.toContain("tool_59");
  });

  it("injects nothing when no sources are registered", async () => {
    const adapter = createMcpAdapter({ fileDiscovery: "disabled" });
    const pi = createPi();
    adapter.extension(pi.api);
    const result = await pi.handlers.get("before_agent_start")!({ systemPrompt: "BASE" });
    expect(result).toBeUndefined();
  });
});
