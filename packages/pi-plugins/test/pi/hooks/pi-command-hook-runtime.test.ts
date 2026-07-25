import { describe, expect, it, vi } from "vitest";
import { registerPiCommandHookRuntime } from "../../../src/pi/hooks/pi-command-hook-runtime.js";
import { createPiHookEventAdapter } from "../../../src/pi/hooks/pi-hook-event-adapter.js";
import { createHookEventPlanner } from "../../../src/runtime/hooks/hook-event-planner.js";
import { createStopContinuationGuard } from "../../../src/runtime/hooks/stop-continuation-guard.js";
import { createGuardedCommandHookExecutor } from "../../../src/runtime/hooks/guarded-command-executor.js";
import { createPiHookDecisionAdapter } from "../../../src/pi/hooks/pi-hook-decision-adapter.js";
import { catalog, hook, project, session, snapshot } from "../../runtime/hooks/fixtures.js";
import { fakeSettled } from "./fake-pi.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiHookDecisionAdapter } from "../../../src/pi/hooks/pi-hook-decision-adapter.js";

function fakeApi() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const api = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler)),
    sendMessage: vi.fn(),
    setSessionName: vi.fn(),
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

const ctx = {
  cwd: "/workspace/project",
  signal: undefined,
  hasUI: false,
  mode: "print",
  isProjectTrusted: () => true,
  sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/sessions/session-1.jsonl", getBranch: () => [] },
} as unknown as ExtensionContext;

const configuration = {
  has: () => false,
  substitute: (value: string) => value,
  environment: () => Object.freeze({}),
  redact: (value: string) => value,
  dispose: () => undefined,
  toString: () => "[REDACTED]",
  toJSON: () => "[REDACTED]",
};

type IdleDeliveryOptions = { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };

function stopRuntime(sendMessage: ExtensionAPI["sendMessage"], exitCode = 2) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const api = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler)),
    sendMessage,
    setSessionName: vi.fn(),
  } as unknown as ExtensionAPI;
  const events = createPiHookEventAdapter({
    catalog: catalog([snapshot({ kind: "user" }, [hook("Stop", undefined, [], "e")])]),
    currentProject: () => project,
  });
  const decisions = createPiHookDecisionAdapter({ pi: { sendMessage, setSessionName: api.setSessionName } });
  const stopInputs: Array<Record<string, unknown>> = [];
  const command = {
    run: async (request: { stdin?: AsyncIterable<Uint8Array> }) => {
      const chunks: Uint8Array[] = [];
      if (request.stdin !== undefined) for await (const chunk of request.stdin) chunks.push(chunk);
      if (chunks[0] !== undefined) stopInputs.push(JSON.parse(new TextDecoder().decode(chunks[0])) as Record<string, unknown>);
      return { exitCode, stdout: new Uint8Array(), stderr: new Uint8Array(), stderrTruncated: false };
    },
  };
  const executor = createGuardedCommandHookExecutor({
    context: {
      withContext: async (_request, _signal, use) => use({
        cwd: "/workspace/project",
        projectRoot: "/trusted/project",
        pluginRoot: "/plugin",
        pluginDataRoot: "/data",
        configuration,
      }),
    },
    executables: { resolve: async () => ({ executable: "hook", resolution: "absolute", identity: "identity" as never }) },
    command,
  });
  const continuation = createStopContinuationGuard();
  registerPiCommandHookRuntime({
    pi: api,
    events,
    executor,
    decisions,
    continuation,
    currentProject: () => project,
    runtimeSignal: new AbortController().signal,
  });
  return { handlers, continuation, stopInputs, events };
}

describe("Pi command-hook runtime registration", () => {
  it("registers only ordinary boundaries in the designed order", () => {
    const { api, handlers } = fakeApi();
    const planner = createHookEventPlanner({ catalog: catalog([]) });
    const events = createPiHookEventAdapter({ planner, currentProject: () => project });
    const decisions = {
      applyInput: vi.fn(), applyToolCall: vi.fn(), applyToolResult: vi.fn(), applyBeforeCompact: vi.fn(), applyLifecycle: vi.fn(), applyStop: vi.fn(),
    } as unknown as PiHookDecisionAdapter;
    registerPiCommandHookRuntime({
      pi: api,
      events,
      executor: { execute: vi.fn(async () => ({ kind: "completed", handlers: [] })) },
      decisions,
      continuation: createStopContinuationGuard(),
      currentProject: () => project,
      runtimeSignal: new AbortController().signal,
    });
    expect([...handlers.keys()]).toEqual(["session_start", "session_shutdown", "input", "tool_call", "tool_result", "session_before_compact", "session_compact", "agent_settled"]);
    expect(handlers.has("subagent_start")).toBe(false);
    expect(handlers.has("subagent_stop")).toBe(false);
  });

  it("executes planner plans at the callback position and returns native input handled", async () => {
    const { api, handlers } = fakeApi();
    const planner = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "user" }, [hook("UserPromptSubmit", undefined, [], "a")])]) });
    const events = createPiHookEventAdapter({ planner, currentProject: () => project });
    const applyInput = vi.fn(async () => ({ action: "handled" as const }));
    const decisions = { applyInput, applyToolCall: vi.fn(), applyToolResult: vi.fn(), applyBeforeCompact: vi.fn(), applyLifecycle: vi.fn(), applyStop: vi.fn() } as unknown as PiHookDecisionAdapter;
    const execute = vi.fn(async () => ({ kind: "completed" as const, handlers: [] }));
    registerPiCommandHookRuntime({ pi: api, events, executor: { execute }, decisions, continuation: createStopContinuationGuard(), currentProject: () => project, runtimeSignal: new AbortController().signal });
    const result = await handlers.get("input")!({ type: "input", text: "hello", source: "interactive" }, ctx);
    expect(result).toEqual({ action: "handled" });
    expect(execute).toHaveBeenCalledOnce();
    expect(applyInput).toHaveBeenCalledOnce();
  });

  it("fails open with a warning when prompt planning fails instead of eating the message", async () => {
    const { api, handlers } = fakeApi();
    const planner = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "user" }, [hook("UserPromptSubmit", undefined, [], "a")])]) });
    // Snapshot and session project evidence disagree, so planning fails.
    const mismatched = { ...project, trust: { kind: project.trust.kind === "trusted" ? "untrusted" : "trusted" } } as typeof project;
    const events = createPiHookEventAdapter({ planner, currentProject: () => mismatched });
    const execute = vi.fn(async () => ({ kind: "completed" as const, handlers: [] }));
    const decisions = { applyInput: vi.fn(), applyToolCall: vi.fn(), applyToolResult: vi.fn(), applyBeforeCompact: vi.fn(), applyLifecycle: vi.fn(), applyStop: vi.fn() } as unknown as PiHookDecisionAdapter;
    registerPiCommandHookRuntime({ pi: api, events, executor: { execute }, decisions, continuation: createStopContinuationGuard(), currentProject: () => mismatched, runtimeSignal: new AbortController().signal });
    const notify = vi.fn();
    const uiCtx = { ...ctx, hasUI: true, ui: { notify } } as unknown as ExtensionContext;
    const result = await handlers.get("input")!({ type: "input", text: "hello", source: "interactive" }, uiCtx);
    expect(result).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(decisions.applyInput).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toContain("the project changed underneath it");
    expect(notify.mock.calls[0]?.[0]).not.toContain("CURRENT_PROJECT_MISMATCH");
    expect(notify.mock.calls[0]?.[1]).toBe("warning");
  });

  it("preserves compact plan order through sequential lifecycle application", async () => {
    const { api, handlers } = fakeApi();
    const planner = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "user" }, [hook("PostCompact", "manual", [], "a"), hook("SessionStart", "compact", [], "b")])]) });
    const events = createPiHookEventAdapter({ planner, currentProject: () => project });
    const applied: string[] = [];
    const decisions = { applyInput: vi.fn(), applyToolCall: vi.fn(), applyToolResult: vi.fn(), applyBeforeCompact: vi.fn(), applyLifecycle: vi.fn(async (_ctx, value) => applied.push(value.event)), applyStop: vi.fn() } as unknown as PiHookDecisionAdapter;
    registerPiCommandHookRuntime({ pi: api, events, executor: { execute: vi.fn(async () => ({ kind: "completed" as const, handlers: [] })) }, decisions, continuation: createStopContinuationGuard(), currentProject: () => project, runtimeSignal: new AbortController().signal });
    await handlers.get("session_compact")!({ type: "session_compact", reason: "manual", willRetry: false, fromExtension: false }, ctx);
    expect(applied).toEqual(["PostCompact", "SessionStart"]);
  });

  it("uses a Pi 0.80.8 idle delivery mode that starts each guarded Stop turn", async () => {
    const turns: IdleDeliveryOptions[] = [];
    const pendingNextTurns: IdleDeliveryOptions[] = [];
    const sendMessage = vi.fn(async (_message: unknown, options?: IdleDeliveryOptions) => {
      // Pi's sendCustomMessage checks nextTurn before triggerTurn, so this
      // deliberately models the no-turn behavior of nextTurn at idle.
      if (options?.deliverAs === "nextTurn") {
        pendingNextTurns.push(options);
        return;
      }
      if (options?.triggerTurn) turns.push(options);
    });
    await sendMessage({ customType: "test", content: "ignored", display: false, details: undefined }, { triggerTurn: true, deliverAs: "nextTurn" });
    expect(turns).toEqual([]);
    expect(pendingNextTurns).toHaveLength(1);

    const runtime = stopRuntime(sendMessage as unknown as ExtensionAPI["sendMessage"]);
    const settled = runtime.handlers.get("agent_settled")!;
    const stopPlanning = runtime.events.agentSettled(fakeSettled, ctx, { stopHookActive: false });
    expect(stopPlanning).toMatchObject({ kind: "ready" });
    for (let index = 0; index < 4; index += 1) await settled(fakeSettled, ctx);

    expect(runtime.stopInputs.map((input) => input.stop_hook_active)).toEqual([false, true, true, true]);
    expect(turns).toHaveLength(3);
    expect(turns).toEqual([
      { triggerTurn: true, deliverAs: "steer" },
      { triggerTurn: true, deliverAs: "steer" },
      { triggerTurn: true, deliverAs: "steer" },
    ]);
    expect(runtime.continuation.state()).toMatchObject({ stopHookActive: true, used: 3, remaining: 0 });
  });

  it("resets Stop state when sending fails, no continuation is returned, or lifecycle/input resets it", async () => {
    const sendFailure = new Error("stale extension");
    const failedSend = vi.fn(async (_message: unknown, options?: IdleDeliveryOptions) => {
      if (options?.deliverAs === "steer") throw sendFailure;
    });
    const failed = stopRuntime(failedSend as unknown as ExtensionAPI["sendMessage"]);
    await failed.handlers.get("agent_settled")!(fakeSettled, ctx);
    expect(failed.continuation.state()).toMatchObject({ stopHookActive: false, used: 0, remaining: 3 });

    const noContinuation = stopRuntime(vi.fn() as unknown as ExtensionAPI["sendMessage"], 0);
    await noContinuation.handlers.get("agent_settled")!(fakeSettled, ctx);
    expect(noContinuation.continuation.state()).toMatchObject({ stopHookActive: false, used: 0, remaining: 3 });

    const sessionReset = stopRuntime(vi.fn() as unknown as ExtensionAPI["sendMessage"]);
    await sessionReset.handlers.get("agent_settled")!(fakeSettled, ctx);
    expect(sessionReset.continuation.state().used).toBe(1);
    await sessionReset.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(sessionReset.continuation.state()).toMatchObject({ stopHookActive: false, used: 0, remaining: 3 });

    const inputReset = stopRuntime(vi.fn() as unknown as ExtensionAPI["sendMessage"]);
    await inputReset.handlers.get("agent_settled")!(fakeSettled, ctx);
    expect(inputReset.continuation.state().used).toBe(1);
    await inputReset.handlers.get("input")!({ type: "input", text: "new input", source: "interactive" }, ctx);
    expect(inputReset.continuation.state()).toMatchObject({ stopHookActive: false, used: 0, remaining: 3 });
  });
});
