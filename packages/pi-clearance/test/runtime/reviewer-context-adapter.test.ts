import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedReviewerConfig } from "../../src/config/loader.ts";
import {
  gatherReviewerContext,
  type ReviewerContextSources,
} from "../../src/runtime/reviewer-context.ts";
import {
  type AuditEntry,
  createConfigEventEntry,
  createPolicyDecisionEntry,
  createReviewerDecisionEntry,
} from "../../src/audit/entry.ts";
import type { Decision } from "../../src/policy/core.ts";
import {
  createAuditLogRecentDecisionSource,
  createSessionConversationTurnSource,
} from "../../src/runtime/reviewer-context-adapter.ts";
import {
  createDefaultAuditSink,
  defaultAuditLogPath,
} from "../../src/runtime/sink.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "pi-clearance-reviewer-context-adapter-"),
  );
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("audit-log recent decision source", () => {
  it("returns policy and reviewer decisions newest-first and bounds scanned segments", () => {
    const root = tempRoot();
    const logPath = defaultAuditLogPath(root);

    writeEntries(logPath, [
      policyEntry("2026-06-25T12:00:00.000Z", "active older"),
      configEntry("2026-06-25T12:01:00.000Z"),
      reviewerEntry("2026-06-25T12:02:00.000Z", "active newer"),
    ]);
    writeEntries(`${logPath}.1`, [
      policyEntry("2026-06-25T11:00:00.000Z", "rotated older"),
    ]);

    const activeOnly = createAuditLogRecentDecisionSource({
      path: logPath,
      maxSegments: 1,
    }).readRecent();

    expect(activeOnly.warnings).toEqual([]);
    expect(activeOnly.items.map((entry) => entry.reason)).toEqual([
      "active newer",
      "active older",
    ]);
    expect(activeOnly.items.map((entry) => entry.entryType)).toEqual([
      "reviewer.decision",
      "policy.decision",
    ]);
    expect(activeOnly.items[0]).toMatchObject({
      effect: "allow",
      reviewerMode: "model",
      reviewerDecisionSource: "model",
      reviewerModel: { provider: "openai-codex", id: "gpt-test" },
      reviewerModelSource: "configured",
      command: "pnpm test",
      originalEffect: "review",
      finalEffect: "allow",
      finalProvenance: { source: "generated", packId: "reviewer:model" },
    });
    expect(activeOnly.items[1]).toMatchObject({
      provenance: {
        source: "default",
        packId: "pack:test",
        ruleId: "rule:test",
      },
    });

    const withRotated = createAuditLogRecentDecisionSource({
      path: logPath,
      maxSegments: 2,
    }).readRecent();

    expect(withRotated.items.map((entry) => entry.reason)).toEqual([
      "active newer",
      "active older",
      "rotated older",
    ]);
  });

  it("uses the same default audit path as createDefaultAuditSink", () => {
    const root = tempRoot();
    const sink = createDefaultAuditSink({ userConfigRoot: root });

    sink.appendSync(policyEntry("2026-06-25T12:00:00.000Z", "same path"));

    const logPath = defaultAuditLogPath(root);
    expect(readFileSync(logPath, "utf8")).toContain("same path");

    const source = createAuditLogRecentDecisionSource({ path: logPath });
    expect(source.readRecent().items[0]?.reason).toBe("same path");
  });
});

describe("session conversation turn source", () => {
  it("excludes a Clearance allow custom message from curated intent and conversation", async () => {
    const source = createSessionConversationTurnSource({
      sessionManager: sessionManager([
        messageEntry("assistant-1", "2026-06-25T12:02:00.000Z", {
          role: "assistant",
          content: [{ type: "text", text: "ordinary assistant context" }],
        }),
        clearanceAllowRequestEntry(),
        messageEntry("user-1", "2026-06-25T12:00:00.000Z", {
          role: "user",
          content: [{ type: "text", text: "please run the focused tests" }],
        }),
      ]),
    });
    const sources: ReviewerContextSources = {
      decisions: { readRecent: () => ({ items: [], warnings: [] }) },
      conversation: source,
    };

    const bundle = await gatherReviewerContext(
      sources,
      reviewerContextConfig(),
      { now: new Date("2026-06-25T12:03:00.000Z") },
    );

    expect(bundle?.userIntentTurns?.map((turn) => turn.text)).toEqual([
      "please run the focused tests",
    ]);
    expect(bundle?.conversationTurns.map((turn) => turn.text)).toEqual([
      "ordinary assistant context",
    ]);
    expect(JSON.stringify(bundle)).not.toContain("clearance.allow-request");
    expect(JSON.stringify(bundle)).not.toContain("Author a policy proposal");
  });

  it("returns only user and assistant text content from the current branch", () => {
    const source = createSessionConversationTurnSource({
      sessionManager: sessionManager([
        messageEntry("assistant-2", "2026-06-25T12:04:00.000Z", {
          role: "assistant",
          content: [
            { type: "text", text: "visible assistant" },
            { type: "thinking", thinking: "hidden thinking" },
            {
              type: "toolCall",
              id: "tool-call-1",
              name: "bash",
              arguments: { command: "pnpm test" },
            },
          ],
        }),
        toolResultEntry("tool output should not appear"),
        hiddenCustomMessageEntry("hidden custom should not appear"),
        customEntry(),
        compactionEntry(),
        messageEntry("user-1", "2026-06-25T12:00:00.000Z", {
          role: "user",
          content: [
            { type: "text", text: "visible user" },
            {
              type: "image",
              data: "image-bytes-should-not-appear",
              mimeType: "image/png",
            },
          ],
        }),
      ]),
    });

    const result = source.readRecent();

    expect(result.warnings).toEqual([]);
    expect(result.items).toEqual([
      {
        role: "user",
        text: "visible user",
        timestamp: "2026-06-25T12:00:00.000Z",
      },
      {
        role: "assistant",
        text: "visible assistant",
        timestamp: "2026-06-25T12:04:00.000Z",
      },
    ]);
    expect(JSON.stringify(result.items)).not.toContain("tool output");
    expect(JSON.stringify(result.items)).not.toContain("hidden thinking");
    expect(JSON.stringify(result.items)).not.toContain("image-bytes");
    expect(JSON.stringify(result.items)).not.toContain("hidden custom");
  });
});

function writeEntries(filePath: string, entries: readonly AuditEntry[]): void {
  writeFileSync(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function policyEntry(timestamp: string, reason: string): AuditEntry {
  return createPolicyDecisionEntry(
    {
      entryType: "policy.decision",
      toolName: "bash",
      toolInput: { command: "pnpm test" },
      decision: {
        ...decision("review", reason),
        provenance: {
          source: "default",
          packId: "pack:test",
          ruleId: "rule:test",
        },
      },
    },
    { clock: () => new Date(timestamp) },
  );
}

function reviewerEntry(timestamp: string, reason: string): AuditEntry {
  return createReviewerDecisionEntry(
    {
      entryType: "reviewer.decision",
      reviewerMode: "model",
      toolName: "bash",
      toolInput: { command: "pnpm test" },
      originalDecision: decision("review", "needs review"),
      finalDecision: {
        ...decision("allow", reason),
        provenance: { source: "generated", packId: "reviewer:model" },
      },
      decisionSource: "model",
      reviewerModel: { provider: "openai-codex", id: "gpt-test" },
      reviewerModelSource: "configured",
    },
    { clock: () => new Date(timestamp) },
  );
}

function configEntry(timestamp: string): AuditEntry {
  return createConfigEventEntry(
    {
      entryType: "config.event",
      event: "config-loaded",
    },
    { clock: () => new Date(timestamp) },
  );
}

function decision(effect: Decision["effect"], reason: string): Decision {
  return { effect, reason, provenance: { source: "default" } };
}

function sessionManager(
  branch: readonly unknown[],
): ExtensionContext["sessionManager"] {
  return {
    getBranch: () => branch,
  } as unknown as ExtensionContext["sessionManager"];
}

function messageEntry(
  id: string,
  timestamp: string,
  message: unknown,
): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message,
  };
}

function toolResultEntry(text: string): unknown {
  return messageEntry("tool-result", "2026-06-25T12:03:00.000Z", {
    role: "toolResult",
    toolCallId: "tool-call-1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  });
}

function hiddenCustomMessageEntry(content: string): unknown {
  return {
    type: "custom_message",
    id: "hidden-custom",
    parentId: null,
    timestamp: "2026-06-25T12:02:00.000Z",
    customType: "test",
    content,
    display: false,
  };
}

function clearanceAllowRequestEntry(): unknown {
  return {
    type: "custom_message",
    id: "clearance-allow-request",
    parentId: null,
    timestamp: "2026-06-25T12:01:00.000Z",
    customType: "clearance.allow-request",
    content: [
      {
        type: "text",
        text: "[Pi Clearance] Author a policy proposal for the user's request.",
      },
    ],
    details: {
      brief: "Author a policy proposal for the user's request.",
      form: "free-text",
    },
    display: true,
  };
}

function reviewerContextConfig(): ResolvedReviewerConfig {
  return {
    promptPosture: "reviewer.default",
    promptAppends: [],
    projectPromptAppends: [],
    promptOverride: null,
    model: null,
    tokenBudget: { window: "24h", limit: null },
    contextMode: "recentContext",
    recentContext: {
      decisionLimit: 25,
      decisionWindow: "2h",
      conversationTurns: 3,
      userTurns: 5,
      conversationCharLimit: 6000,
    },
    escalation: { enabled: true, denialLimit: 3, window: "10m" },
  };
}

function customEntry(): unknown {
  return {
    type: "custom",
    id: "custom",
    parentId: null,
    timestamp: "2026-06-25T12:02:30.000Z",
    customType: "test",
    data: { text: "custom should not appear" },
  };
}

function compactionEntry(): unknown {
  return {
    type: "compaction",
    id: "compaction",
    parentId: null,
    timestamp: "2026-06-25T12:01:00.000Z",
    summary: "compaction should not appear",
    firstKeptEntryId: "user-1",
    tokensBefore: 123,
  };
}
