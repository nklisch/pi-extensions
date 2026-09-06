import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { createMcpAdapter } from "../index.ts";
import { McpServerManager } from "../server-manager.ts";
import { computeServerHash, isServerCacheValid, loadMetadataCache, saveMetadataCache } from "../metadata-cache.ts";
import { flushMetadataCache, updateMetadataCache } from "../init.ts";

const tool = { name: "capture", description: "Fixture", inputSchema: { type: "object", properties: {} } };
const definition = { command: "never-spawned", lifecycle: "keep-alive" as const, directTools: true };
let dir: string;
let offline: boolean;
let manager: McpServerManager;
let handlers: Record<string, (...args: any[]) => Promise<any>>;
let tools: Map<string, any>;
let active: string[];
let failRemoval: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-surface-regression-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
  offline = false; handlers = {}; tools = new Map(); active = ["unrelated"]; failRemoval = false;
  vi.spyOn(McpServerManager.prototype as any, "createConnection").mockImplementation(async function(this: McpServerManager, _name, config) {
    manager = this;
    if (offline) throw new Error("fixture offline");
    return { status: "connected", definition: config, tools: [tool], resources: [], prompts: [], transport: { sessionId: "fixture" }, client: { close: async () => {}, callTool: vi.fn() }, catalogRevision: 0, catalogAcquiredAt: Date.now(), lastUsedAt: Date.now(), inFlight: 0 };
  });
});
afterEach(async () => {
  await handlers.session_shutdown?.();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function start(freezeDirectTools = false) {
  saveMetadataCache({ version: 1, servers: { demo: { configHash: computeServerHash(definition), cachedAt: Date.now(), tools: [tool], resources: [] } } });
  const pi = {
    on: (name: string, fn: any) => { handlers[name] = fn; }, events: { emit: () => {} },
    registerFlag: () => {}, getFlag: () => undefined, registerCommand: () => {},
    registerTool: (entry: any) => { tools.set(entry.name, entry); if (!active.includes(entry.name)) active.push(entry.name); },
    getAllTools: () => [...tools.values()], getActiveTools: () => active,
    setActiveTools: (next: string[]) => { if (failRemoval && !next.includes("demo_capture")) { failRemoval = false; throw new Error("host removal failed"); } active = next; },
  };
  const ctx = { hasUI: false, mode: "print", cwd: dir };
  createMcpAdapter({ config: { mcpServers: { demo: definition }, settings: { freezeDirectTools, sampling: false } } })(pi as any);
  await handlers.session_start({}, ctx);
  await tools.get("mcp").execute("status", {}, undefined, undefined, ctx);
  return ctx;
}

describe("integrated publication and recovery", () => {
  it("restores temporarily unavailable frozen specifications on automatic recovery", async () => {
    offline = true;
    const ctx = await start(true);
    expect(active).not.toContain("demo_capture");
    offline = false;
    await handlers.before_agent_start({}, ctx);
    expect(active).toContain("demo_capture");
    expect(active).toContain("unrelated");
  });

  it("retries failed host removal before acknowledging publication", async () => {
    await start();
    const connection = manager.getConnection("demo")!;
    connection.tools = []; failRemoval = true;
    await manager.publishMetadata("demo", connection, "removed");
    expect(active).toContain("demo_capture");
    expect(connection.publicationPending).toBe(true);
    await manager.publishMetadata("demo", connection, "retry");
    expect(active).not.toContain("demo_capture");
    expect(active).toContain("unrelated");
    expect(connection.publicationPending).toBe(false);
  });

  it("publishes call-triggered reconnect failure and observes the same cooldown", async () => {
    const ctx = await start();
    const connection = manager.getConnection("demo")!;
    (connection.client.callTool as any).mockRejectedValueOnce(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "expired", { status: 404 }));
    offline = true;
    const gateway = tools.get("mcp");
    await gateway.execute("call", { tool: "demo_capture", args: {} }, undefined, undefined, ctx);
    const status = await gateway.execute("status", {}, undefined, undefined, ctx);
    expect(JSON.stringify(status.content)).toContain("connection failed");
    expect(active).not.toContain("demo_capture");
    const search = await gateway.execute("search", { search: "capture" }, undefined, undefined, ctx);
    expect(JSON.stringify(search.content)).toContain("incomplete");
    const spy = vi.spyOn(manager, "connect");
    offline = false;
    await handlers.before_agent_start({}, ctx);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not renew a positive TTL during shutdown persistence", () => {
    let now = 100000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const connection = { status: "connected", tools: [tool], resources: [], prompts: [], toolListHints: { ttlMs: 1000 } };
    const state = { config: { mcpServers: { demo: definition } }, manager: { getConnection: () => connection, getAllConnections: () => new Map([["demo", connection]]) } } as any;
    updateMetadataCache(state, "demo"); now += 5000;
    flushMetadataCache(state);
    expect(isServerCacheValid(loadMetadataCache()!.servers.demo!, definition)).toBe(false);
  });
});
