import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHookFailureLog, createNullHookFailureLog } from "../../../src/runtime/hooks/hook-failure-log.js";

async function settled(): Promise<void> {
  // Fire-and-forget writes chain behind one promise; a few microtask turns
  // let the tail settle before assertions.
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("hook failure log", () => {
  it("appends sanitized JSONL records and creates parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "hook-failure-log-"));
    const file = join(root, "nested", "hooks.jsonl");
    const log = createHookFailureLog({ file });
    log.record({ at: 1000, event: "UserPromptSubmit", phase: "execution", code: "HOOK_TIMEOUT", plugin: "demo@catalog", componentId: "component-v1:hook:abc", detail: "line\nbreak\u0007" });
    log.record({ at: 1001, event: "PreToolUse", phase: "planning", code: "CURRENT_PROJECT_MISMATCH" });
    await settled();
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ at: 1000, event: "UserPromptSubmit", phase: "execution", code: "HOOK_TIMEOUT", plugin: "demo@catalog" });
    expect(first.detail).not.toContain("\n");
    expect(JSON.parse(lines[1]!)).toMatchObject({ at: 1001, event: "PreToolUse", phase: "planning", code: "CURRENT_PROJECT_MISMATCH" });
  });

  it("rotates once the file crosses the size bound and keeps logging", async () => {
    const root = await mkdtemp(join(tmpdir(), "hook-failure-log-"));
    const file = join(root, "hooks.jsonl");
    await writeFile(file, "x".repeat(600), "utf8");
    const log = createHookFailureLog({ file, maxBytes: 100 });
    log.record({ at: 1, event: "Stop", phase: "execution", code: "HOOK_EXIT_STATUS" });
    await settled();
    const names = await readdir(root);
    expect(names.sort()).toEqual(["hooks.jsonl", "hooks.jsonl.1"]);
    expect((await readFile(join(root, "hooks.jsonl.1"), "utf8")).length).toBe(600);
    expect(JSON.parse((await readFile(file, "utf8")).trim())).toMatchObject({ code: "HOOK_EXIT_STATUS" });
  });

  it("never throws on unwritable paths", async () => {
    const log = createHookFailureLog({ file: join(tmpdir(), "hook-failure-log-missing-\0invalid", "hooks.jsonl") });
    expect(() => log.record({ at: 1, event: "Stop", phase: "decision", code: "HOOK_SPAWN_FAILED" })).not.toThrow();
    await settled();
  });

  it("null log is inert", () => {
    const log = createNullHookFailureLog();
    expect(log.file).toBe("");
    expect(() => log.record({ at: 1, event: "Stop", phase: "planning", code: "INVALID_REQUEST" })).not.toThrow();
  });
});
