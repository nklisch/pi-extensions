import { describe, expect, it } from "vitest";

import {
  type AuditEntry,
  createConfigEventEntry,
  createPolicyDecisionEntry,
  createRatchetProposalDecisionEntry,
  createReplayInputEntry,
  createReviewerDecisionEntry,
  createTrustEventEntry,
} from "../../src/audit/log.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import type { Decision } from "../../src/policy/core.ts";

const fixedDate = new Date("2026-06-25T12:34:56.789Z");
const fixedClock = () => fixedDate;

const allowDecision = {
  effect: "allow",
  reason: "matched read-only inspection",
  provenance: {
    source: "shipped",
    packId: "pack:git-read",
    ruleId: "git-status",
  },
} satisfies Decision;

const reviewDecision = {
  effect: "review",
  reason: "policy fell through",
  provenance: { source: "default" },
} satisfies Decision;

const bashShape = {
  kind: "bash",
  rawCommand: "git status --short",
  blocks: [],
  stages: [],
  diagnostics: [],
} satisfies ToolShape;

function describeEntry(entry: AuditEntry): string {
  switch (entry.entryType) {
    case "policy.decision":
      return `${entry.entryType}:${entry.decision.effect}:${entry.toolName}`;
    case "reviewer.decision":
      return `${entry.entryType}:${entry.originalDecision.effect}->${entry.finalDecision.effect}`;
    case "trust.event":
      return `${entry.entryType}:${entry.event}:${entry.reason}`;
    case "config.event":
      return `${entry.entryType}:${entry.event}:${entry.mode ?? "none"}`;
    case "replay.input":
      return `${entry.entryType}:${entry.commandCount}`;
    case "ratchet.proposal-decision":
      return `${entry.entryType}:${entry.decision}:${entry.proposalId}`;
  }
}

describe("audit entry factories", () => {
  it("stamps version and deterministic ISO timestamps", () => {
    const entry = createConfigEventEntry(
      {
        entryType: "config.event",
        event: "mode-selected",
        mode: "ask",
        projectPath: "/repo",
        sessionId: "session-1",
        toolCallId: "tool-1",
      },
      { clock: fixedClock },
    );

    expect(entry).toMatchObject({
      version: 1,
      timestamp: "2026-06-25T12:34:56.789Z",
      entryType: "config.event",
      event: "mode-selected",
      mode: "ask",
      projectPath: "/repo",
      sessionId: "session-1",
      toolCallId: "tool-1",
    });
  });

  it("creates discriminated policy decision entries with pure Decision payloads", () => {
    const entry = createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        toolName: "bash",
        toolInput: { command: "git status --short" },
        shape: bashShape,
        decision: allowDecision,
      },
      { clock: fixedClock },
    );

    expect(entry.entryType).toBe("policy.decision");
    expect(entry.decision).toBe(allowDecision);
    expect(entry.shape).toBe(bashShape);
    expect(describeEntry(entry)).toBe("policy.decision:allow:bash");
  });

  it("creates discriminated reviewer decision entries", () => {
    const entry = createReviewerDecisionEntry(
      {
        entryType: "reviewer.decision",
        reviewerMode: "model",
        toolName: "bash",
        toolInput: { command: "pnpm test" },
        originalDecision: reviewDecision,
        finalDecision: allowDecision,
      },
      { clock: fixedClock },
    );

    expect(entry).toMatchObject({
      version: 1,
      timestamp: "2026-06-25T12:34:56.789Z",
      entryType: "reviewer.decision",
      reviewerMode: "model",
      toolName: "bash",
    });
    expect(Object.hasOwn(entry, "escalated")).toBe(false);
    expect(Object.hasOwn(entry, "contextMode")).toBe(false);
    expect(Object.hasOwn(entry, "recentContextAttached")).toBe(false);
    expect(Object.hasOwn(entry, "budgetExhausted")).toBe(false);
    expect(describeEntry(entry)).toBe("reviewer.decision:review->allow");
  });

  it("carries optional reviewer decision audit labels through the factory", () => {
    const entry = createReviewerDecisionEntry(
      {
        entryType: "reviewer.decision",
        reviewerMode: "model",
        toolName: "bash",
        toolInput: { command: "pnpm test" },
        originalDecision: reviewDecision,
        finalDecision: allowDecision,
        escalated: true,
        contextMode: "recentContext",
        recentContextAttached: true,
        budgetExhausted: false,
        reviewerModel: { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
        reviewerModelSource: "configured",
        reviewerModelNote: "configured reviewer model resolved",
      },
      { clock: fixedClock },
    );

    expect(entry).toMatchObject({
      escalated: true,
      contextMode: "recentContext",
      recentContextAttached: true,
      budgetExhausted: false,
      reviewerModel: { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
      reviewerModelSource: "configured",
      reviewerModelNote: "configured reviewer model resolved",
    });
  });

  it("creates trust, config, and replay entries with their own payloads", () => {
    const trust = createTrustEventEntry(
      {
        entryType: "trust.event",
        event: "project-trusted",
        projectPath: "/repo",
        reason: "Pi project trust signal",
      },
      { clock: fixedClock },
    );
    const config = createConfigEventEntry(
      {
        entryType: "config.event",
        event: "config-load-failed",
        errors: ["invalid posture"],
      },
      { clock: fixedClock },
    );
    const replay = createReplayInputEntry(
      {
        entryType: "replay.input",
        corpusId: "recent-session",
        commandCount: 42,
      },
      { clock: fixedClock },
    );

    expect(describeEntry(trust)).toBe(
      "trust.event:project-trusted:Pi project trust signal",
    );
    expect(describeEntry(config)).toBe("config.event:config-load-failed:none");
    expect(describeEntry(replay)).toBe("replay.input:42");
  });

  it("creates ratchet proposal decision entries without proposal payloads", () => {
    const entry = createRatchetProposalDecisionEntry(
      {
        entryType: "ratchet.proposal-decision",
        projectPath: "/repo",
        toolCallId: "tool-1",
        batchId: "batch-1",
        proposalId: "proposal-1",
        proposalKind: "data-pack-policy",
        applicationMode: "writable-after-approval",
        decision: "accept",
        targetKind: "user-global-config",
        targetPath: "/home/user/.config/pi/pi-auto-approve/global.json",
        write: {
          attempted: true,
          ok: true,
          changed: true,
          planId: "ratchet-proposal:123",
          backupPath: "/home/user/.config/pi/pi-auto-approve/global.json.bak",
        },
        postWriteReplay: {
          status: "passed",
          changedCalls: 2,
          regressionCount: 0,
        },
      },
      { clock: fixedClock },
    );

    expect(entry).toMatchObject({
      version: 1,
      timestamp: "2026-06-25T12:34:56.789Z",
      entryType: "ratchet.proposal-decision",
      proposalId: "proposal-1",
      decision: "accept",
      write: { attempted: true, ok: true, changed: true },
      postWriteReplay: { status: "passed", changedCalls: 2 },
    });
    expect(Object.hasOwn(entry, "proposal")).toBe(false);
    expect(Object.hasOwn(entry, "cardMarkdown")).toBe(false);
    expect(describeEntry(entry)).toBe(
      "ratchet.proposal-decision:accept:proposal-1",
    );
  });

  it("uses the current time when no clock is provided", () => {
    const entry = createReplayInputEntry({
      entryType: "replay.input",
      commandCount: 1,
    });

    expect(entry.version).toBe(1);
    expect(Date.parse(entry.timestamp)).not.toBeNaN();
  });
});
