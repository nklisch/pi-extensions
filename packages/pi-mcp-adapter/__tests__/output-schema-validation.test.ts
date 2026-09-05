import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { DirectToolSpec, ToolMetadata } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const fixture = fileURLToPath(new URL("./fixtures/output-schema-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];

function createState(manager: McpServerManager, names: string[]): McpExtensionState {
  const metadata = names.map((name): ToolMetadata => ({
    name: `real_${name}`,
    originalName: name,
    description: "integration test",
    inputSchema: { type: "object" },
  }));
  return {
    manager,
    config: { settings: {}, mcpServers: { real: definition } },
    toolMetadata: new Map([["real", metadata]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    completedUiSessions: [],
    uiServer: null,
  } as McpExtensionState;
}

function directSpec(originalName: string): DirectToolSpec {
  return {
    serverName: "real",
    originalName,
    prefixedName: `real_${originalName}`,
    description: "integration test",
    inputSchema: { type: "object" },
  };
}

describe("MCP output schema validation", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  });

  it.each([
    ["draft07-valid", "proxy"],
    ["draft2020-valid", "proxy"],
    ["draft07-valid", "direct"],
    ["draft2020-valid", "direct"],
  ] as const)("accepts valid %s output through the %s path", async (name, path) => {
    const manager = new McpServerManager();
    await manager.connect("real", definition);
    managers.push(manager);
    const state = createState(manager, [name]);

    const result = path === "proxy"
      ? await executeCall(state, `real_${name}`, {})
      : await createDirectToolExecutor(() => state, () => null, directSpec(name))("id", {});

    expect(result.details).not.toMatchObject({ error: "call_failed" });
    // The server's text summary stays first; the validated structuredContent
    // facts are delivered alongside it instead of being suppressed.
    expect(result.content[0]).toMatchObject({ type: "text", text: name });
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(text).toContain('"values"');
    expect(text).toContain('"ok"');
  });

  it.each([
    ["draft07-invalid", "proxy"],
    ["draft2020-invalid", "proxy"],
    ["draft07-invalid", "direct"],
    ["draft2020-invalid", "direct"],
  ] as const)("rejects invalid %s output through the %s path", async (name, path) => {
    const manager = new McpServerManager();
    await manager.connect("real", definition);
    managers.push(manager);
    const state = createState(manager, [name]);

    const result = path === "proxy"
      ? await executeCall(state, `real_${name}`, {})
      : await createDirectToolExecutor(() => state, () => null, directSpec(name))("id", {});

    expect(result.details).toMatchObject({ error: "call_failed" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Structured content does not match the tool's output schema"),
    });
  });

  it.each(["proxy", "direct"] as const)("keeps oversized schema guidance recoverable through the %s path", async (path) => {
    const manager = new McpServerManager();
    await manager.connect("real", definition);
    managers.push(manager);
    // The schema suffix is built from the registered metadata; the canary in
    // its description is adapter-appended guidance the raw result cannot hold.
    const canarySchema = {
      type: "object",
      properties: { mode: { type: "string", description: "EXPECTED-SCHEMA-CANARY guidance" } },
    };
    const metadata: ToolMetadata = {
      name: "real_flood-error",
      originalName: "flood-error",
      description: "integration test",
      inputSchema: canarySchema,
    };
    const state = {
      ...createState(manager, []),
      toolMetadata: new Map([["real", [metadata]]]),
    } as McpExtensionState;

    const result = path === "proxy"
      ? await executeCall(state, "real_flood-error", {})
      : await createDirectToolExecutor(
          () => state,
          () => null,
          { serverName: "real", originalName: "flood-error", prefixedName: "real_flood-error", description: "integration test", inputSchema: canarySchema },
        )("id", {});

    expect(result.details).toMatchObject({ error: "tool_error" });
    const returnedText = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(returnedText).toContain("MCP text output truncated");
    expect(returnedText.length).toBeLessThan(60_000);

    // Composed-text spill holds the affixed guidance and the full flood text.
    const textSpillPath = (result.details.outputGuard as { fullOutputPath?: string }).fullOutputPath;
    expect(textSpillPath).toBeTruthy();
    const savedText = await readFile(textSpillPath!, "utf8");
    expect(savedText).toContain("EXPECTED-SCHEMA-CANARY");
    expect(savedText).toContain("flood ");
    if (path === "proxy") {
      // The proxy carries the raw result in details, so its canonical spill
      // exists too — a distinct artifact from the composed-text spill.
      const rawSpillPath = (result.details.mcpResult as { fullResultPath?: string }).fullResultPath;
      expect(rawSpillPath).toBeTruthy();
      expect(rawSpillPath).not.toBe(textSpillPath);
    } else {
      // Direct tools keep lean details and never carry a raw result payload.
      expect(result.details.mcpResult).toBeUndefined();
    }
  });
});
