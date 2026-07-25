import { describe, expect, it, vi } from "vitest";
import { registerSubagentHookRuntime } from "../../src/application/subagent-hook-runtime.js";
import type { ResolvedConfiguration } from "../../src/application/resolved-configuration.js";
import { createGuardedCommandHookExecutor } from "../../src/runtime/hooks/guarded-command-executor.js";
import { createHookEventPlanner } from "../../src/runtime/hooks/hook-event-planner.js";
import { createSubagentHookCoordinator } from "../../src/runtime/subagents/subagent-hook-coordinator.js";
import type { SkillHookRuntimeSnapshot } from "../../src/runtime/skill-hook/runtime-snapshot.js";
import { lifecycleIdentity, lifecyclePath } from "../contract/subagent-lifecycle.contract.js";
import { createFakeSubagentLifecycle } from "../support/fakes/subagent-lifecycle.js";
import { hook, project, session, snapshot } from "../runtime/hooks/fixtures.js";

const configuration: ResolvedConfiguration = {
  has: () => false,
  substitute: (value) => value,
  environment: () => Object.freeze({}),
  redact: (value) => value.replaceAll("CONFIG_SECRET_CANARY", "[REDACTED]"),
  dispose: () => undefined,
  toString: () => "[REDACTED]",
  toJSON: () => "[REDACTED]",
};

async function stdinJson(stdin: AsyncIterable<Uint8Array>): Promise<any> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return JSON.parse(new TextDecoder().decode(chunks[0]));
}

describe("fake-backed portable subagent hook runtime", () => {
  it("runs projection through parent context, guarded execution, aggregation, and exact lifecycle decisions", async () => {
    let snapshots: readonly SkillHookRuntimeSnapshot[] = [
      snapshot({ kind: "user" }, [
        hook("SubagentStart", "reviewer", [], "b"),
        hook("SubagentStop", "reviewer", [], "c"),
      ]),
      snapshot({ kind: "user" }, [
        hook("SubagentStart", "reviewer", [], "d"),
      ], "second@community"),
    ];
    const catalog = {
      list: () => snapshots,
      get: (scope: any, plugin: any) => snapshots.find((value) => value.scope.kind === scope.kind && value.plugin === plugin),
      currentProject: () => project as any,
    };
    const planner = createHookEventPlanner({ catalog });
    const commandInputs: any[] = [];
    const command = {
      run: vi.fn(async (request: any) => {
        const input = await stdinJson(request.stdin);
        commandInputs.push(input);
        const stdout = input.hook_event_name === "SubagentStart"
          ? JSON.stringify({ additionalContext: input.agent_id.endsWith("never") ? "unused" : `context-${request.executable}` })
          : input.pi.subagent.continuationRound === 0
            ? JSON.stringify({ decision: "block", reason: "run checks" })
            : "{}";
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(stdout),
          stderr: new Uint8Array(),
          stderrTruncated: false,
        };
      }),
    };
    const executor = createGuardedCommandHookExecutor({
      context: {
        withContext: async (_request, signal, use) => {
          signal.throwIfAborted();
          await use({
            cwd: "/workspace/project",
            projectRoot: "/workspace/project",
            pluginRoot: "/content",
            pluginDataRoot: "/data",
            configuration,
          });
        },
      },
      executables: {
        resolve: async (request) => ({
          executable: request.command,
          resolution: "path",
          identity: "test-executable" as never,
        }),
      },
      command,
    });
    const runtimeAbort = new AbortController();
    const coordinator = createSubagentHookCoordinator({
      planner,
      executor,
      sessions: {
        resolve: async (parentSessionId, signal) => {
          signal.throwIfAborted();
          return parentSessionId === session().sessionId ? session() : undefined;
        },
      },
      runtimeSignal: runtimeAbort.signal,
      continuationBudget: 3,
    });
    const fake = createFakeSubagentLifecycle();
    const qualification = await fake.lifecycle.capabilities(runtimeAbort.signal);
    const registered = await registerSubagentHookRuntime({
      lifecycle: fake.lifecycle,
      qualification,
      coordinator,
      runtimeSignal: runtimeAbort.signal,
    });

    const observedStartPrompts: string[] = [];
    const observedCompletions: string[] = [];
    await fake.lifecycle.register({
      expectedQualificationDigest: qualification.qualificationDigest,
      maxContinuationRounds: 3,
      interceptor: {
        beforeStart: async (request) => {
          observedStartPrompts.push(request.prompt);
          return { action: "continue", prompt: request.prompt };
        },
        beforeComplete: async (request) => {
          observedCompletions.push(request.proposedResult);
          return { action: "complete", result: request.proposedResult };
        },
      },
    }, runtimeAbort.signal);

    const identity = lifecycleIdentity({
      agentType: "reviewer",
      parentSessionId: session().sessionId,
    });
    const trace = await fake.execute({
      identity,
      execution: lifecyclePath({ admission: "queued", mode: "background" }),
      prompt: "EXACT_PROMPT_SECRET_CANARY",
      proposedResults: ["PROPOSED_RESULT_SECRET_CANARY-0", "PROPOSED_RESULT_SECRET_CANARY-1"],
      signal: runtimeAbort.signal,
    });

    expect(trace.terminal).toBe("completed");
    expect(trace.continuationRounds).toBe(1);
    expect(observedStartPrompts).toEqual([
      "EXACT_PROMPT_SECRET_CANARY\n\ncontext-canary-b\n\ncontext-canary-d",
    ]);
    // The observer is skipped on the continuation decision and sees only the
    // accepted second proposed result in the same execution.
    expect(observedCompletions).toEqual(["PROPOSED_RESULT_SECRET_CANARY-1"]);
    expect(commandInputs).toHaveLength(4);
    expect(commandInputs[0]).not.toHaveProperty("prompt");
    expect(commandInputs.filter((value) => value.hook_event_name === "SubagentStop")[0])
      .toHaveProperty("last_assistant_message", "PROPOSED_RESULT_SECRET_CANARY-0");
    expect(JSON.stringify(trace)).not.toContain("SECRET_CANARY");

    // A verified-catalog update is observed at the next boundary. The already
    // completed boundary retained its original two-plugin snapshot.
    snapshots = [];
    const commandsBefore = command.run.mock.calls.length;
    await fake.execute({
      identity: lifecycleIdentity({
        agentType: "reviewer",
        parentSessionId: session().sessionId,
      }),
      execution: lifecyclePath({ phase: "resume" }),
      prompt: "NEXT_PROMPT_SECRET_CANARY",
      proposedResults: ["NEXT_RESULT_SECRET_CANARY"],
      signal: runtimeAbort.signal,
    });
    expect(command.run).toHaveBeenCalledTimes(commandsBefore);

    await registered.dispose();
    await coordinator.dispose();
    await fake.shutdown();
  });
});
