import { describe, expect, it } from "vitest";
import type {
  CapturedOutcomeLabel,
  OutcomeTally,
  PerCommandRow,
  RatchetReport,
  ReplayStatus,
  ReplaySummary,
} from "../../src/replay/ratchet.ts";
import { renderRatchetMarkdown } from "../../src/replay/ratchet-markdown.ts";

const fixedGeneratedAt = "2026-06-25T12:00:00.000Z";

function summary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    totalCalls: 0,
    totalUnique: 0,
    fastPathCalls: 0,
    fastPathUnique: 0,
    reviewCalls: 0,
    reviewUnique: 0,
    hardBlockCalls: 0,
    hardBlockUnique: 0,
    byCapturedOutcome: new Map<CapturedOutcomeLabel, OutcomeTally>(),
    modelReviewLoad: { calls: 0, unique: 0 },
    redactedCalls: 0,
    ...overrides,
  };
}

function report(overrides: Partial<RatchetReport> = {}): RatchetReport {
  return {
    generatedAt: fixedGeneratedAt,
    corpus: {
      totalCalls: 0,
      totalUnique: 0,
      sources: new Map([
        ["session", 0],
        ["audit", 0],
        ["corpus", 0],
      ]),
      unmatchedAuditEntries: 0,
      warnings: [],
    },
    summary: summary(),
    topReviewedExecutables: [],
    topFastPathExecutables: [],
    topReviewedCommands: [],
    topHardBlockedCommands: [],
    topContentiousFamilies: [],
    topUnknownTools: [],
    perCommand: [],
    ...overrides,
  };
}

function row(overrides: Partial<PerCommandRow>): PerCommandRow {
  return {
    command: "git status --short",
    count: 1,
    toolName: "bash",
    executable: "git",
    status: "review",
    reason: "no matching rule",
    capturedOutcomes: new Map<CapturedOutcomeLabel, number>(),
    fidelity: "high",
    sources: ["session"],
    ...overrides,
  };
}

function statusSummary(rows: readonly PerCommandRow[]): ReplaySummary {
  const totalCalls = rows.reduce((total, item) => total + item.count, 0);
  const byStatus = (status: ReplayStatus) =>
    rows.filter((item) => item.status === status);
  const fastPath = byStatus("fast_path");
  const review = byStatus("review");
  const hardBlock = byStatus("hard_block");
  return summary({
    totalCalls,
    totalUnique: rows.length,
    fastPathCalls: fastPath.reduce((total, item) => total + item.count, 0),
    fastPathUnique: fastPath.length,
    reviewCalls: review.reduce((total, item) => total + item.count, 0),
    reviewUnique: review.length,
    hardBlockCalls: hardBlock.reduce((total, item) => total + item.count, 0),
    hardBlockUnique: hardBlock.length,
  });
}

describe("ratchet markdown renderer", () => {
  it("snapshot-renders a single-mode report in reference section order", () => {
    const reviewed = row({
      command: "pnpm test -- --runInBand",
      count: 2,
      executable: "pnpm",
      status: "review",
      reason: "review-dev-workflow: needs package-script review",
      capturedOutcomes: new Map([["model-review", 2]]),
      fidelity: "redacted",
      sources: ["audit"],
    });
    const fastPath = row({
      command: "git status --short",
      status: "fast_path",
      reason: "allow-readonly-git: read-only Git inspection",
      capturedOutcomes: new Map([["deterministic-allow", 1]]),
    });
    const rows = [reviewed, fastPath];

    const markdown = renderRatchetMarkdown(
      report({
        repoRoot: "/repo",
        sourcePath: "saved-corpus.json",
        summary: summary({
          totalCalls: 3,
          totalUnique: 2,
          fastPathCalls: 1,
          fastPathUnique: 1,
          reviewCalls: 2,
          reviewUnique: 1,
          byCapturedOutcome: new Map([
            ["deterministic-allow", { calls: 1, unique: 1 }],
            ["model-review", { calls: 2, unique: 1 }],
          ]),
          modelReviewLoad: { calls: 2, unique: 1 },
          redactedCalls: 2,
        }),
        topReviewedExecutables: [
          {
            executable: "pnpm",
            calls: 2,
            unique: 1,
            fastPathCalls: 0,
            reviewCalls: 2,
            hardBlockCalls: 0,
            modelReviewCalls: 2,
            capturedDenialCalls: 0,
          },
        ],
        topReviewedCommands: [reviewed],
        topContentiousFamilies: [
          {
            executable: "pnpm",
            calls: 2,
            unique: 1,
            reviewCalls: 2,
            hardBlockCalls: 0,
            modelReviewCalls: 2,
            capturedDenialCalls: 0,
            sampleCommands: [reviewed.command],
          },
        ],
        perCommand: rows,
      }),
    );

    expect(sectionOrder(markdown)).toEqual([
      "# Ratchet replay report",
      "## Summary",
      "## Captured outcomes",
      "## Top reviewed executables",
      "## Top reviewed commands",
      "## Top contentious families",
    ]);
    expect(markdown).toContain("`pnpm test -- --runInBand` (redacted)");
    expect(markdown).not.toContain("## Compare");
    expect(markdown).not.toContain("## Top hard-blocked commands");
    expect(markdown).not.toContain("## Top unknown-tool review load");
    expect(markdown).toMatchInlineSnapshot(`
      "# Ratchet replay report
      
      Generated: 2026-06-25T12:00:00.000Z
      Repository: /repo
      Source: saved-corpus.json
      
      ## Summary
      
      - Total: 3 calls / 2 unique commands
      - Fast path: 1 call (33.3%), 1 unique command (50.0%)
      - Review: 2 calls (66.7%), 1 unique command (50.0%)
      - Hard block: 0 calls (0.0%), 0 unique commands (0.0%)
      
      ## Captured outcomes
      
      - Deterministic: deterministic-allow: 1 call / 1 unique command
      - Model: model-review: 2 calls / 1 unique command
      - Model-review load: 2 calls / 1 unique command
      - Redacted rows: 2 calls (commands may be audit-truncated; affected rows are tagged \`(redacted)\`)
      
      ## Top reviewed executables
      
      - \`pnpm\` — 2 review calls / 1 unique command (model-reviewed: 2; captured denials: 0)
      
      ## Top reviewed commands
      
      - \`pnpm test -- --runInBand\` (redacted) — 2 calls — review-dev-workflow: needs package-script review
      
      ## Top contentious families
      
      - \`pnpm\` — 2 calls / 1 unique command (review: 2; hard-block: 0; model-reviewed: 2; captured denials: 0)
        - \`pnpm test -- --runInBand\`
      "
    `);
  });

  it("renders unknown-tool review load when populated", () => {
    const markdown = renderRatchetMarkdown(
      report({
        topUnknownTools: [
          {
            toolName: "web_fetch",
            calls: 2,
            reviewCalls: 2,
            hardBlockCalls: 0,
            fastPathCalls: 0,
            modelReviewCalls: 1,
            capturedDenialCalls: 1,
            capturedOutcomes: new Map([
              ["model-review", 1],
              ["human-deny", 1],
            ]),
          },
        ],
      }),
    );

    expect(sectionOrder(markdown)).toEqual([
      "# Ratchet replay report",
      "## Summary",
      "## Top unknown-tool review load",
    ]);
    expect(markdown).toContain("Non-bash tools have no registered analyzer");
    expect(markdown).toContain("`unknownToolPosture` (default `review`)");
    expect(markdown).toContain(
      "- `web_fetch` — 2 calls (review: 2; hard-block: 0; model-reviewed: 1; captured denials: 1) — model-review: 1; human-deny: 1",
    );
  });

  it("omits unknown-tool review load when empty", () => {
    expect(renderRatchetMarkdown(report())).not.toContain(
      "## Top unknown-tool review load",
    );
  });

  it("snapshot-renders compare mode with expansions marked and listed first", () => {
    const beforePnpm = row({
      command: "pnpm test",
      count: 2,
      executable: "pnpm",
      status: "review",
      reason: "no matching rule",
    });
    const beforeGit = row({
      command: "git status",
      executable: "git",
      status: "fast_path",
      reason: "allow-git: read-only Git inspection",
    });
    const beforeRm = row({
      command: "rm -rf tmp",
      executable: "rm",
      status: "review",
      reason: "no matching rule",
    });
    const afterPnpm = row({
      ...beforePnpm,
      status: "fast_path",
      reason: "allow-pnpm-test: approved test runner",
      fidelity: "redacted",
    });
    const afterGit = row({
      ...beforeGit,
      status: "review",
      reason: "review-git: proposed tighter review",
    });
    const afterRm = row({
      ...beforeRm,
      status: "hard_block",
      reason: "deny-rm: destructive delete",
    });

    const markdown = renderRatchetMarkdown(
      report({
        summary: statusSummary([beforePnpm, beforeGit, beforeRm]),
        topHardBlockedCommands: [afterRm],
        perCommand: [beforePnpm, beforeGit, beforeRm],
        compare: {
          changedUnique: 3,
          changedCalls: 4,
          transitions: new Map([
            ["fast_path->review", 1],
            ["review->hard_block", 1],
            ["review->fast_path", 2],
          ]),
          expansions: { calls: 2, unique: 1 },
          beforeSummary: statusSummary([beforePnpm, beforeGit, beforeRm]),
          afterSummary: statusSummary([afterPnpm, afterGit, afterRm]),
          changedCommands: [afterGit, afterRm, afterPnpm],
        },
      }),
    );

    const expansionIndex = markdown.indexOf("↗ EXPANSION: `review->fast_path`");
    expect(expansionIndex).toBeGreaterThan(-1);
    expect(expansionIndex).toBeLessThan(
      markdown.indexOf("`fast_path->review`"),
    );
    expect(
      markdown.indexOf("↗ EXPANSION: `pnpm test` (redacted)"),
    ).toBeLessThan(markdown.indexOf("`git status`"));
    expect(markdown).toMatchInlineSnapshot(`
      "# Ratchet replay report
      
      Generated: 2026-06-25T12:00:00.000Z
      
      ## Summary
      
      - Total: 4 calls / 3 unique commands
      - Fast path: 1 call (25.0%), 1 unique command (33.3%)
      - Review: 3 calls (75.0%), 2 unique commands (66.7%)
      - Hard block: 0 calls (0.0%), 0 unique commands (0.0%)
      
      ## Compare
      
      - Changed: 4 calls / 3 unique commands
      - Expansions: 2 calls / 1 unique command
      
      ### Transitions
      - ↗ EXPANSION: \`review->fast_path\` — 2 calls
      - \`fast_path->review\` — 1 call
      - \`review->hard_block\` — 1 call
      
      ### Changed commands
      - ↗ EXPANSION: \`pnpm test\` (redacted) — \`review->fast_path\`; 2 calls — allow-pnpm-test: approved test runner
      - \`git status\` — \`fast_path->review\`; 1 call — review-git: proposed tighter review
      - \`rm -rf tmp\` — \`review->hard_block\`; 1 call — deny-rm: destructive delete
      
      ## Top hard-blocked commands
      
      - \`rm -rf tmp\` — 1 call — deny-rm: destructive delete
      "
    `);
  });
});

function sectionOrder(markdown: string): readonly string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .filter((line) => !line.startsWith("###"));
}
