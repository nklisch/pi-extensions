import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentsService } from "@nklisch/pi-subagents";
import { afterEach, describe, expect, it, vi } from "vitest";
import productionSubagentsExtension from "../src/pi/production-subagents-extension.js";

const shutdownHandlers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(shutdownHandlers.splice(0).map((handler) => Promise.resolve(handler())));
});

describe("bundled pi-subagents consumer contract", () => {
  it("loads the production resource and exposes the joined/detached control surface", async () => {
    const toolNames: string[] = [];
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: { name: string }) => { toolNames.push(tool.name); }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: () => void | Promise<void>) => {
        if (event === "session_shutdown") shutdownHandlers.push(handler);
      }),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
      exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
      events: { emit: vi.fn() },
    } as unknown as ExtensionAPI;

    await productionSubagentsExtension(pi);

    expect(toolNames).toEqual([
      "subagent",
      "resume_subagent",
      "stop_subagent",
      "list_subagents",
      "get_subagent_result",
      "steer_subagent",
      "query_subagent_session",
    ]);
    expect(getSubagentsService()).toMatchObject({
      launch: expect.any(Function),
      resume: expect.any(Function),
      stop: expect.any(Function),
      steer: expect.any(Function),
      list: expect.any(Function),
      getResult: expect.any(Function),
    });
  });
});
