import { afterEach, describe, expect, it, vi } from "vitest";

const workerControl = vi.hoisted(() => ({
  terminateError: null as unknown,
  emitDone: true,
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      if (workerControl.emitDone) {
        queueMicrotask(() => this.emit("message", { type: "done", returnBlock: "script-result" }));
      }
    }
    postMessage(): void {}
    terminate(): Promise<number> {
      return workerControl.terminateError
        ? Promise.reject(workerControl.terminateError)
        : Promise.resolve(0);
    }
  }
  return { Worker: FakeWorker };
});

import { runMcpScript } from "../mcp-code.ts";
import { logger } from "../logger.ts";

const state = {
  owner: { signal: undefined },
  config: { settings: {} },
} as any;

afterEach(() => {
  workerControl.terminateError = null;
  workerControl.emitDone = true;
  vi.restoreAllMocks();
});

describe("runMcpScript worker termination containment", () => {
  it("preserves the script result when final worker termination rejects", async () => {
    workerControl.terminateError = new Error("worker already gone");
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    const result = await runMcpScript(state, "return 1", 1_000);

    const text = result.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n");
    expect(text).toContain("script-result");
    expect(result.details).toMatchObject({ mode: "script" });
    expect(result.details).not.toHaveProperty("error");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("termination failed"));
  });

  it("preserves the timeout outcome when termination rejects", async () => {
    workerControl.emitDone = false;
    workerControl.terminateError = new Error("worker already gone");
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    const result = await runMcpScript(state, "while (true) {}", 50);

    expect(result.details).toMatchObject({ mode: "script", error: "timeout" });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("termination failed"));
  });
});
