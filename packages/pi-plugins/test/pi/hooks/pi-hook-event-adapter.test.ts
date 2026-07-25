import { describe, expect, it, vi } from "vitest";
import { createPiHookEventAdapter } from "../../../src/pi/hooks/pi-hook-event-adapter.js";
import { createHookEventPlanner } from "../../../src/runtime/hooks/hook-event-planner.js";
import { catalog, hook, snapshot, project, session } from "../../runtime/hooks/fixtures.js";
import { fakeBeforeCompact, fakeCompact, fakeContext, fakeInput, fakeSessionEnd, fakeSessionStart, fakeSettled, fakeToolCall, fakeToolResult } from "./fake-pi.js";

function adapterWithHooks() {
  return createPiHookEventAdapter({ catalog: catalog([snapshot({ kind: "user" }, [hook("SessionStart", "startup|compact", [], "b"), hook("PostCompact", "manual", [], "c"), hook("Stop", undefined, [], "d")])]), currentProject: () => project });
}

describe("typed Pi hook event adapter", () => {
  it("maps replacement and startup reasons without registering or executing anything", () => {
    const adapter = adapterWithHooks();
    const ctx = fakeContext(project);
    expect(adapter.sessionStart(fakeSessionStart("reload"), ctx)).toMatchObject({ kind: "ready", plans: [expect.objectContaining({ input: expect.objectContaining({ source: "startup" }) })] });
    expect(adapter.sessionStart(fakeSessionStart("new"), ctx)).toMatchObject({ kind: "ready", plans: [expect.objectContaining({ input: expect.objectContaining({ source: "clear" }) })] });
    expect(adapter.sessionStart(fakeSessionStart("resume"), ctx)).toMatchObject({ kind: "ready", plans: [expect.objectContaining({ input: expect.objectContaining({ source: "resume" }) })] });
    expect(adapter.sessionStart(fakeSessionStart("fork"), ctx)).toMatchObject({ kind: "ready", plans: [expect.objectContaining({ input: expect.objectContaining({ source: "startup" }) })] });
    expect(adapter.sessionShutdown(fakeSessionEnd("reload"), ctx)).toMatchObject({ kind: "ready", plans: [expect.objectContaining({ event: "SessionEnd" })] });
  });

  it("keeps input/tool callback evidence at the extension position and preserves mutation", () => {
    const controller = new AbortController();
    const requests: unknown[] = [];
    const planner = { plan: vi.fn((request) => { requests.push(request); return { kind: "ready", plans: [] } as const; }) };
    const adapter = createPiHookEventAdapter({ planner, currentProject: () => project });
    const toolInput = { path: "file", content: "before" };
    const ctx = fakeContext(project, controller.signal);
    adapter.input(fakeInput("raw ${SKILL}"), ctx);
    adapter.toolCall(fakeToolCall(toolInput), ctx);
    adapter.toolResult(fakeToolResult(false), ctx);
    expect(toolInput).toEqual({ path: "file", content: "before" });
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ kind: "input", text: "raw ${SKILL}", signal: controller.signal });
    expect(requests[1]).toMatchObject({ kind: "tool-call", evidence: { input: toolInput, signal: controller.signal } });
    expect(requests[2]).toMatchObject({ kind: "tool-result", evidence: { isError: false, signal: controller.signal } });
  });

  it("retains dedicated compaction cancellation and emits post before compact start", () => {
    const adapter = adapterWithHooks();
    const ctx = fakeContext(project);
    const controller = new AbortController();
    const before = adapter.beforeCompact(fakeBeforeCompact(controller.signal, "overflow"), ctx);
    expect(before).toMatchObject({ kind: "ready", plans: [expect.objectContaining({ event: "PreCompact", cancellation: { kind: "available", signal: controller.signal, abortedAtPlanning: false } })] });
    const post = adapter.compact(fakeCompact("manual"), ctx);
    expect(post).toMatchObject({ kind: "ready", plans: [expect.objectContaining({ event: "PostCompact" }), expect.objectContaining({ event: "SessionStart", input: expect.objectContaining({ source: "compact" }) })] });
  });

  it("snapshots tool-result content after planning and omits opaque Pi signatures", () => {
    const adapter = adapterWithHooks();
    const source = {
      ...fakeToolResult(false),
      content: [{ type: "text", text: "ok", textSignature: "opaque-signature" }],
    };
    const result = adapter.toolResult(source, fakeContext(project));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;

    const plan = result.plans[0];
    expect(plan?.input).toMatchObject({
      pi: { toolResult: { content: [{ type: "text", text: "ok" }] } },
    });
    expect(plan?.input).not.toHaveProperty("pi.toolResult.content[0].textSignature");
    const serialized = JSON.stringify(plan);
    const plannedContent = plan?.input.pi?.toolResult?.content;
    expect(plannedContent).toBeDefined();
    expect(Object.isFrozen(plannedContent)).toBe(true);
    expect(Object.isFrozen(plannedContent?.[0])).toBe(true);

    source.content[0].text = "changed";
    source.content[0] = { type: "image", data: "replacement", mimeType: "image/png" };
    source.content.push({ type: "text", text: "appended" });

    expect(JSON.stringify(plan)).toBe(serialized);
    expect(plan?.input.pi?.toolResult?.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("normalizes text and image result items without mutating the source event", () => {
    const adapter = adapterWithHooks();
    const source = {
      ...fakeToolResult(false),
      content: [
        { type: "text", text: "ok", textSignature: "opaque-signature" },
        { type: "image", data: "base64", mimeType: "image/png", extra: "ignored" },
      ],
    };
    const result = adapter.toolResult(source, fakeContext(project));
    expect(result).toMatchObject({ kind: "ready" });
    expect(source.content).toEqual([
      { type: "text", text: "ok", textSignature: "opaque-signature" },
      { type: "image", data: "base64", mimeType: "image/png", extra: "ignored" },
    ]);
  });

  it("plans Stop only from settled and uses current branch assistant text", () => {
    const adapter = adapterWithHooks();
    const result = adapter.agentSettled(fakeSettled, fakeContext(project), { stopHookActive: false });
    expect(result).toMatchObject({ kind: "ready", plans: [expect.objectContaining({ event: "Stop", input: expect.objectContaining({ last_assistant_message: "actual answer", stop_hook_active: false, }) })] });
  });
});
