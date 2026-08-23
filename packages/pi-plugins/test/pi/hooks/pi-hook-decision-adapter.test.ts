import { describe, expect, it, vi } from "vitest";
import { createPiHookDecisionAdapter } from "../../../src/pi/hooks/pi-hook-decision-adapter.js";
import { createStopContinuationGuard } from "../../../src/runtime/hooks/stop-continuation-guard.js";
import type { AggregatedHookDecision, HookContextContribution } from "../../../src/domain/hook-output-contract.js";
import type { HookContextVisibility } from "../../../src/domain/hook-visibility.js";
import type { ExtensionContext, InputEvent, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

function value(event: AggregatedHookDecision["event"], extra: Partial<AggregatedHookDecision> = {}): AggregatedHookDecision {
  return { event, contexts: [], systemMessages: [], diagnostics: [], ...extra } as AggregatedHookDecision;
}

function contribution(text: string, plugin = "demo@market"): HookContextContribution {
  return Object.freeze({ text, plugin: plugin as never });
}

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: { confirm: vi.fn(async () => true), notify: vi.fn() },
    ...overrides,
  } as unknown as ExtensionContext;
}

function harness(visibility: HookContextVisibility = "line") {
  const sendMessage = vi.fn();
  const setSessionName = vi.fn();
  const registerMessageRenderer = vi.fn();
  const adapter = createPiHookDecisionAdapter({
    pi: { sendMessage, setSessionName, registerMessageRenderer },
    visibility: async () => visibility,
  });
  return { adapter, sendMessage, setSessionName, registerMessageRenderer };
}

describe("Pi hook decision adapter", () => {
  it("registers the transcript renderer for its context message type", () => {
    const { registerMessageRenderer } = harness();
    expect(registerMessageRenderer).toHaveBeenCalledWith("pi-plugin-host.hook-context-v1", expect.any(Function));
  });

  it("mutates tool input in place while replacing stale keys", async () => {
    const { adapter, sendMessage, setSessionName } = harness();
    const input = { stale: true, value: "old" };
    const event = { type: "tool_call", toolName: "write", toolCallId: "tool", input } as ToolCallEvent;
    const result = await adapter.applyToolCall(event, context(), value("PreToolUse", {
      contexts: [contribution("safe context")],
      title: "Session title",
      updatedInput: { value: "new" },
    }));
    expect(result).toBeUndefined();
    expect(event.input).toBe(input);
    expect(input).toEqual({ value: "new" });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "pi-plugin-host.hook-context-v1",
      content: "safe context",
      display: true,
      details: { plugin: "demo@market", event: "PreToolUse", presentation: "line" },
    }), { deliverAs: "steer" });
    expect(setSessionName).toHaveBeenCalledWith("Session title");
  });

  it("hides model-bound context from the transcript when visibility is hidden", async () => {
    const { adapter, sendMessage } = harness("hidden");
    const result = await adapter.applyInput(
      { type: "input", text: "hello", source: "interactive" } as InputEvent,
      context(),
      value("UserPromptSubmit", { contexts: [contribution("secret sauce")] }),
    );
    expect(result).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: false }), { deliverAs: "nextTurn" });
  });

  it("marks context full-presentation when visibility is full", async () => {
    const { adapter, sendMessage } = harness("full");
    await adapter.applyInput(
      { type: "input", text: "hello", source: "interactive" } as InputEvent,
      context(),
      value("UserPromptSubmit", { contexts: [contribution("everything")] }),
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      display: true,
      details: { plugin: "demo@market", event: "UserPromptSubmit", presentation: "full" },
    }), { deliverAs: "nextTurn" });
  });

  it("degrades to the default visibility when the preference read fails", async () => {
    const sendMessage = vi.fn();
    const adapter = createPiHookDecisionAdapter({
      pi: { sendMessage, setSessionName: vi.fn(), registerMessageRenderer: vi.fn() },
      visibility: async () => { throw new Error("state unreadable"); },
    });
    await adapter.applyInput(
      { type: "input", text: "hello", source: "interactive" } as InputEvent,
      context(),
      value("UserPromptSubmit", { contexts: [contribution("still delivered")] }),
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: true }), { deliverAs: "nextTurn" });
  });

  it("never reads the preference when no context was injected", async () => {
    const visibility = vi.fn(async () => "line" as const);
    const sendMessage = vi.fn();
    const adapter = createPiHookDecisionAdapter({
      pi: { sendMessage, setSessionName: vi.fn(), registerMessageRenderer: vi.fn() },
      visibility,
    });
    await adapter.applyInput(
      { type: "input", text: "hello", source: "interactive" } as InputEvent,
      context(),
      value("UserPromptSubmit"),
    );
    expect(visibility).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps applying behavioral decisions and records presentation sink failures", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { adapter, sendMessage, setSessionName } = harness();
    sendMessage.mockRejectedValue(new Error("stale message sink"));
    setSessionName.mockImplementation(() => { throw new Error("stale title sink"); });
    const input = { stale: true, value: "old" };
    const notify = vi.fn(() => { throw new Error("stale UI"); });
    const event = { type: "tool_call", toolName: "write", toolCallId: "tool", input } as ToolCallEvent;
    await expect(adapter.applyToolCall(event, context({ ui: { notify, confirm: vi.fn(async () => true) } as never }), value("PreToolUse", {
      contexts: [contribution("context")],
      systemMessages: ["system message"],
      title: "Session title",
      updatedInput: { value: "new" },
      diagnostics: [{ code: "HOOK_TIMEOUT", severity: "error", event: "PreToolUse", plugin: "demo@catalog", componentId: "component-v1:hook:1111111111111111111111111111111111111111111111111111111111111111", sourceOrder: { snapshotOrdinal: 0, hookOrdinal: 0 }, message: "safe" }],
    }))).resolves.toBeUndefined();
    await Promise.resolve();
    expect(input).toEqual({ value: "new" });
    expect(notify).toHaveBeenCalled();
    expect(diagnostic.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      expect.stringContaining("hook context delivery failed: stale message sink"),
      expect.stringContaining("hook session title failed: stale title sink"),
      expect.stringContaining("hook system-message notification failed: stale UI"),
      expect.stringContaining("hook failure notification failed: stale UI"),
    ]));
    diagnostic.mockRestore();
  });

  it("asks once with fixed safe text and denies unavailable UI", async () => {
    const confirm = vi.fn(async () => false);
    const { adapter } = harness();
    const event = { type: "tool_call", toolName: "write", toolCallId: "tool", input: { path: "x" } } as ToolCallEvent;
    const result = await adapter.applyToolCall(event, context({ ui: { confirm } as never }), value("PreToolUse", { permission: { kind: "ask", reason: "CANARY" } }));
    expect(result).toEqual({ block: true, reason: "Hook permission was not approved" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).not.toContain("CANARY");
    const print = await adapter.applyToolCall(event, context({ mode: "print", hasUI: false }), value("PreToolUse", { permission: { kind: "ask" } }));
    expect(print).toEqual({ block: true, reason: "Hook permission was not approved" });
  });

  it("rewrites only JSON tool details and preserves content/error fields", async () => {
    const { adapter } = harness();
    const event = { type: "tool_result", toolName: "write", toolCallId: "tool", input: {}, content: [{ type: "text", text: "original" }], details: { old: true }, isError: true } as ToolResultEvent;
    const result = await adapter.applyToolResult(event, context(), value("PostToolUse", { updatedToolOutput: { new: true } }));
    expect(result).toEqual({ details: { new: true } });
    expect(event.content).toEqual([{ type: "text", text: "original" }]);
    expect(event.isError).toBe(true);
  });

  it("lets prompts through with a warning when prompt hook execution fails", async () => {
    const notify = vi.fn();
    const { adapter, sendMessage } = harness();
    const event = { type: "input", text: "hello", source: "interactive" } as InputEvent;
    const result = await adapter.applyInput(event, context({ ui: { notify } as never }), value("UserPromptSubmit", {
      contexts: [contribution("healthy hook context")],
      diagnostics: [{ code: "HOOK_TIMEOUT", severity: "error", event: "UserPromptSubmit", plugin: "demo@catalog", componentId: "component-v1:hook:1111111111111111111111111111111111111111111111111111111111111111", sourceOrder: { snapshotOrdinal: 0, hookOrdinal: 0 }, message: "safe" }],
    }));
    expect(result).toBeUndefined();
    // Healthy hook output still lands; only the failure is downgraded to a warning.
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toContain("it took too long");
    expect(notify.mock.calls[0]?.[0]).not.toContain("HOOK_TIMEOUT");
    expect(notify.mock.calls[0]?.[1]).toBe("warning");
  });

  it("still holds prompts back only on explicit hook block decisions", async () => {
    const { adapter } = harness();
    const event = { type: "input", text: "hello", source: "interactive" } as InputEvent;
    const result = await adapter.applyInput(event, context(), value("UserPromptSubmit", { block: { reason: "not allowed" } }));
    expect(result).toEqual({ action: "handled" });
  });

  it("allows compaction with a warning when compact hooks fail", async () => {
    const notify = vi.fn();
    const { adapter, sendMessage } = harness();
    const result = await adapter.applyBeforeCompact(context({ ui: { notify } as never }), value("PreCompact", {
      contexts: [contribution("healthy hook context")],
      diagnostics: [{ code: "HOOK_INVALID_OUTPUT", severity: "error", event: "PreCompact", plugin: "demo@catalog", componentId: "component-v1:hook:1111111111111111111111111111111111111111111111111111111111111111", sourceOrder: { snapshotOrdinal: 0, hookOrdinal: 0 }, message: "safe" }],
    }));
    expect(result).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toContain("unexpected response");
    expect(notify.mock.calls[0]?.[0]).not.toContain("HOOK_INVALID_OUTPUT");
  });

  it("still cancels compaction on explicit hook block decisions", async () => {
    const { adapter } = harness();
    const result = await adapter.applyBeforeCompact(context(), value("PreCompact", { block: { reason: "not yet" } }));
    expect(result).toEqual({ cancel: true });
  });
});

describe("Stop continuation guard", () => {
  it("allows exactly three bounded continuations and resets safely", () => {
    const guard = createStopContinuationGuard();
    expect(guard.state()).toMatchObject({ stopHookActive: false, used: 0, remaining: 3 });
    expect(guard.request()).toBe("allowed");
    expect(guard.request()).toBe("allowed");
    expect(guard.request()).toBe("allowed");
    expect(guard.request()).toBe("exhausted");
    expect(guard.state()).toMatchObject({ stopHookActive: true, used: 3, remaining: 0 });
    guard.settleWithoutContinuation();
    expect(guard.state()).toMatchObject({ stopHookActive: false, used: 0, remaining: 3 });
  });
});
