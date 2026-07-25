import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPolicyDecisionEntry,
  createReviewerDecisionEntry,
} from "../../src/audit/log.ts";
import type { Decision } from "../../src/policy/core.ts";
import { readReplayCorpus } from "../../src/replay/reader.ts";
import { fixtureCorpusPaths } from "./fixture-corpus.ts";

const allowDecision = {
  effect: "allow",
  reason: "matched read-only command",
  provenance: {
    source: "shipped",
    packId: "pack:inspect",
    ruleId: "allow-git-status",
  },
} satisfies Decision;

const reviewDecision = {
  effect: "review",
  reason: "policy fell through",
  provenance: { source: "default" },
} satisfies Decision;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-clearance-reader-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSessionFile(path: string): Promise<void> {
  const header = {
    type: "session",
    id: "session-1",
    timestamp: "2026-06-25T09:00:00.000Z",
    cwd: "/tmp/project",
  };
  const message = {
    type: "message",
    id: "assistant-1",
    parentId: null,
    timestamp: "2026-06-25T10:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tool-1",
          name: "bash",
          arguments: { command: "git status --short" },
        },
      ],
    },
  };

  await writeFile(
    path,
    `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
    "utf8",
  );
}

async function writeAuditLog(path: string): Promise<void> {
  const policy = createPolicyDecisionEntry(
    {
      entryType: "policy.decision",
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "bash",
      toolInput: { command: "git status --short" },
      decision: reviewDecision,
    },
    { clock: () => new Date("2026-06-25T10:00:01.000Z") },
  );
  const reviewer = createReviewerDecisionEntry(
    {
      entryType: "reviewer.decision",
      sessionId: "session-1",
      toolCallId: "tool-1",
      reviewerMode: "model",
      toolName: "bash",
      toolInput: { command: "git status --short" },
      originalDecision: reviewDecision,
      finalDecision: allowDecision,
    },
    { clock: () => new Date("2026-06-25T10:00:02.000Z") },
  );

  await writeFile(`${path}.1`, `${JSON.stringify(policy)}\n`, "utf8");
  await writeFile(path, `${JSON.stringify(reviewer)}\n`, "utf8");
}

async function writeCorpusFile(path: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify([
      {
        command: "pnpm check",
        expected: "review",
        reason: "project-local verification command",
      },
    ]),
    "utf8",
  );
}

describe("replay reader composition root", () => {
  it("composes session, audit, and corpus sources and joins audit outcomes by toolCallId", async () => {
    await withTempDir(async (dir) => {
      const sessionFilePath = join(dir, "session.jsonl");
      const auditLogPath = join(dir, "audit.log");
      const corpusPath = join(dir, "corpus.json");
      await writeSessionFile(sessionFilePath);
      await writeAuditLog(auditLogPath);
      await writeCorpusFile(corpusPath);

      const corpus = readReplayCorpus({
        sessionFilePath,
        auditLogPath,
        corpusPaths: [corpusPath],
      });

      expect(corpus.warnings).toEqual([]);
      expect(corpus.entries).toHaveLength(2);
      expect(corpus.entries[0]).toMatchObject({
        command: "git status --short",
        toolCallId: "tool-1",
        source: "session",
        sources: ["session", "audit"],
        deterministicOutcome: "review",
        reviewerOutcome: { mode: "model", finalEffect: "allow" },
      });
      expect(corpus.entries[1]).toMatchObject({
        command: "pnpm check",
        source: "corpus",
        expectedLabel: "review",
      });
      expect([...corpus.sourceSummary.entries()]).toEqual([
        ["session", 1],
        ["audit", 0],
        ["corpus", 1],
      ]);
    });
  });

  it("degrades gracefully across single-source and two-source modes", async () => {
    await withTempDir(async (dir) => {
      const sessionFilePath = join(dir, "session.jsonl");
      const auditLogPath = join(dir, "audit.log");
      const corpusPath = join(dir, "corpus.json");
      await writeSessionFile(sessionFilePath);
      await writeAuditLog(auditLogPath);
      await writeCorpusFile(corpusPath);

      const cases = [
        {
          name: "session-only",
          options: { sessionFilePath, auditLogPath: "", corpusPaths: [] },
          summary: [
            ["session", 1],
            ["audit", 0],
            ["corpus", 0],
          ],
          commands: ["git status --short"],
        },
        {
          name: "audit-only",
          options: { auditLogPath, corpusPaths: [] },
          summary: [
            ["session", 0],
            ["audit", 1],
            ["corpus", 0],
          ],
          commands: ["git status --short"],
        },
        {
          name: "corpus-only",
          options: { auditLogPath: "", corpusPaths: [corpusPath] },
          summary: [
            ["session", 0],
            ["audit", 0],
            ["corpus", 1],
          ],
          commands: ["pnpm check"],
        },
        {
          name: "session-and-audit",
          options: { sessionFilePath, auditLogPath, corpusPaths: [] },
          summary: [
            ["session", 1],
            ["audit", 0],
            ["corpus", 0],
          ],
          commands: ["git status --short"],
        },
        {
          name: "session-and-corpus",
          options: {
            sessionFilePath,
            auditLogPath: "",
            corpusPaths: [corpusPath],
          },
          summary: [
            ["session", 1],
            ["audit", 0],
            ["corpus", 1],
          ],
          commands: ["git status --short", "pnpm check"],
        },
        {
          name: "audit-and-corpus",
          options: { auditLogPath, corpusPaths: [corpusPath] },
          summary: [
            ["session", 0],
            ["audit", 1],
            ["corpus", 1],
          ],
          commands: ["git status --short", "pnpm check"],
        },
      ] as const;

      for (const testCase of cases) {
        const corpus = readReplayCorpus(testCase.options);
        expect(corpus.warnings, testCase.name).toEqual([]);
        expect([...corpus.sourceSummary.entries()], testCase.name).toEqual(
          testCase.summary,
        );
        expect(
          corpus.entries.map((entry) => entry.command),
          testCase.name,
        ).toEqual(testCase.commands);
      }
    });
  });

  it("does not read saved corpora unless callers opt in", () => {
    const corpus = readReplayCorpus({ auditLogPath: "" });

    expect(corpus.warnings).toEqual([]);
    expect([...corpus.sourceSummary.entries()]).toEqual([
      ["session", 0],
      ["audit", 0],
      ["corpus", 0],
    ]);
    expect(corpus.entries).toEqual([]);
  });

  it("reads fixture corpora when callers pass explicit corpus paths", () => {
    const corpus = readReplayCorpus({
      auditLogPath: "",
      corpusPaths: fixtureCorpusPaths(),
    });

    expect(corpus.warnings).toEqual([]);
    expect(corpus.sourceSummary.get("corpus")).toBeGreaterThan(0);
    expect(corpus.entries.every((entry) => entry.source === "corpus")).toBe(
      true,
    );
  });

  it("surfaces adapter warnings and pure core warnings together", async () => {
    await withTempDir(async (dir) => {
      const auditLogPath = join(dir, "audit.log");
      const noCommand = createReviewerDecisionEntry(
        {
          entryType: "reviewer.decision",
          sessionId: "session-1",
          toolCallId: "no-command",
          reviewerMode: "block-and-log",
          toolName: "read",
          toolInput: { path: "README.md" },
          originalDecision: reviewDecision,
          finalDecision: reviewDecision,
        },
        { clock: () => new Date("2026-06-25T10:00:00.000Z") },
      );
      await writeFile(auditLogPath, `${JSON.stringify(noCommand)}\n`, "utf8");

      const corpus = readReplayCorpus({
        sessionFilePath: join(dir, "missing-session.jsonl"),
        auditLogPath,
        corpusPaths: [],
      });

      expect(corpus.entries).toEqual([
        expect.objectContaining({
          command: '{"path":"README.md"}',
          toolInput: { path: "README.md" },
          toolName: "read",
          toolCallId: "no-command",
        }),
      ]);
      expect(corpus.unmatchedAuditEntries).toBe(0);
      expect(corpus.warnings).toHaveLength(1);
      expect(corpus.warnings[0]).toContain("could not read session file");
    });
  });
});
