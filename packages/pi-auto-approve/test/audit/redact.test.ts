import { describe, expect, it } from "vitest";

import {
  createPolicyDecisionEntry,
  createRatchetProposalDecisionEntry,
  createReviewerDecisionEntry,
  DEFAULT_SECRETS,
  redactEntry,
  redactString,
  redactToolShape,
  redactValue,
} from "../../src/audit/log.ts";
import type {
  BashCommandShape,
  BashStage,
  SourceSpan,
  ToolShape,
} from "../../src/parse/shape.ts";
import type { Decision } from "../../src/policy/core.ts";

const span: SourceSpan = { start: 0, end: 1 };

const allowDecision = {
  effect: "allow",
  reason: "Authorization: Bearer reviewer-visible-token",
  provenance: {
    source: "shipped",
    packId: "pack:dev",
    ruleId: "allow-safe-command",
  },
} satisfies Decision;

const reviewDecision = {
  effect: "review",
  reason: "policy fell through",
  provenance: { source: "default" },
} satisfies Decision;

function commandStage(): BashStage {
  return {
    kind: "command",
    program: {
      program: "node",
      resolvable: true,
      arguments: ["deploy", "--token", "argument-token-remains-structural"],
      flags: [],
      environment: [
        { name: "API_TOKEN", value: "environment-token-value", span },
        { name: "PASSWORD", value: "password=hunter2", span },
      ],
      span,
    },
    substitutions: [],
    redirects: [
      {
        stream: "stdin",
        targetKind: "heredoc",
        target: "password=hunter2\nplain text",
        append: false,
        span,
      },
      {
        stream: "stdout",
        targetKind: "file",
        target: "logs/api_key=abcdefghijklmnopqrstuvwxyz123456.log",
        append: false,
        span,
      },
    ],
    span,
  };
}

function bashShape(): BashCommandShape {
  const stage = commandStage();
  return {
    kind: "bash",
    rawCommand:
      "API_TOKEN=environment-token-value node deploy <<EOF\npassword=hunter2\nEOF > logs/api_key=abcdefghijklmnopqrstuvwxyz123456.log",
    blocks: [
      {
        pipeline: {
          stages: [stage],
          pipeTargets: [],
          span,
        },
        span,
      },
    ],
    stages: [stage],
    diagnostics: [],
  };
}

describe("audit redaction", () => {
  it("ships default secret patterns for tokens, bearer auth, credentials, and API keys", () => {
    expect(DEFAULT_SECRETS.length).toBeGreaterThanOrEqual(5);

    const redacted = redactString(
      [
        "Authorization: Bearer bearer-token-value",
        "oauth_token=oauth-secret-value",
        "password=hunter2",
        "secret=topsecret",
        "token=plain-token-value",
        "api_key=abcdefghijklmnopqrstuvwxyz123456",
        "sk_abcdefghijklmnopqrstuvwxyz123456",
      ].join(" "),
    );

    expect(redacted).toContain("Authorization: Bearer [redacted]");
    expect(redacted).toContain("oauth_token=[redacted]");
    expect(redacted).toContain("password=[redacted]");
    expect(redacted).toContain("secret=[redacted]");
    expect(redacted).toContain("token=[redacted]");
    expect(redacted).toContain("api_key=[redacted]");
    expect(redacted).not.toContain("bearer-token-value");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("truncates long strings to a fixed length marker", () => {
    expect(redactString("x".repeat(12), { maxStringLength: 5 })).toBe(
      "[redacted:len=12]",
    );
  });

  it("walks nested values without changing non-string leaves", () => {
    const input = {
      command: "echo password=hunter2",
      nested: ["token=plain-token-value", { safe: true, count: 3 }],
      missing: null,
    };

    const output = redactValue(input);

    expect(output).toEqual({
      command: "echo password=[redacted]",
      nested: ["token=[redacted]", { safe: true, count: 3 }],
      missing: null,
    });
    expect(output).not.toBe(input);
    expect((output as typeof input).nested).not.toBe(input.nested);
  });

  it("redacts bash environment values, raw commands, redirects, and heredocs", () => {
    const shape = bashShape();

    const redacted = redactToolShape(shape) as BashCommandShape;
    const flatStage = redacted.stages[0];
    const blockStage = redacted.blocks[0]?.pipeline.stages[0];

    expect(redacted.rawCommand).toContain("password=[redacted]");
    expect(redacted.rawCommand).toContain("api_key=[redacted]");
    expect(flatStage?.kind).toBe("command");
    expect(blockStage?.kind).toBe("command");
    if (flatStage?.kind !== "command" || blockStage?.kind !== "command") {
      throw new Error("expected command stages");
    }
    expect(
      flatStage.program.environment.map((assignment) => assignment.value),
    ).toEqual(["[redacted]", "[redacted]"]);
    expect(
      blockStage.program.environment.map((assignment) => assignment.value),
    ).toEqual(["[redacted]", "[redacted]"]);
    expect(flatStage.program.arguments).toEqual([
      "deploy",
      "--token",
      "argument-token-remains-structural",
    ]);
    expect(flatStage.redirects.map((redirect) => redirect.target)).toEqual([
      "password=[redacted]\nplain text",
      "logs/api_key=[redacted]",
    ]);
  });

  it("redacts policy entries with specialized shape handling and preserves inputs", () => {
    const shape = bashShape();
    const entry = createPolicyDecisionEntry(
      {
        entryType: "policy.decision",
        toolName: "bash",
        toolInput: {
          command: "echo password=hunter2",
          env: { API_TOKEN: "token=plain-token-value" },
        },
        shape,
        decision: allowDecision,
      },
      { clock: () => new Date("2026-06-25T00:00:00.000Z") },
    );
    const original = structuredClone(entry);

    const redacted = redactEntry(entry);

    expect(entry).toEqual(original);
    expect(redacted).not.toBe(entry);
    expect(redacted.toolInput).toEqual({
      command: "echo password=[redacted]",
      env: { API_TOKEN: "token=[redacted]" },
    });
    expect(redacted.decision.reason).toBe("Authorization: Bearer [redacted]");
    expect(redacted.shape).not.toBe(entry.shape);
    expect((redacted.shape as ToolShape).kind).toBe("bash");
    expect((redacted.shape as BashCommandShape).rawCommand).toContain(
      "password=[redacted]",
    );
  });

  it("redacts ratchet proposal decision audit entries generically", () => {
    const entry = createRatchetProposalDecisionEntry(
      {
        entryType: "ratchet.proposal-decision",
        projectPath: "/repo",
        batchId: "batch-1",
        proposalId: "proposal-1",
        proposalKind: "data-pack-policy",
        applicationMode: "writable-after-approval",
        decision: "accept",
        targetKind: "user-global-config",
        targetPath: "/home/user/token=plain-token-value/global.json",
        write: {
          attempted: true,
          ok: false,
          changed: true,
          planId: "ratchet-proposal:123",
          backupPath: "/home/user/password=hunter2/global.json.bak",
          reason:
            "post-write replay failed with api_key=abcdefghijklmnopqrstuvwxyz123456",
        },
        postWriteReplay: {
          status: "failed",
          changedCalls: 1,
          regressionCount: 1,
        },
      },
      { clock: () => new Date("2026-06-25T00:00:00.000Z") },
    );
    const original = structuredClone(entry);

    const redacted = redactEntry(entry);

    expect(entry).toEqual(original);
    expect(redacted).not.toBe(entry);
    expect(redacted.targetPath).toBe("/home/user/token=[redacted]");
    expect(redacted.write.backupPath).toBe("/home/user/password=[redacted]");
    expect(redacted.write.reason).toBe(
      "post-write replay failed with api_key=[redacted]",
    );
    expect("proposal" in redacted).toBe(false);
    expect("cardMarkdown" in redacted).toBe(false);
    expect("revision" in redacted).toBe(false);
  });

  it("preserves reviewer decision audit labels while redacting reviewer inputs", () => {
    const entry = createReviewerDecisionEntry(
      {
        entryType: "reviewer.decision",
        reviewerMode: "model",
        toolName: "bash",
        toolInput: { command: "echo password=hunter2" },
        originalDecision: reviewDecision,
        finalDecision: allowDecision,
        escalated: true,
        contextMode: "minimal",
        recentContextAttached: true,
        budgetExhausted: false,
      },
      { clock: () => new Date("2026-06-25T00:00:00.000Z") },
    );
    const original = structuredClone(entry);

    const redacted = redactEntry(entry);

    expect(entry).toEqual(original);
    expect(redacted).not.toBe(entry);
    expect(redacted.toolInput).toEqual({ command: "echo password=[redacted]" });
    expect(redacted.escalated).toBe(true);
    expect(redacted.contextMode).toBe("minimal");
    expect(redacted.recentContextAttached).toBe(true);
    expect(redacted.budgetExhausted).toBe(false);
  });
});
