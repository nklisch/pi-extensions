import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type DistillerConfig } from "../src/config.js";
import { runDistillerPass, selectDistillationCandidates } from "../src/distiller.js";

let root: string;
let sessionsDir: string;

const NOW = new Date("2026-09-04T12:00:00.000Z").getTime();

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

function writeAstraSession(id: string, body: string, mtime: Date): void {
  const dir = join(sessionsDir, "--proj--");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const entries = [
    { type: "session", version: 3, id, cwd: "/home/nathan/dev/proj" },
    { type: "message", id: "u1", message: { role: "user", content: body } },
    {
      type: "message",
      id: "m1",
      message: { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", content: [{ type: "text", text: "done" }] },
    },
  ];
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  utimesSync(path, mtime, mtime);
}

const idle = new Date(NOW - 24 * 3_600_000); // 24h old: past the 6h idle threshold
const fresh = new Date(NOW - 1 * 3_600_000); // 1h old: still within idle threshold

describe("selectDistillationCandidates", () => {
  it("selects idle astra sessions, skips fresh and already-distilled ones", async () => {
    writeAstraSession("idle-1", "we decided to use sqlite for state storage because locks matter", idle);
    writeAstraSession("fresh-1", "in progress work on the build pipeline and release flow", fresh);
    const state = { sessions: { "distilled-1": "2026-09-03T00:00:00.000Z" } };
    writeAstraSession("distilled-1", "previously processed session about versioning policy", idle);
    const candidates = await selectDistillationCandidates(sessionsDir, config(), state, NOW);
    expect(candidates.map((c) => c.id)).toEqual(["idle-1"]);
  });

  it("bounds the pass at maxSessionsPerPass, oldest first", async () => {
    for (let i = 0; i < 5; i++) {
      writeAstraSession(`s${i}`, `session ${i} about the deployment checklist and rollback plan`, new Date(NOW - (48 - i) * 3_600_000));
    }
    const candidates = await selectDistillationCandidates(sessionsDir, config({ maxSessionsPerPass: 2 }), { sessions: {} }, NOW);
    expect(candidates.map((c) => c.id)).toEqual(["s0", "s1"]);
  });
});

describe("runDistillerPass", () => {
  const log = () => {};

  it("skips when disabled or when no model resolves", async () => {
    writeAstraSession("idle-1", "decision: use sqlite for state storage because of locking", idle);
    const disabled = await runDistillerPass(root, sessionsDir, config({ enabled: false }), { callModel: async () => "x", log, now: () => NOW });
    expect(disabled.skippedReason).toBe("distiller disabled");
    const noModel = await runDistillerPass(root, sessionsDir, config(), { callModel: null, log, now: () => NOW });
    expect(noModel.skippedReason).toBe("no distiller model");
    // Mechanical floor: no crash, no partial state file requirement.
  });

  it("extracts durable notes from idle astra sessions and marks them distilled", async () => {
    writeAstraSession("idle-1", "we chose sqlite for state because cross-process locking matters a lot, and we spent the whole session comparing it against json files and lmdb before settling on the wal-mode sqlite design with a lock probe at startup", idle);
    const result = await runDistillerPass(root, sessionsDir, config(), {
      callModel: async (prompt) => (prompt.includes("TRANSCRIPT") ? "- **SQLite state**: chosen for locking" : "- **SQLite state**: chosen for locking"),
      log,
      now: () => NOW,
    });
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
    const registry = readFileSync(join(root, "POCKET.md"), "utf8");
    expect(registry).toContain("Distilled session");
    const summary = readFileSync(join(root, "SUMMARY.md"), "utf8");
    expect(summary).toContain("SQLite state"); // consolidation refreshed the digest
    // Second pass: session already distilled, nothing to do.
    const again = await runDistillerPass(root, sessionsDir, config(), { callModel: async () => "x", log, now: () => NOW });
    expect(again.processed).toBe(0);
  });

  it("writes no note when extraction says NONE but still marks the session", async () => {
    writeAstraSession("idle-1", "trivial one-liner formatting change to the readme file", idle);
    const result = await runDistillerPass(root, sessionsDir, config(), { callModel: async () => "NONE", log, now: () => NOW });
    expect(result.processed).toBe(0);
    const state = JSON.parse(readFileSync(join(root, "distilled.json"), "utf8")) as { sessions: Record<string, string> };
    expect(state.sessions["idle-1"]).toBeDefined();
  });

  it("contains per-session model failures and keeps processing others", async () => {
    writeAstraSession("bad-1", "session about the publish workflow and npm trusted publishing setup, walking through the github actions OIDC configuration, the provenance flags, and the exact ordering of version bumps versus installs that bit us before", idle);
    writeAstraSession("good-1", "session about the versioning policy for inter-package ranges, covering why patch-floor carets strand consumers on old minor lines and why the sibling packages stay exactly pinned by design with a sync-invariant test", new Date(NOW - 30 * 3_600_000));
    let calls = 0;
    const result = await runDistillerPass(root, sessionsDir, config(), {
      callModel: async (prompt) => {
        if (prompt.includes("TRANSCRIPT")) {
          calls += 1;
          if (calls === 1) throw new Error("provider exploded");
          return "- **Ranges**: major-only carets";
        }
        return "- **Ranges**: major-only carets";
      },
      log,
      now: () => NOW,
    });
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("provider exploded");
  });
});
