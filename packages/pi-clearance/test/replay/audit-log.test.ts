import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPolicyDecisionEntry,
  createRatchetProposalDecisionEntry,
  createReviewerDecisionEntry,
} from "../../src/audit/log.ts";
import type { Decision } from "../../src/policy/core.ts";
import {
  createFileAuditLogSource,
  parseAuditLogLines,
} from "../../src/replay/sources/audit-log.ts";

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

function policyLine(options: {
  readonly command: string;
  readonly toolCallId: string;
  readonly timestamp: string;
}): string {
  return JSON.stringify(
    createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        sessionId: "session-1",
        toolCallId: options.toolCallId,
        toolName: "bash",
        toolInput: { command: options.command },
        decision: allowDecision,
      },
      { clock: () => new Date(options.timestamp) },
    ),
  );
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-clearance-audit-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("audit log source", () => {
  it("parses valid JSONL audit entries and skips malformed or unknown lines", () => {
    const policy = createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        sessionId: "session-1",
        toolCallId: "tool-policy",
        toolName: "bash",
        toolInput: { command: "git status --short" },
        decision: allowDecision,
      },
      { clock: () => new Date("2026-06-25T10:00:00.000Z") },
    );
    const reviewer = createReviewerDecisionEntry(
      {
        entryType: "reviewer.decision",
        sessionId: "session-1",
        toolCallId: "tool-reviewer",
        reviewerMode: "model",
        toolName: "bash",
        toolInput: { command: "pnpm test" },
        originalDecision: reviewDecision,
        finalDecision: allowDecision,
      },
      { clock: () => new Date("2026-06-25T10:01:00.000Z") },
    );

    const result = parseAuditLogLines(
      [
        "",
        JSON.stringify(policy),
        "not json",
        JSON.stringify({ version: 1, timestamp: "2026", entryType: "unknown" }),
        JSON.stringify(reviewer),
      ].join("\n"),
    );

    expect(result.items).toEqual([policy, reviewer]);
    expect(result.warnings).toEqual(["skipped 2 malformed audit lines"]);
  });

  it("parses ratchet proposal decision audit entries as non-outcome audit rows", () => {
    const proposalDecision = createRatchetProposalDecisionEntry(
      {
        entryType: "ratchet.proposal-decision",
        batchId: "batch-1",
        proposalId: "proposal-1",
        proposalKind: "data-pack-policy",
        applicationMode: "writable-after-approval",
        decision: "accept",
        targetKind: "user-global-config",
        targetPath: "/config/global.json",
        write: { attempted: true, ok: true, changed: true },
        postWriteReplay: {
          status: "passed",
          changedCalls: 2,
          regressionCount: 0,
        },
      },
      { clock: () => new Date("2026-06-25T10:02:00.000Z") },
    );

    const result = parseAuditLogLines(JSON.stringify(proposalDecision));

    expect(result.items).toEqual([proposalDecision]);
    expect(result.warnings).toEqual([]);
  });

  it("reads rotated segments oldest to newest, then the active audit log", async () => {
    await withTempDir(async (dir) => {
      const active = join(dir, "audit.log");
      await writeFile(
        `${active}.2`,
        `${policyLine({
          command: "oldest",
          toolCallId: "tool-oldest",
          timestamp: "2026-06-25T10:00:00.000Z",
        })}\n`,
        "utf8",
      );
      await writeFile(
        `${active}.1`,
        `${policyLine({
          command: "newest archive",
          toolCallId: "tool-archive",
          timestamp: "2026-06-25T10:01:00.000Z",
        })}\n`,
        "utf8",
      );
      await writeFile(
        active,
        `${policyLine({
          command: "active newest",
          toolCallId: "tool-active",
          timestamp: "2026-06-25T10:02:00.000Z",
        })}\n`,
        "utf8",
      );

      const result = createFileAuditLogSource({
        path: active,
        maxSegments: 2,
      }).read();

      expect(
        result.items.map((entry) =>
          entry.entryType === "policy.decision" &&
          typeof entry.toolInput === "object" &&
          entry.toolInput !== null &&
          "command" in entry.toolInput
            ? entry.toolInput.command
            : undefined,
        ),
      ).toEqual(["oldest", "newest archive", "active newest"]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("reports malformed line counts with the segment path and keeps valid lines", async () => {
    await withTempDir(async (dir) => {
      const active = join(dir, "audit.log");
      await writeFile(
        active,
        [
          "not json",
          policyLine({
            command: "git status",
            toolCallId: "tool-valid",
            timestamp: "2026-06-25T10:00:00.000Z",
          }),
          JSON.stringify({
            version: 1,
            timestamp: "2026",
            entryType: "unknown",
          }),
        ].join("\n"),
        "utf8",
      );

      const result = createFileAuditLogSource({ path: active }).read();

      expect(result.items).toHaveLength(1);
      expect(result.warnings).toEqual([
        `skipped 2 malformed audit lines in ${active}`,
      ]);
    });
  });

  it("returns an empty result with a warning when no audit log segments exist", async () => {
    await withTempDir(async (dir) => {
      const active = join(dir, "audit.log");
      const result = createFileAuditLogSource({ path: active }).read();

      expect(result.items).toEqual([]);
      expect(result.warnings).toEqual([
        `audit log ${active} was absent; no audit entries read`,
      ]);
    });
  });

  it("honors maxSegments when scanning rotated logs", async () => {
    await withTempDir(async (dir) => {
      const active = join(dir, "audit.log");
      await writeFile(
        `${active}.2`,
        `${policyLine({
          command: "too old",
          toolCallId: "tool-too-old",
          timestamp: "2026-06-25T10:00:00.000Z",
        })}\n`,
        "utf8",
      );
      await writeFile(
        `${active}.1`,
        `${policyLine({
          command: "included archive",
          toolCallId: "tool-archive",
          timestamp: "2026-06-25T10:01:00.000Z",
        })}\n`,
        "utf8",
      );
      await writeFile(
        active,
        `${policyLine({
          command: "included active",
          toolCallId: "tool-active",
          timestamp: "2026-06-25T10:02:00.000Z",
        })}\n`,
        "utf8",
      );

      const result = createFileAuditLogSource({
        path: active,
        maxSegments: 1,
      }).read();

      expect(result.items.map((entry) => entry.toolCallId)).toEqual([
        "tool-archive",
        "tool-active",
      ]);
    });
  });
});
