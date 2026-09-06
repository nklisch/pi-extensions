import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";
import { runMcpScript } from "../mcp-code.ts";

// Exercise the installed SDK's subscription signal lifetime. The transport
// acknowledges subscriptions locally; it never opens a socket or reads secrets.
function fixture() {
  const client: any = new Client({ name: "listen-fixture", version: "1" });
  client._negotiatedProtocolVersion = "2026-07-28";
  const send = vi.fn(async (message: any) => {
    if (message.method === "subscriptions/listen") client._listenState.get(message.id).settle({ ack: { toolsListChanged: true } });
  });
  Object.defineProperty(client, "transport", { value: { send, close: async () => {} } });
  client.getServerCapabilities = () => ({ tools: { listChanged: true } });
  client.callTool = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
  const manager = new McpServerManager();
  const connection: any = { status: "connected", definition: { url: "https://example.test/mcp", auth: false }, client, tools: [{ name: "capture", inputSchema: { type: "object" } }], resources: [], prompts: [], listenState: "dropped", lastUsedAt: Date.now(), inFlight: 0 };
  (manager as any).connections.set("demo", connection);
  return { manager, connection, send };
}

describe("adopted subscriptions belong to the runtime", () => {
  it("survives caller cancellation after acknowledgment", async () => {
    const { manager, connection, send } = fixture();
    try {
      const caller = new AbortController();
      await manager.ensureListen("demo", connection, caller.signal);
      caller.abort();
      await Promise.resolve(); await Promise.resolve();
      await manager.ensureListen("demo", connection);
      expect(connection.listenState).toBe("active");
      expect(connection.listenStopped).not.toBe(true);
      expect(send.mock.calls.filter(([message]) => message.method === "subscriptions/listen")).toHaveLength(1);
    } finally { await manager.closeAll(); }
  });

  it("survives normal script completion cleanup", async () => {
    const { manager, connection } = fixture();
    const state = { manager, config: { mcpServers: { demo: connection.definition } }, toolMetadata: new Map([["demo", [{ name: "demo_capture", originalName: "capture", description: "Capture", inputSchema: { type: "object" } }]]]), failureTracker: new Map(), failureMessages: new Map(), approvedToolCalls: new Map() } as any;
    try {
      const result = await runMcpScript(state, 'return await tools.call("demo_capture", {})');
      expect(JSON.stringify(result.content)).toContain("done");
      await Promise.resolve(); await Promise.resolve();
      expect(connection.listenState).toBe("active");
      expect(connection.listenStopped).not.toBe(true);
    } finally { await manager.closeAll(); }
  });
});
