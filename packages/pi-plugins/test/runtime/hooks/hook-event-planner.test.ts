import { describe, expect, it } from "vitest";
import { createHookEventPlanner } from "../../../src/runtime/hooks/hook-event-planner.js";
import { hook, snapshot, catalog, session, project } from "./fixtures.js";
import { lifecycleIdentity, lifecyclePath } from "../../contract/subagent-lifecycle.contract.js";

describe("hook event planner", () => {
  it("selects verified hooks in catalog and declaration order", () => {
    const planner = createHookEventPlanner({ catalog: catalog([
      snapshot({ kind: "user" }, [hook("SessionStart", "startup", [], "b")]),
      snapshot({ kind: "project", projectKey: project.projectKey }, [hook("SessionStart", "startup", [], "c")], "other@community"),
    ]) });
    const result = planner.plan({ kind: "session-start", session: session(), reason: "startup" });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.plans[0]?.hooks.map((value) => value.sourceOrder)).toEqual([{ snapshotOrdinal: 0, hookOrdinal: 0 }, { snapshotOrdinal: 1, hookOrdinal: 0 }]);
  });

  it("produces ordered PostCompact and compact SessionStart plans", () => {
    const planner = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "user" }, [hook("PostCompact", "auto", [], "b"), hook("SessionStart", "compact", [], "c")])]) });
    const result = planner.plan({ kind: "compact", session: session(), reason: "threshold", willRetry: true, fromExtension: false });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.plans.map((value) => value.event)).toEqual(["PostCompact", "SessionStart"]);
    if (result.kind === "ready") expect(result.plans[1]?.input).toEqual(expect.objectContaining({ source: "compact" }));
  });

  it("fails the whole plan on project trust or selector corruption", () => {
    const untrusted = session({ piProjectTrusted: false, currentProject: { ...project, trust: { kind: "untrusted" } } });
    const trustResult = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "project", projectKey: project.projectKey }, [hook("SessionStart", "startup")], "fixture@community", untrusted.currentProject)]) }).plan({ kind: "session-start", session: untrusted, reason: "startup" });
    expect(trustResult).toMatchObject({ kind: "failed", code: "PROJECT_UNTRUSTED" });
    const corrupted = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "user" }, [hook("SessionStart", "[")])]) }).plan({ kind: "session-start", session: session(), reason: "startup" });
    expect(corrupted).toMatchObject({ kind: "failed", code: "SELECTOR_RECOMPILATION_MISMATCH" });
  });

  it("does not fabricate cancellation signals at idle and session boundaries", () => {
    const planner = createHookEventPlanner({ catalog: catalog([]) });
    const settled = planner.plan({ kind: "agent-settled", session: session(), stopHookActive: false });
    const started = planner.plan({ kind: "session-start", session: session(), reason: "startup" });
    expect(settled.kind).toBe("ready");
    expect(started.kind).toBe("ready");
    if (settled.kind === "ready") expect(settled.plans[0]?.cancellation).toEqual({ kind: "unavailable", reason: "idle-boundary" });
    if (started.kind === "ready") expect(started.plans[0]?.cancellation).toEqual({ kind: "unavailable", reason: "session-boundary" });
  });

  it("selects subagent hooks by exact agent type using the shared matcher compiler", () => {
    const planner = createHookEventPlanner({ catalog: catalog([
      snapshot({ kind: "user" }, [
        hook("SubagentStart", "reviewer|implementor", [], "b"),
        hook("SubagentStart", "other", [], "c"),
        hook("SubagentStop", "review.*", [], "d"),
      ]),
    ]) });
    const identity = lifecycleIdentity({ agentType: "reviewer", parentSessionId: session().sessionId });
    const start = planner.plan({
      kind: "subagent-start",
      session: session(),
      identity,
      execution: lifecyclePath(),
      signal: new AbortController().signal,
    });
    expect(start.kind).toBe("ready");
    if (start.kind === "ready") {
      expect(start.plans[0]?.event).toBe("SubagentStart");
      expect(start.plans[0]?.hooks).toHaveLength(1);
    }
    expect(planner.hasMatchingSubagentHooks("SubagentStart", "reviewer")).toBe(true);
    expect(planner.hasMatchingSubagentHooks("SubagentStop", "reviewer")).toBe(true);
    expect(planner.hasMatchingSubagentHooks("SubagentStop", "implementor")).toBe(false);
  });
});
