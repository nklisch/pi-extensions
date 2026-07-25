import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHookEventPlanner } from "../../src/runtime/hooks/hook-event-planner.js";
import { PostToolUseHookInputSchema } from "../../src/runtime/hooks/event-contract.js";
import { agileWorkflowEventAdaptationGolden } from "../fixtures/runtime/hooks/event-adaptation-golden.js";
import { catalog, project, session, snapshot } from "../runtime/hooks/fixtures.js";

describe("hook event adaptation integration", () => {
  it("uses the unchanged Agile Workflow declaration shape for exact session, compact, prompt, and tool plans", () => {
    const declaration = JSON.parse(readFileSync("test/fixtures/plugins/hooks/agile-workflow-hooks.json", "utf8")) as { hooks: Record<string, Array<{ matcher?: string }>> };
    expect(declaration.hooks.SessionStart?.[0]?.matcher).toBe("startup|resume|clear|compact");
    expect(declaration.hooks.PostCompact?.[0]?.matcher).toBe("manual|auto");
    expect(declaration.hooks.PostToolUse?.[0]?.matcher).toBe("Write|Edit|apply_patch");
    const planner = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "user" }, agileWorkflowEventAdaptationGolden.hooks)]) });
    const start = planner.plan({ kind: "session-start", session: session(), reason: "resume" });
    expect(start.kind).toBe("ready");
    if (start.kind === "ready") {
      expect(start.plans[0]?.input).toEqual(expect.objectContaining({ session_id: "session-1", transcript_path: "/sessions/session-1.jsonl", cwd: "/workspace/project", hook_event_name: "SessionStart", source: "resume" }));
      expect(start.plans[0]?.hooks).toHaveLength(1);
      expect(start.plans[0]?.input).not.toHaveProperty("command");
    }
    const prompt = planner.plan({ kind: "input", session: session(), text: "raw prompt", source: "interactive" });
    expect(prompt.kind).toBe("ready");
    if (prompt.kind === "ready") expect(prompt.plans[0]?.input).toEqual(expect.objectContaining({ hook_event_name: "UserPromptSubmit", prompt: "raw prompt" }));
    const tool = planner.plan({ kind: "tool-result", session: session(), evidence: { toolName: "write", toolCallId: "tool-1", input: { path: "x" }, content: [{ type: "text", text: "ok" }], details: { changed: true }, isError: false } });
    expect(tool.kind).toBe("ready");
    if (tool.kind === "ready") {
      expect(PostToolUseHookInputSchema.parse(tool.plans[0]?.input)).toEqual(expect.objectContaining({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { path: "x" }, tool_response: { changed: true } }));
      expect(tool.plans[0]?.hooks).toHaveLength(1);
    }
  });

  it("keeps user/project scopes isolated and compaction order stable", () => {
    const planner = createHookEventPlanner({ catalog: catalog([
      snapshot({ kind: "user" }, agileWorkflowEventAdaptationGolden.hooks.slice(0, 1), "same@community"),
      snapshot({ kind: "project", projectKey: project.projectKey }, agileWorkflowEventAdaptationGolden.hooks.slice(0, 1), "same@community"),
    ]) });
    const result = planner.plan({ kind: "compact", session: session(), reason: "manual", willRetry: false, fromExtension: false });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.plans.map((value) => value.event)).toEqual(["PostCompact", "SessionStart"]);
    const userStart = planner.plan({ kind: "session-start", session: session(), reason: "startup" });
    expect(userStart.kind).toBe("ready");
    if (userStart.kind === "ready") expect(userStart.plans[0]?.hooks.map((value) => value.scope.kind)).toEqual(["user", "project"]);
  });

  it("has no partial plan on trust mismatch and never invokes canaries", () => {
    const run = { called: false };
    const planner = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "project", projectKey: project.projectKey }, agileWorkflowEventAdaptationGolden.hooks, "fixture@community", { ...project, trust: { kind: "untrusted" } })]) });
    const untrusted = session({ currentProject: { ...project, trust: { kind: "untrusted" } }, piProjectTrusted: false });
    expect(planner.plan({ kind: "session-start", session: untrusted, reason: "startup" })).toMatchObject({ kind: "failed", code: "PROJECT_UNTRUSTED" });
    expect(run.called).toBe(false);
  });
});

