import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import { createHookEventPlanner } from "../../../src/runtime/hooks/hook-event-planner.js";
import { createGuardedCommandHookExecutor } from "../../../src/runtime/hooks/guarded-command-executor.js";
import { createNodeCommandRunner } from "../../../src/infrastructure/process/command-runner.js";
import { catalog, hook, project, session, snapshot } from "./fixtures.js";
import type { ResolvedConfiguration } from "../../../src/application/resolved-configuration.js";

const configuration: ResolvedConfiguration = {
  has: () => false,
  substitute: (value) => value,
  environment: () => Object.freeze({}),
  redact: (value) => value,
  dispose: () => undefined,
  toString: () => "[REDACTED]",
  toJSON: () => "[REDACTED]",
};

function planFor(hooks: ReturnType<typeof hook>[]) {
  const result = createHookEventPlanner({ catalog: catalog([snapshot({ kind: "user" }, hooks)]) }).plan({
    kind: "input",
    session: session(),
    text: "hello",
    source: "interactive",
  });
  if (result.kind !== "ready") throw new Error("expected a plan");
  return result.plans[0]!;
}

function context() {
  return {
    withContext: async (_request: unknown, _signal: AbortSignal, use: (value: Readonly<{
      cwd: string;
      projectRoot: string;
      pluginRoot: string;
      pluginDataRoot: string;
      configuration: ResolvedConfiguration;
    }>) => Promise<void>) => use({
      cwd: process.cwd(),
      projectRoot: "/project",
      pluginRoot: "/plugin",
      pluginDataRoot: "/data",
      configuration,
    }),
  };
}

describe("guarded command hook executor", () => {
  it("passes one canonical JSON stdin and explicit roots/configuration environment", async () => {
    const requests: unknown[] = [];
    const plan = planFor([hook("UserPromptSubmit", undefined, [], "a")]);
    const executor = createGuardedCommandHookExecutor({
      context: context(),
      executables: { resolve: async (request) => ({ executable: execPath, resolution: "absolute", identity: "identity" as never }) },
      command: {
        run: async (request) => {
          requests.push(request);
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode('{"additionalContext":"accepted"}'),
            stderr: new Uint8Array(),
            stderrTruncated: false,
          };
        },
      },
    });
    const result = await executor.execute(plan, { currentProject: project, runtimeSignal: new AbortController().signal });
    expect(result.kind).toBe("completed");
    expect(requests).toHaveLength(1);
    const request = requests[0] as { stdin: AsyncIterable<Uint8Array>; environment: { inherit: string; values: Record<string, string> } };
    const chunks: Uint8Array[] = [];
    for await (const chunk of request.stdin) chunks.push(chunk);
    const input = new TextDecoder().decode(chunks[0]);
    expect(input.endsWith("\n")).toBe(true);
    expect(JSON.parse(input)).toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "hello" });
    expect(request.environment.inherit).toBe("host");
    expect(request.environment.values).toMatchObject({ CLAUDE_PLUGIN_ROOT: "/plugin", PLUGIN_ROOT: "/plugin", CLAUDE_PLUGIN_DATA: "/data", PLUGIN_DATA: "/data", CLAUDE_PROJECT_DIR: "/project" });
  });

  it("deduplicates exact selected identities and keeps source-order slots", async () => {
    const plan = planFor([hook("UserPromptSubmit", undefined, [], "a"), hook("UserPromptSubmit", undefined, [], "a"), hook("UserPromptSubmit", undefined, [], "b")]);
    const completed: string[] = [];
    const executor = createGuardedCommandHookExecutor({
      context: context(),
      executables: { resolve: async (request) => ({ executable: request.command, resolution: "path", identity: "identity" as never }) },
      command: {
        run: async (request) => {
          await new Promise((resolve) => setTimeout(resolve, request.executable.endsWith("a") ? 20 : 1));
          completed.push(request.executable);
          return { exitCode: 0, stdout: new TextEncoder().encode(`{"additionalContext":"${request.executable}"}`), stderr: new Uint8Array(), stderrTruncated: false };
        },
      },
    });
    const result = await executor.execute(plan, { currentProject: project, runtimeSignal: new AbortController().signal });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(completed).toEqual(["canary-b", "canary-a"]);
    expect(result.handlers.map((value) => "code" in value ? value.code : value.contexts[0])).toEqual(["canary-a", "canary-b"]);
  });

  it("maps a runner null exit to a spawn diagnostic rather than executable-unavailable", async () => {
    const plan = planFor([hook("UserPromptSubmit", undefined, [], "a")]);
    const executor = createGuardedCommandHookExecutor({
      context: context(),
      executables: { resolve: async () => ({ executable: execPath, resolution: "absolute", identity: "identity" as never }) },
      command: {
        run: async () => { throw Object.assign(new Error("closed without status"), { code: "NULL_EXIT" }); },
      },
    });
    const result = await executor.execute(plan, { currentProject: project, runtimeSignal: new AbortController().signal });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.handlers).toHaveLength(1);
    expect(result.handlers[0]).toMatchObject({ code: "HOOK_SPAWN_FAILED" });
  });

  it("uses the real bounded runner for literal exec arguments", async () => {
    const raw = hook("UserPromptSubmit", undefined, [], "a");
    const plan = planFor([raw]);
    const executor = createGuardedCommandHookExecutor({
      context: context(),
      executables: { resolve: async () => ({ executable: execPath, resolution: "absolute", identity: "identity" as never }) },
      command: createNodeCommandRunner({ killGraceMs: 0 }),
    });
    const result = await executor.execute(plan, { currentProject: project, runtimeSignal: new AbortController().signal });
    expect(result.kind).toBe("completed");
  });
});
