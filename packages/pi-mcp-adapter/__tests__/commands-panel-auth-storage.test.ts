import { afterEach, describe, expect, it, vi } from "vitest";
import { openMcpAuthPanel, openMcpPanel } from "../commands.ts";

vi.mock("../mcp-auth-flow.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../mcp-auth-flow.ts")>(),
  authenticate: vi.fn(async () => "failed"),
}));

const previousAuthStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;

afterEach(() => {
  if (previousAuthStore === undefined) delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
  else process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previousAuthStore;
});

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function createPanelHarness() {
  let rendered = "";
  const ui = {
    notify: vi.fn(),
    custom: vi.fn((factory: any) => {
      const panel = factory({ requestRender() {} }, undefined, undefined, () => {});
      rendered = stripAnsi(panel.render(100).join("\n"));
      panel.handleInput("\x03");
    }),
  };
  return { ui, getRendered: () => rendered };
}

function createState() {
  return {
    programmaticConfig: false,
    config: {
      mcpServers: {
        oauth: { url: "https://example.test/mcp", auth: "oauth" },
      },
    },
    authStorageOptions: {},
    manager: { getConnection: () => undefined },
    failureTracker: new Map(),
    failureMessages: new Map(),
  } as any;
}

describe("MCP panels with unavailable OAuth credential storage", () => {
  it.each([
    ["/mcp", openMcpPanel],
    ["/mcp-auth", openMcpAuthPanel],
  ])("opens %s without throwing and presents the failure reason", async (_command, openPanel) => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    const { ui, getRendered } = createPanelHarness();

    await expect(openPanel(
      createState(),
      { getFlag: () => undefined } as any,
      { hasUI: true, cwd: "/tmp", ui } as any,
    )).resolves.toEqual({ configChanged: false });

    expect(getRendered()).toContain("failed");
    expect(getRendered()).not.toContain("needs auth");
    expect(getRendered()).toContain("OAuth credential store unavailable");
  });
});


it("hides and restores the picker around nested authentication input", async () => {
  process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
  let panel: any;
  const hidden = vi.fn();
  const ui = {
    notify: vi.fn(), setStatus: vi.fn(),
    custom: vi.fn((factory, options) => {
      options.onHandle({ setHidden: hidden });
      panel = factory({ requestRender() {} }, undefined, undefined, () => {});
    }),
  };
  const opening = openMcpAuthPanel(createState(), { getFlag: () => undefined } as any, { hasUI: true, cwd: "/tmp", ui } as any);
  await vi.waitFor(() => expect(panel).toBeDefined());
  panel.handleInput("\x01");
  await vi.waitFor(() => expect(hidden.mock.calls).toEqual([[true], [false]]));
  panel.handleInput("\x03");
  await opening;
});
