import { execPath } from "node:process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNodeCommandRunner } from "../../src/infrastructure/process/command-runner.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/process-hooks/${name}`, import.meta.url));
const bytes = (value: string): AsyncIterable<Uint8Array> => (async function* () { yield new TextEncoder().encode(value); })();
const capture = (maxBytes = 64 * 1024) => ({
  stdout: { mode: "capture" as const, maxBytes, overflow: "error" as const },
  stderr: { maxBytes, overflow: "error" as const },
});

describe("guarded hook real process boundary", () => {
  it("observes exact stdin, cwd, explicit path/config environment, and literal exec arguments", async () => {
    const runner = createNodeCommandRunner({ killGraceMs: 0 });
    const result = await runner.run({
      executable: execPath,
      args: [fixture("echo-input.mjs")],
      cwd: process.cwd(),
      environment: {
        inherit: "none",
        values: {
          CLAUDE_PLUGIN_ROOT: "/immutable/root",
          CLAUDE_PLUGIN_DATA: "/persistent/data",
          PLUGIN_ROOT: "/immutable/root",
          PLUGIN_DATA: "/persistent/data",
          CLAUDE_PROJECT_DIR: "/trusted/project",
          CLAUDE_PLUGIN_OPTION_TOKEN: "callback-secret",
        },
      },
      stdin: bytes('{"hook_event_name":"UserPromptSubmit"}\n'),
      capture: capture(),
    }, new AbortController().signal);
    const output = JSON.parse(new TextDecoder().decode(result.stdout as Uint8Array)) as { input: string; cwd: string; env: Record<string, string> };
    expect(output.input).toBe('{"hook_event_name":"UserPromptSubmit"}\n');
    expect(output.cwd).toBe(process.cwd());
    expect(output.env).toMatchObject({ CLAUDE_PLUGIN_ROOT: "/immutable/root", CLAUDE_PLUGIN_DATA: "/persistent/data", PLUGIN_ROOT: "/immutable/root", PLUGIN_DATA: "/persistent/data", CLAUDE_PROJECT_DIR: "/trusted/project", CLAUDE_PLUGIN_OPTION_TOKEN: "callback-secret" });

    const literal = await runner.run({
      executable: execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "$(not-a-command) * 'quoted'"],
      cwd: process.cwd(),
      environment: { inherit: "none", values: {} },
      capture: capture(),
    }, new AbortController().signal);
    expect(new TextDecoder().decode(literal.stdout as Uint8Array)).toBe("$(not-a-command) * 'quoted'");
  });

  it("keeps explicit shell semantics separate from exec semantics", async () => {
    const result = await createNodeCommandRunner({ killGraceMs: 0 }).run({
      executable: "/bin/bash",
      args: ["-c", "printf '%s' \"$HOOK_VALUE\""],
      cwd: process.cwd(),
      environment: { inherit: "none", values: { HOOK_VALUE: "shell-value" } },
      capture: capture(),
    }, new AbortController().signal);
    expect(new TextDecoder().decode(result.stdout as Uint8Array)).toBe("shell-value");
  });

  it("bounds output and terminates delayed/descendant processes on timeout and cancellation", async () => {
    const runner = createNodeCommandRunner({ killGraceMs: 0 });
    await expect(runner.run({
      executable: execPath,
      args: [fixture("delayed-output.mjs"), "1000", "late"],
      cwd: process.cwd(),
      environment: { inherit: "none", values: {} },
      timeoutMs: 20,
      capture: capture(),
    }, new AbortController().signal)).rejects.toMatchObject({ code: "TIMEOUT" });

    await expect(runner.run({
      executable: execPath,
      args: ["-e", "process.stdout.write('0123456789'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      environment: { inherit: "none", values: {} },
      capture: capture(3),
    }, new AbortController().signal)).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });

    const controller = new AbortController();
    const running = await runner.run({
      executable: execPath,
      args: [fixture("spawn-descendant.mjs")],
      cwd: process.cwd(),
      environment: { inherit: "none", values: {} },
      capture: {
        stdout: { mode: "stream", maxBytes: 64 * 1024, overflow: "error" },
        stderr: { maxBytes: 64 * 1024, overflow: "error" },
      },
    }, controller.signal);
    controller.abort(new Error("caller cancellation"));
    await expect(running.completion).rejects.toMatchObject({ message: "caller cancellation" });
  });

  it("does not need fixture output files after the child exits", async () => {
    await expect(readFile(fixture("echo-input.mjs"), "utf8")).resolves.toContain("CLAUDE_PLUGIN_ROOT");
  });
});
