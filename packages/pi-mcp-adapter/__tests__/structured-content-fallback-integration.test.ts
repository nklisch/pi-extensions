import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { toolErrorOverride } from "../error-signal.ts";

// End-to-end coverage for the structuredContent fallback.

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
}));

function textOf(result: any): string {
  return result.content.map((c: any) => c.text ?? "").join("\n");
}

function makeState(callToolResult: unknown, toolName = "tool") {
  const connection = {
    status: "connected",
    client: { callTool: vi.fn(async () => callToolResult) },
  };
  return {
    config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
    toolMetadata: new Map([
      ["demo", [{ name: `demo_${toolName}`, originalName: toolName, description: toolName }]],
    ]),
    manager: {
      getConnection: vi.fn(() => connection),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    },
    failureTracker: new Map(),
    ui: undefined,
    completedUiSessions: [],
  } as any;
}

describe("structuredContent fallback — direct tool executor", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("surfaces structuredContent to the model when content is empty", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const structured = { status: "available", summary: "## Notes" };
    const state = makeState({ isError: false, content: [], structuredContent: structured });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "get-summary", prefixedName: "demo_get-summary", description: "Get summary" },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(textOf(result)).toBe(JSON.stringify(structured, null, 2));
    expect(textOf(result)).not.toContain("(empty result)");
  });

  it("still shows (empty result) when both content and structuredContent are empty", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const state = makeState({ isError: false, content: [] });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "noop", prefixedName: "demo_noop", description: "Noop" },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(textOf(result)).toBe("(empty result)");
  });
});

describe("structuredContent delivery with content present — direct tool executor", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("delivers structured facts alongside summary content", async () => {
    // Regression: the resolver suppressed structuredContent whenever any
    // content block existed, so these facts never reached the model.
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const structured = { pages: [{ target_id: "p1" }], correlation_id: "c-1" };
    const state = makeState({
      isError: false,
      content: [{ type: "text", text: "Captured 1 page (ok)" }],
      structuredContent: structured,
    });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "get-summary", prefixedName: "demo_get-summary", description: "Get summary" },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);
    const text = textOf(result);
    expect(text).toContain("Captured 1 page (ok)");
    expect(text).toContain('"target_id": "p1"');
    expect(text).toContain('"correlation_id": "c-1"');
  });

  it("does not repeat structured JSON the server already delivered as text", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const structured = { echoed: "same" };
    const state = makeState({
      isError: false,
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured,
    });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "echo", prefixedName: "demo_echo", description: "Echo" },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);
    expect(textOf(result)).toBe(JSON.stringify(structured));
  });

  it("delivers structured facts from error results with the error prefix intact", async () => {
    // Regression: error branches transformed raw content directly, bypassing
    // the shared resolver entirely.
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const state = makeState({
      isError: true,
      content: [{ type: "text", text: "selector did not match" }],
      structuredContent: { interaction_id: "i-9", status: "failed" },
    });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "click",
        prefixedName: "demo_click",
        description: "Click",
        inputSchema: { type: "object" },
      },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);
    const text = textOf(result);
    expect(result.details.error).toBe("tool_error");
    expect(text).toContain("Error: selector did not match");
    expect(text).toContain('"interaction_id": "i-9"');
    expect(text).toContain('"status": "failed"');
    // Details stay lean for direct tools: no raw result payload.
    expect(result.details.mcpResult).toBeUndefined();
  });

  it("keeps images native and still delivers structured facts", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const state = makeState({
      isError: false,
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      structuredContent: { correlation_id: "shot-1" },
    });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "shot", prefixedName: "demo_shot", description: "Shot" },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);
    const image = result.content.find((block: any) => block.type === "image");
    expect(image).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    expect(textOf(result)).toContain('"correlation_id": "shot-1"');
  });

  it("still shows (empty result) when both content and structuredContent are empty", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const state = makeState({ isError: false, content: [] });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "noop", prefixedName: "demo_noop", description: "Noop" },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(textOf(result)).toBe("(empty result)");
  });
});

describe("structuredContent fallback — proxy executeCall", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("surfaces structuredContent to the model when content is empty", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const structured = { status: "available", summary: "## Notes" };
    const state = makeState({ isError: false, content: [], structuredContent: structured }, "get-summary");

    const result = await executeCall(state, "demo_get-summary", {}, "demo");

    expect(textOf(result)).toContain(JSON.stringify(structured, null, 2));
    expect(textOf(result)).not.toContain("(empty result)");
  });

  it("delivers structured facts from successful results that also carry summary text", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const structured = { range_handle: "r-42", observation: "fixture-page-observation" };
    const state = makeState({
      isError: false,
      content: [{ type: "text", text: "resolved temporal range" }],
      structuredContent: structured,
    }, "resolve-range");

    const result = await executeCall(state, "demo_resolve-range", {}, "demo");

    const text = textOf(result);
    expect(text).toContain("resolved temporal range");
    expect(text).toContain('"range_handle": "r-42"');
    expect(text).toContain('"observation": "fixture-page-observation"');
    // The raw result stays available in details for renderers.
    expect(result.details.mcpResult).toEqual({
      isError: false,
      content: [{ type: "text", text: "resolved temporal range" }],
      structuredContent: structured,
    });
  });

  it("delivers structured facts from error results without changing the error envelope", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const structured = { interaction_id: "i-8", status: "failed" };
    const state = makeState({
      isError: true,
      content: [{ type: "text", text: "element not clickable" }],
      structuredContent: structured,
    }, "click");

    const result = await executeCall(state, "demo_click", {}, "demo");

    expect(result.details.error).toBe("tool_error");
    expect(result.details.tool).toBe("click");
    const text = textOf(result);
    expect(text).toContain("Error: element not clickable");
    expect(text).toContain('"interaction_id": "i-8"');
  });

  it("still shows (empty result) when both content and structuredContent are empty", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const state = makeState({ isError: false, content: [] }, "noop");

    const result = await executeCall(state, "demo_noop", {}, "demo");

    expect(textOf(result)).toContain("(empty result)");
  });
});

/**
 * Provider-boundary evidence: build the exact ToolResultMessage Pi delivers to
 * the model from an adapter tool result, then run the exported provider-input
 * construction (convertToLlm). No network request or model call is made —
 * convertToLlm is the pure message transform Pi's agent loop feeds providers.
 */
describe("provider-input construction captures", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  function toolResultMessage(result: { content: unknown[]; details: unknown }, toolName = "mcp") {
    return {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName,
      content: result.content,
      details: result.details,
      isError: toolErrorOverride(result.details)?.isError ?? false,
      timestamp: Date.now(),
    };
  }

  it("delivers structured facts in the provider input for successful calls", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const structured = { session_id: "s-1", pages: [{ target_id: "p-1" }] };
    const state = makeState({
      isError: false,
      content: [{ type: "text", text: "2 pages" }],
      structuredContent: structured,
    }, "list_pages");

    const result = await executeCall(state, "demo_list_pages", {}, "demo");
    const [providerMessage] = convertToLlm([toolResultMessage(result)]);

    const textBlocks = (providerMessage as { content: Array<{ type: string; text?: string }> }).content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    expect(textBlocks).toContain("2 pages");
    expect(textBlocks).toContain('"session_id": "s-1"');
    expect(textBlocks).toContain('"target_id": "p-1"');
  });

  it("marks failed MCP results as errors and keeps their structured facts", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const structured = { interaction_id: "i-7", status: "failed" };
    const state = makeState({
      isError: true,
      content: [{ type: "text", text: "dispatch rejected" }],
      structuredContent: structured,
    }, "click");

    const result = await executeCall(state, "demo_click", {}, "demo");
    const [providerMessage] = convertToLlm([toolResultMessage(result)]);

    expect((providerMessage as { isError: boolean }).isError).toBe(true);
    const textBlocks = (providerMessage as { content: Array<{ type: string; text?: string }> }).content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    expect(textBlocks).toContain("Error: dispatch rejected");
    expect(textBlocks).toContain('"interaction_id": "i-7"');
  });

  it("bounds oversized provider input and keeps native images out of the text stream", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const bigText = "z".repeat(200 * 1024);
    const state = makeState({
      isError: false,
      content: [
        { type: "image", data: "QQ==".repeat(2000), mimeType: "image/png" },
        { type: "text", text: `capture ok\n${bigText}` },
      ],
      structuredContent: { correlation_id: "shot-big" },
    }, "take_screenshot");

    const result = await executeCall(state, "demo_take_screenshot", {}, "demo");
    const [providerMessage] = convertToLlm([toolResultMessage(result)]);

    const content = (providerMessage as { content: Array<{ type: string; text?: string; data?: string }> }).content;
    const joinedText = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    expect(joinedText).toContain("[MCP text output truncated");
    expect(joinedText).toContain("Full MCP result (JSON) saved to:");
    expect(joinedText.length).toBeLessThan(80 * 1024);
    // Image data is delivered as native image content, never inlined as text.
    expect(joinedText).not.toContain("QQ==");
    expect(content.some((block) => block.type === "image")).toBe(true);
  });
});
