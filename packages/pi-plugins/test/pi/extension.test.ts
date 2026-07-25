import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../src/pi/extension.js";

describe("packaged Pi extension factory", () => {
  it("constructs one host, isolated MCP gateway, /plugin command, and presentation lifecycle", async () => {
    const events: string[] = [];
    const commands: string[] = [];
    const pi = {
      on(name: string, _handler: Function) { events.push(name); },
      registerCommand(name: string) { commands.push(name); },
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      appendEntry: vi.fn(),
      getCommands: () => [],
      sendMessage: vi.fn(),
      setSessionName: vi.fn(),
    } as unknown as ExtensionAPI;
    await extension(pi);
    expect(commands).toEqual(["plugin"]);
    expect((pi as any).registerTool).toHaveBeenCalledOnce();
    expect((pi as any).registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
    expect((pi as any).registerShortcut).not.toHaveBeenCalled();
    expect(events.filter((name) => name === "session_start")).toHaveLength(3);
    expect(events.filter((name) => name === "session_shutdown")).toHaveLength(3);
    expect(events.filter((name) => name === "resources_discover")).toHaveLength(1);
  });
});
