import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { executeCall, executeDescribe, executeList, executeSearch, executeStatus } from "../proxy-modes.ts";
import { buildProxyDescription } from "../direct-tools.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { serializeTools, reconstructToolMetadata } from "../metadata-cache.ts";
import { runMcpScript } from "../mcp-code.ts";
import type { McpExtensionState } from "../state.ts";
const schema = { type: "object", additionalProperties: false, properties: {
  crop: { anyOf: [{ $ref: "#/$defs/Crop" }, { type: "null" }] },
  timeout: { type: "integer", description: "Milliseconds; zero disables waiting", minimum: 0, maximum: 30000, default: 1000 },
}, $defs: { Crop: { type: "object", properties: { width: { type: "integer" } }, required: ["width"] } }, examples: [{ timeout: 0 }], "x-guidance": "retain me" };
const outputSchema = { type: "object", properties: { captured: { type: "boolean" } } };
function state(): McpExtensionState {
  return { config: { mcpServers: { demo: { command: "fixture-never-spawned" }, cold: { command: "fixture-never-spawned" } } },
    toolMetadata: new Map([["demo", [{ name: "demo_capture", originalName: "capture", description: "Capture data", inputSchema: schema, outputSchema }]]]),
    serverInstructions: new Map(), failureTracker: new Map(), failureMessages: new Map(),
    manager: { getConnection: vi.fn(), isConnecting: () => false },
  } as unknown as McpExtensionState;
}
const text = (result: any) => result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
describe("agent discovery contract", () => {
  it("names cold servers without launching them and reports coverage on positive and empty searches", () => {
    const s = state();
    expect(buildProxyDescription(s.config)).toContain("demo, cold");
    expect(text(executeStatus(s))).toContain("connects automatically");
    expect(text(executeList(s, "cold"))).toContain('mcp({"connect":"cold"})');
    for (const query of ["capture", "missing"]) {
      const result = executeSearch(s, query, false, undefined, false, 1);
      expect(result.details.coverage).toMatchObject({ complete: false, omittedServers: [{ server: "cold", reason: "undiscovered" }] });
      expect(text(result)).toContain("results are incomplete");
    }
    expect(executeSearch(s, "capture", false, "absent").details.error).toBe("not_found");
  });
  it("keeps failed catalogs out of search after cooldown until recovery, but permits exact cached inspection", async () => {
    const s = state(); s.failureTracker.set("demo", Date.now() - 61000);
    expect(executeSearch(s, "capture").details.count).toBe(0);
    const result = await executeDescribe(s, "demo_capture");
    expect(text(result)).toContain("retry available");
    expect(text(result)).toContain('"x-guidance": "retain me"');
    s.failureTracker.clear();
    expect(executeSearch(s, "capture").details.count).toBe(1);
  });
  it("preserves exact input/output schemas through cache, gateway, and script descriptors", async () => {
    const s = state();
    const wire = [{ name: "capture", inputSchema: schema, outputSchema }];
    const cache = { configHash: "fixture", tools: serializeTools(wire), resources: [], cachedAt: Date.now() };
    expect(buildToolMetadata(wire, [], {}, "demo", "server").metadata[0]?.outputSchema).toEqual(outputSchema);
    s.toolMetadata.set("demo", reconstructToolMetadata("demo", cache, "server", {}));
    const result = await executeDescribe(s, "capture", "demo");
    expect(result.details.descriptor).toMatchObject({ inputSchema: schema, outputSchema });
    const script = await runMcpScript(s, 'return { description: await tools.describe({path:"demo_capture"}), search: await tools.search({query:"capture"}) };');
    expect(JSON.parse(text(script))).toMatchObject({ description: { inputSchema: schema, outputSchema }, search: { coverage: { complete: false } } });
  });
  it("spills large exact schemas completely without retaining unbounded duplicate details", async () => {
    const s = state(); const large = { ...schema, description: "important ".repeat(15000) };
    s.toolMetadata.get("demo")![0]!.inputSchema = large;
    const result = await executeDescribe(s, "demo_capture");
    expect(result.details.descriptor).toBeUndefined();
    const raw = result.details.mcpResult as any;
    expect(raw.omitted).toBe(true);
    expect(JSON.parse(await readFile(raw.fullResultPath, "utf8")).inputSchema).toEqual(large);
    expect(text(result)).toContain("Full");
  });
  it("does not resolve name collisions by ignoring the failed owner", async () => {
    const s = state(); const tool = s.toolMetadata.get("demo")![0]!;
    s.toolMetadata.set("cold", [tool]); s.failureTracker.set("demo", Date.now());
    expect((await executeDescribe(s, tool.name)).details.error).toBe("ambiguous_tool");
    expect((await executeCall(s, tool.name, {})).details.error).toBe("ambiguous_tool");
    expect((await executeDescribe(s, tool.name, "demo")).details.server).toBe("demo");
  });
});
