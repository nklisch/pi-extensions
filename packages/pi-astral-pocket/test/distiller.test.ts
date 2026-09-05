import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, type DistillerConfig } from "../src/config.js";
import { runDistillerPass, selectDistillationCandidates } from "../src/distiller.js";
import { resolveProjectIdentity } from "../src/scope.js";
import { digestScopeKey, readScopedSummary, searchPocket, writeNote } from "../src/store.js";

let root: string;
let sessionsDir: string;
const NOW = new Date("2026-09-04T12:00:00.000Z").getTime();
const PROJECT = "/home/nathan/dev/proj";
const PROJECT_ID = resolveProjectIdentity(PROJECT);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pocket-root-"));
  sessionsDir = mkdtempSync(join(tmpdir(), "pocket-sess-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

function config(overrides: Partial<DistillerConfig> = {}): DistillerConfig {
  return { ...DEFAULT_CONFIG.distiller, ...overrides };
}

function writeAstraSession(id: string, body: string, mtime = new Date(NOW - 24 * 3_600_000), cwd = PROJECT): string {
  const dir = join(sessionsDir, cwd === PROJECT ? "--proj--" : "--other--");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const entries = [
    { type: "session", version: 3, id, cwd },
    { type: "message", message: { role: "user", content: body } },
    { type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", content: [{ type: "text", text: "final answer" }] } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  utimesSync(path, mtime, mtime);
  return path;
}

function model(output = "- **Decision**: use atomic files [notes/source.md]") {
  return vi.fn(async (prompt: string) => prompt.includes("TRANSCRIPT DATA") ? output : "- digest [notes/source.md]");
}

describe("candidate revisions", () => {
  it("reprocesses legacy bookkeeping and filters foreign repositories before calls", async () => {
    writeAstraSession("current", "a durable current repository decision ".repeat(8));
    writeAstraSession("foreign", "a conflicting foreign repository decision ".repeat(8), undefined, "/home/nathan/dev/foreign");
    writeFileSync(join(root, "distilled.json"), JSON.stringify({ sessions: { current: "2026-01-01T00:00:00Z" } }));
    const candidates = await selectDistillationCandidates(sessionsDir, config(), { sessions: { current: "old" } }, NOW, PROJECT_ID);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["current"]);
  });
});

describe("retry-safe distillation", () => {
  it("replaces a changed session note by stable identity and removes it when extraction becomes NONE", async () => {
    const path = writeAstraSession("session-1", "a durable decision and rationale ".repeat(12));
    await runDistillerPass(root, sessionsDir, config(), { callModel: model(), log: () => {}, now: () => NOW }, PROJECT_ID);
    const noteFiles = () => readdirSync(join(root, "notes")).filter((file) => file.endsWith(".md"));
    expect(noteFiles()).toHaveLength(1);
    const stable = noteFiles()[0];

    writeFileSync(path, `${readFileSync(path, "utf8")}\n${JSON.stringify({ type: "message", message: { role: "user", content: "correction: no durable choice remains" } })}\n`);
    utimesSync(path, new Date(NOW - 12 * 3_600_000), new Date(NOW - 12 * 3_600_000));
    const result = await runDistillerPass(root, sessionsDir, config(), { callModel: model("NONE"), log: () => {}, now: () => NOW }, PROJECT_ID);
    expect(result.processed).toBe(1);
    expect(noteFiles()).toHaveLength(0);
    expect(stable).toMatch(/^session-/);
  });

  it("does not publish a revision when the source changes during the model call", async () => {
    const path = writeAstraSession("session-1", "a durable decision and rationale ".repeat(12));
    const callModel = vi.fn(async (prompt: string) => {
      if (prompt.includes("TRANSCRIPT DATA")) {
        writeFileSync(path, `${readFileSync(path, "utf8")}\nchanged\n`);
        return "- stale extraction";
      }
      return "- digest";
    });
    const result = await runDistillerPass(root, sessionsDir, config(), { callModel, log: () => {}, now: () => NOW }, PROJECT_ID);
    expect(result.errors.join(" ")).toContain("source changed");
    const state = JSON.parse(readFileSync(join(root, "distilled.json"), "utf8")) as { sessions: Record<string, unknown> };
    expect(state.sessions["session-1"]).toBeUndefined();
  });

  it("cancellation before mutation prevents late note and state writes", async () => {
    writeAstraSession("session-1", "a durable decision and rationale ".repeat(12));
    const abort = new AbortController();
    const result = await runDistillerPass(root, sessionsDir, config(), {
      callModel: async () => { abort.abort(); return "- late extraction"; },
      log: () => {}, signal: abort.signal, now: () => NOW,
    }, PROJECT_ID);
    expect(result.digest).toBe("cancelled");
    expect(readdirSync(join(root, "notes"))).toHaveLength(0);
  });
});

describe("scoped digest recovery", () => {
  it("rebuilds a deleted digest cache even when its successful fingerprint still matches", async () => {
    writeNote(root, { title: "current", body: "CURRENT DECISION", project: PROJECT, projectId: PROJECT_ID, scope: "project" });
    await runDistillerPass(root, sessionsDir, config(), { callModel: model(), log: () => {}, now: () => NOW }, PROJECT_ID);
    const cache = join(root, "digests", `${digestScopeKey({ kind: "project", projectId: PROJECT_ID }).replace(":", "-")}.md`);
    expect(existsSync(cache)).toBe(true);
    rmSync(cache);

    const rebuildingModel = model();
    const result = await runDistillerPass(root, sessionsDir, config(), { callModel: rebuildingModel, log: () => {}, now: () => NOW }, PROJECT_ID);
    expect(result.digest).toBe("updated");
    expect(rebuildingModel).toHaveBeenCalledTimes(1);
    expect(existsSync(cache)).toBe(true);
  });

  it("does not inject a stale successful digest after removed knowledge and a failed consolidation", async () => {
    const session = writeAstraSession("session-1", "a durable obsolete decision ".repeat(12));
    writeNote(root, { title: "manual source", body: "manual surviving fact", project: PROJECT, projectId: PROJECT_ID, scope: "project" });
    await runDistillerPass(root, sessionsDir, config(), {
      callModel: async (prompt) => prompt.includes("TRANSCRIPT DATA")
        ? "- GENERATED-KNOWLEDGE-TO-REMOVE"
        : "- STALE-GENERATED-KNOWLEDGE [notes/generated.md]",
      log: () => {}, now: () => NOW,
    }, PROJECT_ID);
    expect(readScopedSummary(root, PROJECT_ID)).toContain("STALE-GENERATED-KNOWLEDGE");

    writeFileSync(session, `${readFileSync(session, "utf8")}\n${JSON.stringify({ type: "message", message: { role: "user", content: "correction removes the generated knowledge" } })}\n`);
    utimesSync(session, new Date(NOW - 12 * 3_600_000), new Date(NOW - 12 * 3_600_000));
    const failed = await runDistillerPass(root, sessionsDir, config(), {
      callModel: async (prompt) => {
        if (prompt.includes("TRANSCRIPT DATA")) return "NONE";
        throw new Error("consolidation failed");
      },
      log: () => {}, now: () => NOW,
    }, PROJECT_ID);
    expect(failed.digest).toBe("failed");
    const summary = readScopedSummary(root, PROJECT_ID);
    expect(summary).not.toContain("STALE-GENERATED-KNOWLEDGE");
    expect(summary).toContain("manual source");
  });

  it("retries a failed digest with no new sessions and sends only current-project or explicit-global sources", async () => {
    writeNote(root, { title: "current", body: "CURRENT DECISION", project: PROJECT, projectId: PROJECT_ID, scope: "project" });
    writeNote(root, { title: "foreign", body: "FOREIGN CONFLICT", project: "/foreign", projectId: "foreign-id", scope: "project" });
    writeNote(root, { title: "global", body: "GLOBAL PREFERENCE", scope: "global" });
    const firstPrompts: string[] = [];
    const failed = await runDistillerPass(root, sessionsDir, config(), {
      callModel: async (prompt) => { firstPrompts.push(prompt); throw new Error("provider failed"); },
      log: () => {}, now: () => NOW,
    }, PROJECT_ID);
    expect(failed.digest).toBe("failed");
    expect(searchPocket(root, "CURRENT DECISION", PROJECT_ID, 10)[0]?.title).toBe("current");

    const retryPrompts: string[] = [];
    const retried = await runDistillerPass(root, sessionsDir, config(), {
      callModel: async (prompt) => { retryPrompts.push(prompt); return "- recovered [notes/source.md]"; },
      log: () => {}, now: () => NOW,
    }, PROJECT_ID);
    expect(retried.digest).toBe("updated");
    expect(retryPrompts).toHaveLength(2);
    const projectPrompt = retryPrompts.find((prompt) => prompt.includes(`project ${PROJECT_ID}`))!;
    const globalPrompt = retryPrompts.find((prompt) => prompt.includes("explicit global notes"))!;
    expect(projectPrompt).toContain("CURRENT DECISION");
    expect(projectPrompt).not.toContain("FOREIGN CONFLICT");
    expect(projectPrompt).not.toContain("GLOBAL PREFERENCE");
    expect(globalPrompt).toContain("GLOBAL PREFERENCE");
    expect(globalPrompt).not.toContain("CURRENT DECISION");
    expect(readScopedSummary(root, PROJECT_ID)).toContain("recovered");
  });
});
