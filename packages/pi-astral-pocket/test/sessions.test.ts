import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveProjectIdentity } from "../src/scope.js";
import { identifySession, listSessionFiles, readSessionDigest, searchAstraSessions } from "../src/sessions.js";

let sessionsDir: string;

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "pocket-sessions-"));
});

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

function writeSession(projectDir: string, name: string, entries: Record<string, unknown>[], mtime?: Date): string {
  const dir = join(sessionsDir, projectDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

const HEADER: Record<string, unknown> = { type: "session", version: 3, id: "sess-1", cwd: "/home/nathan/dev/pi-extensions" };

function assistantText(text: string, provider = "openai-codex", model = "gpt-6-astra"): Record<string, unknown> {
  return {
    type: "message",
    id: "m1",
    timestamp: "2026-09-01T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }], provider, model },
  };
}

describe("identifySession", () => {
  it("flags sessions with astra assistant messages", async () => {
    const path = writeSession("--proj--", "a.jsonl", [HEADER, assistantText("hello")]);
    const info = await identifySession(path, 0);
    expect(info.id).toBe("sess-1");
    expect(info.cwd).toBe("/home/nathan/dev/pi-extensions");
    expect(info.astra).toBe(true);
  });

  it("flags sessions switched to astra via model_change", async () => {
    const path = writeSession("--proj--", "b.jsonl", [
      HEADER,
      assistantText("terra reply", "openai-codex", "gpt-5.6-terra"),
      { type: "model_change", provider: "openai-codex", modelId: "gpt-6-astra" },
    ]);
    expect((await identifySession(path, 0)).astra).toBe(true);
  });

  it("does not flag non-astra sessions", async () => {
    const path = writeSession("--proj--", "c.jsonl", [HEADER, assistantText("kimi reply", "kimi-coding", "k3")]);
    expect((await identifySession(path, 0)).astra).toBe(false);
  });
});

describe("searchAstraSessions", () => {
  it("returns summarized hits only from astra sessions", async () => {
    writeSession("--proj--", "astra.jsonl", [
      HEADER,
      { type: "message", id: "u1", timestamp: "2026-09-01T09:59:00.000Z", message: { role: "user", content: "how do I run the publish workflow?" } },
      assistantText("Use the Publish Pi extension workflow."),
    ]);
    writeSession("--proj--", "other.jsonl", [
      { ...HEADER, id: "sess-2" },
      assistantText("publish workflow details from terra", "openai-codex", "gpt-5.6-terra"),
    ]);
    const hits = await searchAstraSessions(sessionsDir, "publish workflow", { recallScope: "all" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.sessionId === "sess-1")).toBe(true);
  });

  it("summarizes tool calls as name plus truncated args", async () => {
    writeSession("--proj--", "tools.jsonl", [
      HEADER,
      {
        type: "message",
        id: "m2",
        timestamp: "2026-09-01T10:01:00.000Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-6-astra",
          content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: `npm run ${"x".repeat(500)}` } }],
        },
      },
    ]);
    const summarized = await searchAstraSessions(sessionsDir, "npm run", { recallScope: "all" });
    expect(summarized[0].kind).toBe("toolCall");
    expect(summarized[0].excerpt).toContain("bash(");
    expect(summarized[0].excerpt.length).toBeLessThan(250);
    const full = await searchAstraSessions(sessionsDir, "npm run", { full: true, recallScope: "all" });
    expect(full[0].excerpt.length).toBeGreaterThan(summarized[0].excerpt.length);
  });

  it("filters foreign repositories before applying the result limit", async () => {
    writeSession("--foreign--", "foreign.jsonl", [
      { ...HEADER, id: "foreign", cwd: "/foreign/repo" },
      assistantText("shared decision from foreign"),
    ]);
    writeSession("--current--", "current.jsonl", [HEADER, assistantText("shared decision from current")]);
    const projectId = resolveProjectIdentity(String(HEADER.cwd));
    const current = await searchAstraSessions(sessionsDir, "shared decision", { projectId, limit: 1 });
    expect(current).toHaveLength(1);
    expect(current[0]?.sessionId).toBe("sess-1");
    const all = await searchAstraSessions(sessionsDir, "shared decision", { projectId, recallScope: "all" });
    expect(all.map((hit) => hit.sessionId)).toEqual(expect.arrayContaining(["sess-1", "foreign"]));
  });

  it("honors the result limit", async () => {
    const entries = [HEADER];
    for (let i = 0; i < 8; i++) entries.push(assistantText(`repeat-topic note ${i}`));
    writeSession("--proj--", "many.jsonl", entries);
    const hits = await searchAstraSessions(sessionsDir, "repeat-topic", { limit: 3, recallScope: "all" });
    expect(hits).toHaveLength(3);
  });
});

describe("listSessionFiles", () => {
  it("filters by age and skips non-jsonl and tasks dirs", () => {
    const recent = writeSession("--p--", "recent.jsonl", [HEADER]);
    const old = writeSession("--p--", "old.jsonl", [HEADER], new Date(Date.now() - 40 * 86_400_000));
    mkdirSync(join(sessionsDir, "--p--", "tasks"), { recursive: true });
    writeFileSync(join(sessionsDir, "--p--", "tasks", "task.jsonl"), "{}\n");
    const all = listSessionFiles(sessionsDir);
    expect(all.map((f) => f.path)).toContain(recent);
    const capped = listSessionFiles(sessionsDir, 30);
    expect(capped.map((f) => f.path)).toEqual([recent]);
    expect(capped.some((f) => f.path.includes("tasks"))).toBe(false);
    expect(all.map((f) => f.path)).toContain(old);
  });
});

describe("readSessionDigest", () => {
  it("preserves the final decisions when the middle exceeds the transcript budget", async () => {
    const entries: Record<string, unknown>[] = [HEADER, { type: "message", message: { role: "user", content: "opening problem" } }];
    for (let i = 0; i < 30; i++) entries.push(assistantText(`middle noise ${i} ${"x".repeat(200)}`));
    entries.push(assistantText("FINAL DECISION: use atomic replacement"));
    const path = writeSession("--p--", "long.jsonl", entries);
    const digest = await readSessionDigest(path, 2_000);
    expect(digest).toContain("opening problem");
    expect(digest).toContain("FINAL DECISION");
    expect(digest).toContain("earlier transcript omitted");
  });

  it("keeps later short corrections after the first tail entry chronologically", async () => {
    const path = writeSession("--p--", "chronological.jsonl", [
      HEADER,
      { type: "message", message: { role: "user", content: "opening context" } },
      assistantText(`OLDER-TAIL ${"x".repeat(1_400)}`),
      assistantText("LATER-SHORT-CORRECTION"),
    ]);
    const digest = await readSessionDigest(path, 3_000);
    expect(digest.indexOf("OLDER-TAIL")).toBeLessThan(digest.indexOf("LATER-SHORT-CORRECTION"));
  });

  it("compacts messages and truncates tool call args and results", async () => {
    const path = writeSession("--p--", "digest.jsonl", [
      HEADER,
      { type: "message", id: "u1", message: { role: "user", content: "please fix the build" } },
      {
        type: "message",
        id: "m1",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-6-astra",
          content: [
            { type: "text", text: "looking into it" },
            { type: "toolCall", id: "t1", name: "bash", arguments: { command: `npm run check ${"y".repeat(1000)}` } },
          ],
        },
      },
      {
        type: "message",
        id: "r1",
        message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "z".repeat(5000) }], isError: false },
      },
    ]);
    const digest = await readSessionDigest(path);
    expect(digest).toContain("USER: please fix the build");
    expect(digest).toContain("ASSISTANT: looking into it");
    expect(digest).toContain("[tool: bash");
    expect(digest.length).toBeLessThan(1500);
  });
});
