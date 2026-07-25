import { describe, expect, it } from "vitest";

import {
  createPolicyDecisionEntry,
  createReviewerDecisionEntry,
} from "../../src/audit/log.ts";
import type { Decision } from "../../src/policy/core.ts";
import {
  buildReplayCorpus,
  type CorpusFixtureRow,
  redactForExport,
  type SessionToolCall,
} from "../../src/replay/history.ts";

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

const denyDecision = {
  effect: "deny",
  reason: "sealed floor matched",
  provenance: {
    source: "shipped",
    packId: "pack:floor",
    ruleId: "deny-catastrophic",
  },
} satisfies Decision;

function sessionCall(
  overrides: Partial<SessionToolCall> = {},
): SessionToolCall {
  return {
    toolCallId: "tool-1",
    toolName: "bash",
    command: "git status --short",
    sessionId: "session-1",
    timestamp: "2026-06-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("replay history correlation core", () => {
  it("joins session, policy audit, and reviewer audit outcomes by toolCallId", () => {
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

    const corpus = buildReplayCorpus({
      session: [sessionCall()],
      audit: [policy, reviewer],
    });

    expect(corpus.entries).toHaveLength(1);
    expect(corpus.entries[0]).toMatchObject({
      command: "git status --short",
      toolName: "bash",
      toolCallId: "tool-1",
      sessionId: "session-1",
      source: "session",
      sources: ["session", "audit"],
      fidelity: "high",
      deterministicOutcome: "review",
      reviewerOutcome: { mode: "model", finalEffect: "allow" },
    });
    expect([...corpus.sourceSummary.entries()]).toEqual([
      ["session", 1],
      ["audit", 0],
      ["corpus", 0],
    ]);
    expect(corpus.unmatchedAuditEntries).toBe(0);
    expect(corpus.warnings).toEqual([]);
  });

  it("falls back to sessionId, toolName, and command when audit toolCallId is absent", () => {
    const policy = createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        sessionId: "session-1",
        toolName: "bash",
        toolInput: { command: "pnpm test" },
        decision: allowDecision,
      },
      { clock: () => new Date("2026-06-25T10:00:01.000Z") },
    );

    const corpus = buildReplayCorpus({
      session: [sessionCall({ toolCallId: "tool-2", command: "pnpm test" })],
      audit: [policy],
    });

    expect(corpus.entries).toHaveLength(1);
    expect(corpus.entries[0]?.source).toBe("session");
    expect(corpus.entries[0]?.deterministicOutcome).toBe("allow");
    expect(corpus.entries[0]?.sources).toEqual(["session", "audit"]);
  });

  it("emits audit-only rows as redacted fidelity and counts unrecoverable audit outcomes", () => {
    const auditOnly = createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        sessionId: "session-1",
        toolCallId: "audit-only-1",
        toolName: "bash",
        toolInput: { command: "[redacted:len=512]" },
        decision: denyDecision,
      },
      { clock: () => new Date("2026-06-25T10:02:00.000Z") },
    );
    const noCommand = createReviewerDecisionEntry(
      {
        entryType: "reviewer.decision",
        sessionId: "session-1",
        toolCallId: "audit-only-2",
        reviewerMode: "block-and-log",
        toolName: "web_fetch",
        toolInput: { url: "https://example.test" },
        originalDecision: reviewDecision,
        finalDecision: reviewDecision,
      },
      { clock: () => new Date("2026-06-25T10:01:00.000Z") },
    );

    const corpus = buildReplayCorpus({ audit: [auditOnly, noCommand] });

    expect(corpus.entries).toEqual([
      expect.objectContaining({
        command: '{"url":"https://example.test"}',
        toolInput: { url: "https://example.test" },
        toolCallId: "audit-only-2",
        source: "audit",
        sources: ["audit"],
        fidelity: "redacted",
        reviewerOutcome: { mode: "block-and-log", finalEffect: "review" },
      }),
      expect.objectContaining({
        command: "[redacted:len=512]",
        toolInput: { command: "[redacted:len=512]" },
        toolCallId: "audit-only-1",
        source: "audit",
        sources: ["audit"],
        fidelity: "redacted",
        deterministicOutcome: "deny",
      }),
    ]);
    expect(corpus.unmatchedAuditEntries).toBe(0);
    expect(corpus.warnings).toEqual([]);
    expect([...corpus.sourceSummary.entries()]).toEqual([
      ["session", 0],
      ["audit", 2],
      ["corpus", 0],
    ]);
  });

  it("can drop unmatched audit warnings while still counting unmatched audit entries", () => {
    const noCommand = createReviewerDecisionEntry(
      {
        entryType: "reviewer.decision",
        sessionId: "session-1",
        toolCallId: "audit-only-2",
        reviewerMode: "block-and-log",
        toolName: "web_fetch",
        toolInput: { url: "https://example.test" },
        originalDecision: reviewDecision,
        finalDecision: reviewDecision,
      },
      { clock: () => new Date("2026-06-25T10:01:00.000Z") },
    );

    const corpus = buildReplayCorpus(
      { audit: [noCommand] },
      { dropUnmatchedAudit: true },
    );

    expect(corpus.entries).toEqual([
      expect.objectContaining({
        command: '{"url":"https://example.test"}',
        toolInput: { url: "https://example.test" },
        toolCallId: "audit-only-2",
      }),
    ]);
    expect(corpus.unmatchedAuditEntries).toBe(0);
    expect(corpus.warnings).toEqual([]);
  });

  it("emits corpus rows as high fidelity expected labels sorted by file then row index", () => {
    const rows: readonly CorpusFixtureRow[] = [
      {
        command: "rm -rf -- /",
        expected: "hard_block",
        reason: "catastrophic delete",
        provenance: "z.json",
      },
      {
        command: "git status",
        expected: "fast_path",
        reason: "read-only git",
        provenance: "a.json",
      },
      {
        command: "pnpm test",
        expected: "review",
        reason: "project-local script",
        provenance: "a.json",
      },
    ];

    const corpus = buildReplayCorpus({ corpus: rows });

    expect(corpus.entries.map((entry) => entry.command)).toEqual([
      "git status",
      "pnpm test",
      "rm -rf -- /",
    ]);
    expect(corpus.entries.map((entry) => entry.fidelity)).toEqual([
      "high",
      "high",
      "high",
    ]);
    expect(corpus.entries.map((entry) => entry.expectedLabel)).toEqual([
      "fast_path",
      "review",
      "hard_block",
    ]);
  });

  it("keeps deterministic ordering stable across repeated pure builds", () => {
    const firstSession = sessionCall({
      toolCallId: "tool-1",
      command: "first",
      timestamp: "2026-06-25T10:00:00.000Z",
    });
    const secondSession = sessionCall({
      toolCallId: "tool-2",
      command: "second",
      timestamp: "2026-06-25T10:00:01.000Z",
    });
    const laterAudit = createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        toolCallId: "audit-later",
        toolName: "bash",
        toolInput: { command: "audit-later" },
        decision: allowDecision,
      },
      { clock: () => new Date("2026-06-25T10:05:00.000Z") },
    );
    const earlierAudit = createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        toolCallId: "audit-earlier",
        toolName: "bash",
        toolInput: { command: "audit-earlier" },
        decision: allowDecision,
      },
      { clock: () => new Date("2026-06-25T10:04:00.000Z") },
    );
    const rows: readonly CorpusFixtureRow[] = [
      {
        command: "corpus-b",
        expected: "review",
        reason: "fixture b",
        provenance: "b.json",
      },
      {
        command: "corpus-a",
        expected: "fast_path",
        reason: "fixture a",
        provenance: "a.json",
      },
    ];
    const input = {
      session: [firstSession, secondSession],
      audit: [laterAudit, earlierAudit],
      corpus: rows,
    };

    const first = buildReplayCorpus(input);
    const second = buildReplayCorpus(input);

    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.command)).toEqual([
      "first",
      "second",
      "audit-earlier",
      "audit-later",
      "corpus-a",
      "corpus-b",
    ]);
  });

  it("deduplicates repeated audit entries by entry type, toolCallId, and timestamp", () => {
    const entry = createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        toolCallId: "duplicated",
        toolName: "bash",
        toolInput: { command: "git status" },
        decision: allowDecision,
      },
      { clock: () => new Date("2026-06-25T10:00:00.000Z") },
    );

    const corpus = buildReplayCorpus({ audit: [entry, entry] });

    expect(corpus.entries).toHaveLength(1);
    expect(corpus.entries[0]?.command).toBe("git status");
  });

  it("never throws on empty or malformed array inputs and carries caller warnings", () => {
    const corpus = buildReplayCorpus(
      {
        audit: "not an array" as never,
      },
      { warnings: ["adapter warning"] },
    );

    expect(corpus.entries).toEqual([]);
    expect(corpus.unmatchedAuditEntries).toBe(0);
    expect(corpus.warnings).toEqual([
      "adapter warning",
      "audit source was not an array; skipped",
    ]);
  });

  it("never throws on malformed entries inside source arrays", () => {
    const corpus = buildReplayCorpus({
      session: [null, sessionCall()] as never,
      audit: [
        { entryType: "policy.decision", toolCallId: "tool-1" },
        createPolicyDecisionEntry(
          {
            entryType: "policy.decision",
            toolCallId: "audit-valid",
            toolName: "bash",
            toolInput: { command: "git log --oneline -1" },
            decision: allowDecision,
          },
          { clock: () => new Date("2026-06-25T10:00:00.000Z") },
        ),
      ] as never,
      corpus: [{ command: "missing expected" }] as never,
    });

    expect(corpus.entries.map((entry) => entry.command)).toEqual([
      "git status --short",
      "git log --oneline -1",
    ]);
    expect(corpus.warnings).toEqual([
      "session entry at index 0 was malformed; skipped",
      "corpus row at index 0 was malformed; skipped",
      "policy.decision audit entry at index 0 was malformed; skipped",
    ]);
  });

  it("redacts commands for export without mutating the input entries", () => {
    const corpus = buildReplayCorpus({
      session: [
        sessionCall({
          command:
            "curl -H 'Authorization: Bearer secret-token-value' https://example.test",
        }),
      ],
    });
    const originalEntry = corpus.entries[0];

    const redacted = redactForExport(corpus.entries);

    expect(redacted).not.toBe(corpus.entries);
    expect(redacted[0]).not.toBe(originalEntry);
    expect(redacted[0]?.command).toBe(
      "curl -H 'Authorization: Bearer [redacted]' https://example.test",
    );
    expect(corpus.entries[0]?.command).toBe(
      "curl -H 'Authorization: Bearer secret-token-value' https://example.test",
    );
    expect(redacted[0]?.sources).toEqual(["session"]);
    expect(redacted[0]?.sources).not.toBe(corpus.entries[0]?.sources);
  });

  it("fails closed when export redaction options throw", () => {
    const corpus = buildReplayCorpus({
      session: [sessionCall({ command: "echo secret=leak-me" })],
    });
    const throwingPattern = {
      get flags(): string {
        throw new Error("bad regexp");
      },
      source: "secret",
    } as RegExp;

    const redacted = redactForExport(corpus.entries, {
      secretRules: [{ pattern: throwingPattern, replacement: "[redacted]" }],
    });

    expect(redacted[0]?.command).toBe("[redaction-failed]");
    expect(corpus.entries[0]?.command).toBe("echo secret=leak-me");
  });
});
