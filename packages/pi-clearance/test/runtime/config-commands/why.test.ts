import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AuditEntry,
  createPolicyDecisionEntry,
  createReviewerDecisionEntry,
} from "../../../src/audit/entry.ts";
import { createAuditLogger } from "../../../src/audit/logger.ts";
import type { Decision } from "../../../src/policy/core.ts";
import { getClearanceArgumentCompletions } from "../../../src/runtime/command-registry.ts";
import type { AutoReviewerCommandDependencies } from "../../../src/runtime/config-commands/types.ts";
import { handleWhyCommand } from "../../../src/runtime/config-commands/why.ts";
import { createDefaultAuditSink } from "../../../src/runtime/sink.ts";

const ORIGINAL_ENV = { ...process.env };
const tempRoots: string[] = [];

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-clearance-why-"));
  tempRoots.push(root);
  process.env = {
    ...ORIGINAL_ENV,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("handleWhyCommand", () => {
  it("renders the parsed shape as debug-only JSON", async () => {
    await writeAuditEntries([
      policyEntry({
        timestamp: "2026-06-25T12:00:00.000Z",
        command: "grep -rn foo src/",
        effect: "review",
        reason: "no matching rule",
        provenance: { source: "default" },
        shape: {
          kind: "bash",
          rawCommand: "grep -rn foo src/",
          blocks: [],
          stages: [],
          diagnostics: [],
        },
      }),
    ]);

    const report = handleWhyCommand([], noUiContext(), dependencies());

    expect(report.markdown).toContain("### Parsed shape (debug)");
    expect(report.markdown).toContain('"rawCommand": "grep -rn foo src/"');
  });

  it("renders the most recent policy decision with provenance fields", async () => {
    await writeAuditEntries([
      policyEntry({
        timestamp: "2026-06-25T12:00:00.000Z",
        command: "pnpm test",
        effect: "allow",
        reason: "read-only test command",
        provenance: {
          source: "user-project",
          packId: "pack:project-tests",
          ruleId: "allow-pnpm-test",
        },
      }),
    ]);

    const report = handleWhyCommand([], noUiContext(), dependencies());

    expect(report.title).toBe("Debrief");
    expect(report.markdown).toContain("# Debrief");
    expect(report.markdown).toContain("Tool: `bash`");
    expect(report.markdown).toContain("Command: `pnpm test`");
    expect(report.markdown).toContain("Effect: `allow`");
    expect(report.markdown).toContain("Reason: read-only test command");
    expect(report.markdown).toContain("Rule id: `allow-pnpm-test`");
    expect(report.markdown).toContain("Pack: `pack:project-tests`");
    expect(report.markdown).toContain("Provenance: `user-project`");
    expect(report.markdown).toContain(
      "Reviewer original outcome: not recorded",
    );
    expect(report.details).toMatchObject({ count: 1, requestedCount: 1 });
  });

  it("renders reviewer original/final outcome, source, and model fields", async () => {
    await writeAuditEntries([
      reviewerEntry({
        timestamp: "2026-06-25T12:01:00.000Z",
        command: "pnpm test",
        original: decision("review", "policy asked for review", {
          source: "default",
        }),
        final: decision("allow", "model accepted bounded command", {
          source: "generated",
          packId: "reviewer:model",
          ruleId: "model-allow",
        }),
      }),
    ]);

    const report = handleWhyCommand([], noUiContext(), dependencies());

    expect(report.markdown).toContain(
      "Reviewer original outcome: `review` — policy asked for review",
    );
    expect(report.markdown).toContain(
      "Reviewer final outcome: `allow` — model accepted bounded command",
    );
    expect(report.markdown).toContain("Reviewer source: `model`");
    expect(report.markdown).toContain(
      "Reviewer model: `openai-codex/gpt-test`",
    );
    expect(report.markdown).toContain("Reviewer model source: `configured`");
    expect(report.markdown).toContain("Reviewer path: `model`");
    expect(report.markdown).toContain("Rule id: `model-allow`");
    expect(report.markdown).toContain("Pack: `reviewer:model`");
    expect(report.markdown).toContain("Provenance: `generated`");
  });

  it("returns a bounded newest-first slice for why count", async () => {
    await writeAuditEntries(
      Array.from({ length: 7 }, (_, index) =>
        policyEntry({
          timestamp: `2026-06-25T12:0${index}:00.000Z`,
          command: `echo ${index}`,
          effect: "allow",
          reason: `decision ${index}`,
          provenance: { source: "default" },
        }),
      ),
    );

    const report = handleWhyCommand(["99"], noUiContext(), dependencies());

    expect(report.details).toMatchObject({
      count: 5,
      requestedCount: 99,
      cappedAt: 5,
    });
    expect(report.markdown).toContain("decision 6");
    expect(report.markdown).toContain("decision 2");
    expect(report.markdown).not.toContain("decision 1");
    expect(report.markdown.indexOf("decision 6")).toBeLessThan(
      report.markdown.indexOf("decision 5"),
    );
  });

  it("reports an empty audit log without emitting a decision card", () => {
    const report = handleWhyCommand([], noUiContext(), dependencies());

    expect(report.summary).toBe("No clearance decisions recorded yet.");
    expect(report.markdown).toBe(
      "# Debrief\n\nNo clearance decisions recorded yet.",
    );
    expect(report.details).toMatchObject({ count: 0, decisions: [] });
  });

  it("returns usage for invalid arguments", () => {
    for (const args of [["two"], ["0"], ["1", "extra"]] as const) {
      const report = handleWhyCommand(args, noUiContext(), dependencies());
      expect(report.level).toBe("error");
      expect(report.markdown).toContain("# Pi Clearance usage");
      expect(report.markdown).toContain("Expected `why` or `why <count>`");
    }
  });

  it("succeeds without UI and does not prompt or write", async () => {
    await writeAuditEntries([
      policyEntry({
        timestamp: "2026-06-25T12:00:00.000Z",
        command: "pnpm test",
        effect: "allow",
        reason: "read-only",
        provenance: { source: "default" },
      }),
    ]);
    const ctx = noUiContext();

    const report = handleWhyCommand([], ctx, dependencies());

    expect(report.markdown).toContain("# Debrief");
    expect(ctx.confirmCalls).toEqual([]);
    expect(ctx.notifications).toEqual([]);
  });

  it("uses the audit redaction rules for command display", async () => {
    await writeAuditEntries([
      policyEntry({
        timestamp: "2026-06-25T12:00:00.000Z",
        command:
          "echo password=hunter2 api_key=abcdefghijklmnopqrstuvwxyz123456",
        effect: "review",
        reason: "Authorization: Bearer abc",
        provenance: { source: "default" },
      }),
    ]);

    const report = handleWhyCommand([], noUiContext(), dependencies());

    expect(report.markdown).toContain("password=[redacted]");
    expect(report.markdown).toContain("api_key=[redacted]");
    expect(report.markdown).toContain("Authorization: Bearer [redacted]");
    expect(report.markdown).not.toContain("hunter2");
    expect(report.markdown).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});

describe("why command registry completion", () => {
  it("includes why in the first-level clearance completions", () => {
    expect(
      values(getClearanceArgumentCompletions("", dependencies())),
    ).toContain("why");
  });
});

async function writeAuditEntries(
  entries: readonly AuditEntry[],
): Promise<void> {
  const logger = createAuditLogger({ sink: createDefaultAuditSink() });
  for (const entry of entries) {
    await logger.log(entry);
  }
}

function policyEntry(input: {
  readonly timestamp: string;
  readonly command: string;
  readonly effect: Decision["effect"];
  readonly reason: string;
  readonly provenance: Decision["provenance"];
  readonly shape?: Parameters<typeof createPolicyDecisionEntry>[0]["shape"];
}): AuditEntry {
  return createPolicyDecisionEntry(
    {
      entryType: "policy.decision",
      toolName: "bash",
      toolInput: { command: input.command },
      decision: decision(input.effect, input.reason, input.provenance),
      ...(input.shape === undefined ? {} : { shape: input.shape }),
    },
    { clock: () => new Date(input.timestamp) },
  );
}

function reviewerEntry(input: {
  readonly timestamp: string;
  readonly command: string;
  readonly original: Decision;
  readonly final: Decision;
}): AuditEntry {
  return createReviewerDecisionEntry(
    {
      entryType: "reviewer.decision",
      reviewerMode: "model",
      toolName: "bash",
      toolInput: { command: input.command },
      originalDecision: input.original,
      finalDecision: input.final,
      decisionSource: "model",
      reviewerModel: { provider: "openai-codex", id: "gpt-test" },
      reviewerModelSource: "configured",
    },
    { clock: () => new Date(input.timestamp) },
  );
}

function decision(
  effect: Decision["effect"],
  reason: string,
  provenance: Decision["provenance"],
): Decision {
  return { effect, reason, provenance };
}

interface FakeContext extends ExtensionCommandContext {
  readonly confirmCalls: readonly string[];
  readonly notifications: readonly string[];
}

function noUiContext(): FakeContext {
  const confirmCalls: string[] = [];
  const notifications: string[] = [];
  return {
    hasUI: false,
    cwd: "/repo",
    isProjectTrusted: () => true,
    ui: {
      async confirm(title: string): Promise<boolean> {
        confirmCalls.push(title);
        return false;
      },
      notify(message: string): void {
        notifications.push(message);
      },
    },
    confirmCalls,
    notifications,
  } as unknown as FakeContext;
}

function dependencies(): AutoReviewerCommandDependencies {
  return {} as AutoReviewerCommandDependencies;
}

function values(
  items: ReturnType<typeof getClearanceArgumentCompletions>,
): readonly string[] {
  return items?.map((item) => item.value) ?? [];
}
