import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNativeControlEnvelope } from "../../src/application/native-control-contract.js";
import { createPluginManagerLifecycle } from "../../src/pi/plugin-manager-lifecycle.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const envelope = createNativeControlEnvelope({ executionId, command: "status", status: "ok" });
const report = Object.freeze({ envelope, delivery: "complete" as const, deliveredThrough: 2 });

function harness(mode: "tui" | "rpc" = "tui") {
  const handlers = new Map<string, Function[]>();
  const pi = { on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as unknown as ExtensionAPI;
  const context = {
    mode, hasUI: mode === "tui", cwd: "/workspace",
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined, getEntries: () => [] },
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  return { pi, handlers, context };
}

describe("plugin manager presentation lifecycle", () => {
  it("binds one startup context and closes presentation resources once on quit", async () => {
    const h = harness();
    const calls: string[] = [];
    const publisher = { bind: vi.fn(() => calls.push("publisher.bind")), restore: vi.fn(() => calls.push("publisher.restore")), unbind: vi.fn(() => calls.push("publisher.unbind")), close: vi.fn(async () => calls.push("publisher.close")), publish: vi.fn() };
    const manager = { bind: vi.fn(() => calls.push("manager.bind")), close: vi.fn(async () => calls.push("manager.close")), presentHandoff: vi.fn(), open: vi.fn(), presentReport: vi.fn(), dynamicCompletions: () => [] };
    const command = { register: vi.fn(), bindSession: vi.fn(() => calls.push("command.bind")), unbindSession: vi.fn(() => calls.push("command.unbind")), close: vi.fn() };
    const handoff = { claimSuccessor: vi.fn(), closeSession: vi.fn(() => calls.push("handoff.close")) };
    createPluginManagerLifecycle({ pi: h.pi, publisher: publisher as any, manager: manager as any, command: command as any, channel: { publishReport: vi.fn() } as any, handoff: handoff as any }).register();
    await h.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, h.context);
    await h.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason: "quit" }, h.context);
    expect(calls).toEqual(["publisher.bind", "publisher.restore", "manager.bind", "command.bind", "manager.close", "handoff.close", "command.unbind", "publisher.unbind", "publisher.close"]);
  });

  it("continues shutdown fan-out after an individual cleanup failure", async () => {
    const h = harness();
    const calls: string[] = [];
    const publisher = { bind: vi.fn(), restore: vi.fn(), unbind: vi.fn(() => calls.push("publisher.unbind")), close: vi.fn(async () => { calls.push("publisher.close"); throw new Error("publisher close failed"); }), publish: vi.fn() };
    const manager = { bind: vi.fn(), close: vi.fn(async () => { calls.push("manager.close"); throw new Error("manager close failed"); }), presentHandoff: vi.fn(), open: vi.fn(), presentReport: vi.fn(), dynamicCompletions: () => [] };
    const command = { register: vi.fn(), bindSession: vi.fn(), unbindSession: vi.fn(() => calls.push("command.unbind")), close: vi.fn() };
    const handoff = { claimSuccessor: vi.fn(), closeSession: vi.fn(() => calls.push("handoff.close")) };
    createPluginManagerLifecycle({ pi: h.pi, publisher: publisher as any, manager: manager as any, command: command as any, handoff: handoff as any, channel: { publishReport: vi.fn() } as any, trustReview: { review: vi.fn() } as any }).register();
    await expect(h.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason: "quit" }, h.context)).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(["manager.close", "handoff.close", "command.unbind", "publisher.unbind", "publisher.close"]);
  });

  it("contains a failure in detached trust-review notification", async () => {
    const h = harness();
    h.context.ui.notify = vi.fn(() => { throw new Error("stale UI"); });
    const lifecycle = createPluginManagerLifecycle({
      pi: h.pi,
      publisher: { bind: vi.fn(), restore: vi.fn(), unbind: vi.fn(), close: vi.fn(), publish: vi.fn() } as any,
      manager: { bind: vi.fn(), close: vi.fn(), presentHandoff: vi.fn(), open: vi.fn(), presentReport: vi.fn(), dynamicCompletions: () => [] } as any,
      command: { register: vi.fn(), bindSession: vi.fn(), unbindSession: vi.fn(), close: vi.fn() } as any,
      channel: { publishReport: vi.fn() } as any,
      handoff: { claimSuccessor: vi.fn(), closeSession: vi.fn() } as any,
      trustReview: { review: vi.fn(async () => { throw new Error("review failed"); }) } as any,
    });
    lifecycle.register();

    await h.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, h.context);
    await expect(lifecycle.idle()).resolves.toBeUndefined();
    expect(h.context.ui.notify).toHaveBeenCalledOnce();
  });

  it("claims reload result and presents it only from the fresh successor context", async () => {
    const h = harness();
    const manager = { bind: vi.fn(), close: vi.fn(), presentHandoff: vi.fn(), open: vi.fn(), presentReport: vi.fn(), dynamicCompletions: () => [] };
    const handoff = {
      claimSuccessor: vi.fn(() => ({ destination: "operation-result", result: Promise.resolve(report) })),
      closeSession: vi.fn(),
    };
    const lifecycle = createPluginManagerLifecycle({
      pi: h.pi,
      publisher: { bind: vi.fn(), restore: vi.fn(), unbind: vi.fn(), close: vi.fn(), publish: vi.fn() } as any,
      manager: manager as any,
      command: { bindSession: vi.fn(), unbindSession: vi.fn(), register: vi.fn(), close: vi.fn() } as any,
      channel: { publishReport: vi.fn() } as any,
      handoff: handoff as any,
    });
    lifecycle.register();
    await h.handlers.get("session_start")![0]!({ type: "session_start", reason: "reload" }, h.context);
    await lifecycle.idle();
    expect(handoff.claimSuccessor).toHaveBeenCalledWith({ sessionId: "s1", cwd: "/workspace" });
    expect(manager.presentHandoff).toHaveBeenCalledWith(h.context, "operation-result", envelope);
  });

  it("publishes a claimed reload report through the fresh RPC channel", async () => {
    const h = harness("rpc");
    const manager = { bind: vi.fn(), close: vi.fn(), presentHandoff: vi.fn(), open: vi.fn(), presentReport: vi.fn(), dynamicCompletions: () => [] };
    const channel = { publishReport: vi.fn() };
    const lifecycle = createPluginManagerLifecycle({
      pi: h.pi,
      publisher: { bind: vi.fn(), restore: vi.fn(), unbind: vi.fn(), close: vi.fn(), publish: vi.fn() } as any,
      manager: manager as any,
      command: { bindSession: vi.fn(), unbindSession: vi.fn(), register: vi.fn(), close: vi.fn() } as any,
      channel: channel as any,
      handoff: { claimSuccessor: vi.fn(() => ({ destination: "install-result", result: Promise.resolve(report) })), closeSession: vi.fn() } as any,
    });
    lifecycle.register();
    await h.handlers.get("session_start")![0]!({ type: "session_start", reason: "reload" }, h.context);
    await lifecycle.idle();
    expect(channel.publishReport).toHaveBeenCalledWith(h.context, report);
    expect(manager.presentHandoff).not.toHaveBeenCalled();
  });

  it.each(["new", "resume", "fork", "reload"] as const)("uses exact %s shutdown reason", async (reason) => {
    const h = harness();
    const manager = { bind: vi.fn(), close: vi.fn(), presentHandoff: vi.fn(), open: vi.fn(), presentReport: vi.fn(), dynamicCompletions: () => [] };
    const handoff = { claimSuccessor: vi.fn(), closeSession: vi.fn() };
    createPluginManagerLifecycle({
      pi: h.pi,
      publisher: { bind: vi.fn(), restore: vi.fn(), unbind: vi.fn(), close: vi.fn(), publish: vi.fn() } as any,
      manager: manager as any,
      command: { bindSession: vi.fn(), unbindSession: vi.fn(), register: vi.fn(), close: vi.fn() } as any,
      channel: { publishReport: vi.fn() } as any,
      handoff: handoff as any,
    }).register();
    await h.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason }, h.context);
    expect(manager.close).toHaveBeenCalledWith(reason);
    expect(handoff.closeSession).toHaveBeenCalledWith("s1", reason);
  });
});
