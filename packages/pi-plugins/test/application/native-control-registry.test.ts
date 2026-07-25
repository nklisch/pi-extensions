import { describe, expect, it, vi } from "vitest";
import {
  NativeControlCommandRegistry,
  NativeControlCommandSchema,
  nativeControlCommandIds,
} from "../../src/application/native-control-registry.js";
import { createNativeControlHandlerMap } from "../../src/application/native-control-dispatcher.js";

describe("native control registry", () => {
  it("owns one unique canonical path and complete command metadata", () => {
    const ids = nativeControlCommandIds();
    expect(ids).toHaveLength(33);
    expect(new Set(ids).size).toBe(ids.length);
    const paths = ids.map((id) => NativeControlCommandRegistry[id].path.join(" "));
    expect(new Set(paths).size).toBe(paths.length);
    for (const definition of Object.values(NativeControlCommandRegistry)) {
      expect(definition.request).toBeDefined();
      expect(definition.response).toBeDefined();
      expect(definition.projectedResponse).toBeDefined();
      expect(definition.safety).toMatch(/^(pure|local-read|remote-read|mutation|operation-control)$/);
      expect(definition.input).toMatch(/^(none|confirmation|configuration|decision)$/);
    }
  });

  it("routes every registry command through one exhaustive handler map", async () => {
    const read = vi.fn(async () => ({ status: "ok", diagnostics: [], human: [] }));
    const mutation = vi.fn(async () => ({ status: "ok", diagnostics: [], human: [] }));
    const handlers = createNativeControlHandlerMap({
      read: { dispatch: read },
      mutation: { dispatch: mutation },
    });
    expect(Object.keys(handlers).sort()).toEqual([...nativeControlCommandIds()].sort());
    const context = {
      executionId: "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000",
      input: { collect: vi.fn() },
      progress: { trusted: vi.fn(), lifecycle: vi.fn(), emit: vi.fn() },
      readiness: { status: "ready" },
    } as never;
    for (const id of nativeControlCommandIds()) {
      await handlers[id]({ command: id } as never, context, new AbortController().signal);
    }
    const mutationCount = nativeControlCommandIds().filter((id) => NativeControlCommandRegistry[id].safety === "mutation").length;
    expect(mutation).toHaveBeenCalledTimes(mutationCount);
    expect(read).toHaveBeenCalledTimes(nativeControlCommandIds().length - mutationCount);
  });

  it("derives direct command validation from request schemas", () => {
    expect(NativeControlCommandSchema.parse({
      command: "marketplace.list",
      request: { limit: 50 },
      invocation: { grammarVersion: "plugin-control/v1", output: "json", nonInteractive: true, input: { kind: "none" } },
    })).toMatchObject({ command: "marketplace.list", request: { limit: 50 } });
    expect(() => NativeControlCommandSchema.parse({
      command: "marketplace.list",
      request: { limit: 50, secret: "canary" },
      invocation: { grammarVersion: "plugin-control/v1", output: "json", nonInteractive: true, input: { kind: "none" } },
    })).toThrow();
  });
});
