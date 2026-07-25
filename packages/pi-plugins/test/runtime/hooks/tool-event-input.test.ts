import { describe, expect, it } from "vitest";
import { buildPostToolInput, buildPreToolUseInput, subjectForTool, createHookToolIdentityResolver, evaluateHookConditions } from "../../../src/runtime/hooks/tool-event-input.js";
import { compileHookSelector } from "../../../src/domain/hook-runtime-contract.js";
import { hook, claim, session, snapshot, catalog, project } from "./fixtures.js";
import { createHookEventPlanner } from "../../../src/runtime/hooks/hook-event-planner.js";

describe("tool hook inputs", () => {
  it("captures the exact pre-tool JSON input and id without result fields", () => {
    const input = buildPreToolUseInput(session(), { toolName: "write", toolCallId: "call-1", input: { path: "a", content: "x" } });
    expect(input).toEqual(expect.objectContaining({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { path: "a", content: "x" }, tool_use_id: "call-1" }));
    expect(input).not.toHaveProperty("tool_response");
  });

  it("classifies each result from isError and preserves actual structured details", () => {
    const success = buildPostToolInput(session(), { toolName: "write", toolCallId: "call-1", input: { path: "a" }, content: [{ type: "text", text: "ok" }], details: { changed: true }, isError: false });
    expect(success).toEqual(expect.objectContaining({ hook_event_name: "PostToolUse", tool_response: { changed: true } }));
    const failure = buildPostToolInput(session(), { toolName: "write", toolCallId: "call-2", input: { path: "a" }, content: [{ type: "text", text: "denied" }], details: undefined, isError: true });
    expect(failure).toEqual(expect.objectContaining({ hook_event_name: "PostToolUseFailure", error: "denied" }));
    expect(failure).not.toHaveProperty("tool_response");
  });

  it("derives interrupts only from an actual aborted signal and omits non-JSON details", () => {
    const controller = new AbortController(); controller.abort();
    const failure = buildPostToolInput(session(), { toolName: "bash", toolCallId: "call-3", input: { command: "x" }, content: [], details: new Error("native"), isError: true, signal: controller.signal });
    expect(failure).toEqual(expect.objectContaining({ is_interrupt: true }));
    expect(failure).not.toHaveProperty("tool_response");
    expect(failure.pi).toEqual(expect.objectContaining({ toolResult: expect.objectContaining({ isError: true }) }));
  });

  it("keeps selected handlers in catalog order when tool completions are observed out of order", () => {
    const planner = createHookEventPlanner({ catalog: catalog([
      snapshot({ kind: "user" }, [hook("PostToolUse", "Write", [], "b")]),
      snapshot({ kind: "project", projectKey: project.projectKey }, [hook("PostToolUse", "Write", [], "c")], "other@community"),
    ]) });
    const result = planner.plan({ kind: "tool-result", session: session(), evidence: { toolName: "write", toolCallId: "late", input: { path: "a" }, content: [{ type: "text", text: "ok" }], isError: false } });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.plans[0]?.hooks.map((value) => value.sourceOrder.snapshotOrdinal)).toEqual([0, 1]);
  });

  it("uses the same selector compiler for alias-aware conditions", () => {
    const component = hook("PostToolUse", "Write|Edit", [{ key: "claude.hook.if", claimed: claim({ field: "tool_name", operator: "equals", value: "write" }) }]);
    const compiled = compileHookSelector(component);
    expect(compiled.kind).toBe("valid");
    if (compiled.kind === "valid") {
      const identity = createHookToolIdentityResolver({ additional: [] }).resolve("write");
      expect(evaluateHookConditions(compiled.selector, subjectForTool(identity, "PostToolUse", { path: "a" }, { changed: true }))).toBe(true);
    }
  });
});
