import { describe, expect, it, vi } from "vitest";
import type { ParsedHookDecision } from "../../../src/domain/hook-output-contract.js";
import type { HookExecutionBinding } from "../../../src/domain/hook-execution-binding.js";
import { createHookEventPlanner } from "../../../src/runtime/hooks/hook-event-planner.js";
import type { HookEventPlan } from "../../../src/runtime/hooks/event-contract.js";
import { createSubagentHookCoordinator } from "../../../src/runtime/subagents/subagent-hook-coordinator.js";
import { lifecycleIdentity, lifecyclePath } from "../../contract/subagent-lifecycle.contract.js";
import { catalog, hook, project, session, snapshot } from "../hooks/fixtures.js";

function binding(plan: HookEventPlan, index: number): HookExecutionBinding {
  const selected = plan.hooks[index]!;
  return {
    scope: selected.scope,
    plugin: selected.plugin,
    revision: selected.revision,
    projectionDigest: selected.projectionDigest,
    contributionDigest: selected.contributionDigest,
    componentId: selected.component.id,
    sourceOrder: selected.sourceOrder,
  };
}

function parsed(
  plan: HookEventPlan,
  index: number,
  values: Partial<Omit<ParsedHookDecision, "binding">>,
): ParsedHookDecision {
  return {
    binding: binding(plan, index),
    contexts: [],
    systemMessages: [],
    ...values,
  };
}

function setup(
  hooks: ReturnType<typeof hook>[],
  execute: (plan: HookEventPlan) => Promise<ReturnType<any>>,
  resolve = vi.fn(async (parentSessionId: string) =>
    parentSessionId === session().sessionId ? session() : undefined),
) {
  const runtime = new AbortController();
  const planner = createHookEventPlanner({
    catalog: catalog([snapshot({ kind: "user" }, hooks)]),
  });
  const executor = { execute: vi.fn(execute) };
  const coordinator = createSubagentHookCoordinator({
    planner,
    executor,
    sessions: { resolve },
    runtimeSignal: runtime.signal,
    continuationBudget: 3,
  });
  return { coordinator, executor, resolve, runtime };
}

const startRequest = () => ({
  identity: lifecycleIdentity({
    agentType: "reviewer",
    parentSessionId: session().sessionId,
  }),
  execution: lifecyclePath(),
  prompt: "EXACT_PROMPT_SECRET_CANARY",
  signal: new AbortController().signal,
});

const completionRequest = (round = 0) => ({
  identity: lifecycleIdentity({
    agentType: "reviewer",
    parentSessionId: session().sessionId,
  }),
  execution: lifecyclePath({ phase: "resume" }),
  proposedResult: "PROPOSED_RESULT_SECRET_CANARY",
  outcome: "completed" as const,
  continuationRound: round,
  maxContinuationRounds: 3,
  signal: new AbortController().signal,
});

describe("subagent hook coordinator", () => {
  it("appends start context in source order despite inverse completion", async () => {
    const fixture = setup([
      hook("SubagentStart", "reviewer", [], "b"),
      hook("SubagentStart", "reviewer", [], "c"),
    ], async (plan) => ({
      kind: "completed",
      handlers: [
        parsed(plan, 1, { contexts: ["second"] }),
        parsed(plan, 0, { contexts: ["first"] }),
      ],
    }));

    await expect(fixture.coordinator.beforeStart(startRequest())).resolves.toEqual({
      action: "continue",
      prompt: "EXACT_PROMPT_SECRET_CANARY\n\nfirst\n\nsecond",
    });
    expect(fixture.executor.execute).toHaveBeenCalledTimes(1);
    const plan = fixture.executor.execute.mock.calls[0]![0];
    expect(plan.input).not.toHaveProperty("prompt");
    expect(plan.input).toMatchObject({ agent_id: expect.any(String), agent_type: "reviewer" });
    await fixture.coordinator.dispose();
  });

  it("aborts only on explicit start blocks and runs unhooked after execution failures", async () => {
    const blocked = setup([hook("SubagentStart", "reviewer", [], "b")], async (plan) => ({
      kind: "completed",
      handlers: [parsed(plan, 0, { stop: { reason: "safe block" } })],
    }));
    await expect(blocked.coordinator.beforeStart(startRequest())).resolves.toMatchObject({
      action: "abort",
      code: "hook-blocked",
    });

    const failed = setup([hook("SubagentStart", "reviewer", [], "b")], async () => ({
      kind: "failed",
      diagnostics: [],
    }));
    await expect(failed.coordinator.beforeStart(startRequest())).resolves.toEqual({
      action: "continue",
      prompt: "EXACT_PROMPT_SECRET_CANARY",
    });

    const controller = new AbortController();
    const reason = new Error("caller cancellation");
    controller.abort(reason);
    await expect(failed.coordinator.beforeStart({ ...startRequest(), signal: controller.signal }))
      .rejects.toBe(reason);
    await blocked.coordinator.dispose();
    await failed.coordinator.dispose();
  });

  it("completes exact results or requests bounded same-session continuation", async () => {
    const unchanged = setup([hook("SubagentStop", "reviewer", [], "b")], async () => ({
      kind: "completed",
      handlers: [],
    }));
    await expect(unchanged.coordinator.beforeComplete(completionRequest())).resolves.toEqual({
      action: "complete",
      result: "PROPOSED_RESULT_SECRET_CANARY",
    });

    const continued = setup([hook("SubagentStop", "reviewer", [], "b")], async (plan) => ({
      kind: "completed",
      handlers: [parsed(plan, 0, {
        contexts: ["check tests", "inspect diff"],
        continuation: { reason: "address findings" },
      })],
    }));
    await expect(continued.coordinator.beforeComplete(completionRequest(2))).resolves.toEqual({
      action: "continue",
      prompt: "check tests\n\ninspect diff\n\naddress findings",
    });
    await expect(continued.coordinator.beforeComplete(completionRequest(3))).resolves.toMatchObject({
      action: "abort",
      code: "continuation-limit",
    });
    const plan = continued.executor.execute.mock.calls[0]![0];
    expect(plan.input).toMatchObject({
      last_assistant_message: "PROPOSED_RESULT_SECRET_CANARY",
      pi: { subagent: { continuationRound: 2, boundary: "completion" } },
    });
    await unchanged.coordinator.dispose();
    await continued.coordinator.dispose();
  });

  it("passes parentless and no-hook runs through without session/configuration work", async () => {
    const fixture = setup([], async () => { throw new Error("must not execute"); });
    const parentless = startRequest();
    await expect(fixture.coordinator.beforeStart({
      ...parentless,
      identity: { ...parentless.identity, parentSessionId: undefined },
      execution: { ...parentless.execution, origin: "service" },
    })).resolves.toEqual({ action: "continue", prompt: "EXACT_PROMPT_SECRET_CANARY" });
    await expect(fixture.coordinator.beforeStart(parentless)).resolves.toEqual({
      action: "continue",
      prompt: "EXACT_PROMPT_SECRET_CANARY",
    });
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.executor.execute).not.toHaveBeenCalled();
    await fixture.coordinator.dispose();
  });

  it("runs unhooked when a claimed parent session is unknown", async () => {
    const resolve = vi.fn(async () => undefined);
    const fixture = setup([hook("SubagentStart", "reviewer", [], "b")], async () => ({ kind: "completed", handlers: [] }), resolve);
    await expect(fixture.coordinator.beforeStart(startRequest())).resolves.toEqual({
      action: "continue",
      prompt: "EXACT_PROMPT_SECRET_CANARY",
    });
    expect(resolve).toHaveBeenCalledWith(session().sessionId, expect.any(AbortSignal));
    expect(fixture.executor.execute).not.toHaveBeenCalled();
    await fixture.coordinator.dispose();
  });

  it("runtime disposal is idempotent and prevents later boundaries", async () => {
    const fixture = setup([hook("SubagentStart", "reviewer", [], "b")], async () => ({ kind: "completed", handlers: [] }));
    await fixture.coordinator.dispose();
    await fixture.coordinator.dispose();
    await expect(fixture.coordinator.beforeStart(startRequest())).resolves.toMatchObject({
      action: "abort",
      code: "runtime-disposed",
    });
  });

  it("does not mix current-project authority and runs unhooked on mismatch", async () => {
    const resolve = vi.fn(async () => session({ currentProject: { ...project, trust: { kind: "untrusted" } } }));
    const fixture = setup([hook("SubagentStart", "reviewer", [], "b")], async () => ({ kind: "completed", handlers: [] }), resolve);
    await expect(fixture.coordinator.beforeStart(startRequest())).resolves.toEqual({
      action: "continue",
      prompt: "EXACT_PROMPT_SECRET_CANARY",
    });
    expect(fixture.executor.execute).not.toHaveBeenCalled();
    await fixture.coordinator.dispose();
  });

  it("runs unhooked when the parent session changes between planning and execution", async () => {
    const planned = session();
    const replaced = session({ cwd: "/workspace/replaced" });
    const resolve = vi.fn()
      .mockResolvedValueOnce(planned)
      .mockResolvedValueOnce(replaced);
    const fixture = setup(
      [hook("SubagentStart", "reviewer", [], "b")],
      async () => ({ kind: "completed", handlers: [] }),
      resolve,
    );

    await expect(fixture.coordinator.beforeStart(startRequest())).resolves.toEqual({
      action: "continue",
      prompt: "EXACT_PROMPT_SECRET_CANARY",
    });
    expect(fixture.executor.execute).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(2);
    await fixture.coordinator.dispose();
  });

  it("runs unhooked when the session resolver fails without a caller abort", async () => {
    const resolve = vi.fn(async () => {
      throw new DOMException("adapter stopped", "AbortError");
    });
    const fixture = setup(
      [hook("SubagentStart", "reviewer", [], "b")],
      async () => ({ kind: "completed", handlers: [] }),
      resolve,
    );

    await expect(fixture.coordinator.beforeStart(startRequest())).resolves.toEqual({
      action: "continue",
      prompt: "EXACT_PROMPT_SECRET_CANARY",
    });
    await fixture.coordinator.dispose();
  });
});
