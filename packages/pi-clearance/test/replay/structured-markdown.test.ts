import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  DecisionEffect,
  EffectivePolicy,
  PolicyRule,
} from "../../src/policy/core.ts";
import { inspectable, program } from "../../src/policy/core.ts";
import { buildCorpusQueryModel } from "../../src/replay/corpus-query.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import type {
  AdversarialValidationReport,
  CorpusQuerySummarySnapshot,
  ReplayDelta,
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  renderCorpusSummaryMarkdown,
  renderReplayDeltaMarkdown,
  renderStructuredProposalSummaryMarkdown,
  renderStructuredRatchetMarkdown,
} from "../../src/replay/structured-markdown.ts";

const GENERATED_AT = "2026-06-27T12:00:00.000Z";

function rule(
  id: string,
  effect: DecisionEffect,
  executable: string,
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(program(executable)),
    reason: `${effect} ${executable}`,
    provenance: { source: "generated", packId: "test-pack", ruleId: id },
  };
}

function entry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  const source = overrides.source ?? "session";
  return {
    command: "git status",
    toolName: "bash",
    source,
    sources: overrides.sources ?? [source],
    provenance: "structured-markdown-test",
    fidelity: overrides.fidelity ?? "high",
    ...overrides,
  };
}

function corpus(entries: readonly CorpusEntry[]): ReplayCorpus {
  return {
    entries,
    sourceSummary: sourceSummary(entries),
    unmatchedAuditEntries: 1,
    warnings: ["corpus fixture warning"],
  };
}

function sourceSummary(
  entries: readonly CorpusEntry[],
): ReadonlyMap<CorpusSource, number> {
  const summary = new Map<CorpusSource, number>([
    ["session", 0],
    ["audit", 0],
    ["corpus", 0],
  ]);
  for (const item of entries) {
    summary.set(item.source, (summary.get(item.source) ?? 0) + 1);
  }
  return summary;
}

function policy(): EffectivePolicy {
  return {
    floor: [rule("floor-deny-rm", "deny", "rm")],
    active: [rule("allow-git", "allow", "git")],
  };
}

async function buildIntegrationCorpusModel() {
  return buildCorpusQueryModel(
    corpus([
      entry({ command: "git status", deterministicOutcome: "allow" }),
      entry({
        command: "pnpm test",
        reviewerOutcome: { mode: "model", finalEffect: "review" },
      }),
      entry({ command: "rm -rf tmp", deterministicOutcome: "deny" }),
      entry({
        command: "legacy_edit src/file.ts",
        toolName: "legacy_edit",
        reviewerOutcome: { mode: "model", finalEffect: "review" },
      }),
      entry({
        command: "curl https://example.invalid",
        source: "audit",
        sources: ["audit"],
        deterministicOutcome: "review",
        fidelity: "redacted",
      }),
    ]),
    policy(),
  );
}

function summarySnapshot(
  replayStatusCounts: CorpusQuerySummarySnapshot["replayStatusCounts"],
): CorpusQuerySummarySnapshot {
  return {
    totalRecords: 9,
    totalUniqueCommands: 6,
    replayStatusCounts,
    capturedOutcomeCounts: [{ label: "model-review", calls: 3 }],
    sourceCounts: [
      { label: "session", calls: 8 },
      { label: "audit", calls: 1 },
    ],
    modelReviewLoad: { calls: 3, uniqueCommands: 2 },
    lowFidelityCalls: 1,
    redactedCalls: 1,
    unmatchedAuditEntries: 1,
  };
}

function replayDelta(): ReplayDelta {
  const regression = {
    transition: "fast_path->review" as const,
    kind: "allow-to-review" as const,
    calls: 1,
    uniqueCommands: 1,
    message:
      "replay regression: candidate would shift 1 command call(s) fast_path->review (allow→review)",
  };

  return {
    version: 1,
    status: "regression",
    baseline: summarySnapshot([
      { label: "fast_path", calls: 2, uniqueCommands: 2 },
      { label: "review", calls: 5, uniqueCommands: 3 },
      { label: "hard_block", calls: 2, uniqueCommands: 1 },
    ]),
    candidate: summarySnapshot([
      { label: "fast_path", calls: 3, uniqueCommands: 3 },
      { label: "review", calls: 3, uniqueCommands: 2 },
      { label: "hard_block", calls: 3, uniqueCommands: 1 },
    ]),
    changedCalls: 4,
    changedUniqueCommands: 3,
    transitions: [
      { transition: "review->review", calls: 3, uniqueCommands: 2 },
      { transition: "review->fast_path", calls: 2, uniqueCommands: 2 },
      { transition: "fast_path->review", calls: 1, uniqueCommands: 1 },
      { transition: "review->hard_block", calls: 1, uniqueCommands: 1 },
    ],
    improvement: {
      reviewToAllowCalls: 2,
      reviewToAllowUniqueCommands: 2,
      reviewReductionPercent: 40,
      remainingReviewCalls: 3,
      unchangedReviewCalls: 3,
    },
    blocked: {
      unknownToolCalls: 1,
      unknownPathCalls: null,
      sealedFloorBlockCalls: 1,
      activeDenyBlockCalls: 1,
      lowFidelityCalls: 1,
      redactedCalls: 1,
    },
    regressions: [regression],
    changedFamilies: [
      {
        familyId: "bash:git:status:clean",
        toolName: "bash",
        executable: "git",
        calls: 1,
        uniqueCommands: 1,
        baselineStatusCounts: [{ label: "fast_path", calls: 1 }],
        candidateStatusCounts: [{ label: "review", calls: 1 }],
        transitions: [
          { transition: "fast_path->review", calls: 1, uniqueCommands: 1 },
        ],
        reviewToAllowCalls: 0,
        regressions: [regression],
        unchangedReviewCalls: 0,
        sealedFloorBlockCalls: 0,
        unknownToolCalls: 0,
        unknownPathCalls: null,
        sampleRecordIds: ["rec-git"],
        sampleCommands: ["git status"],
      },
      {
        familyId: "bash:pnpm:test:clean",
        toolName: "bash",
        executable: "pnpm",
        calls: 2,
        uniqueCommands: 1,
        baselineStatusCounts: [{ label: "review", calls: 2 }],
        candidateStatusCounts: [{ label: "fast_path", calls: 2 }],
        transitions: [
          { transition: "review->fast_path", calls: 2, uniqueCommands: 1 },
        ],
        reviewToAllowCalls: 2,
        regressions: [],
        unchangedReviewCalls: 0,
        sealedFloorBlockCalls: 0,
        unknownToolCalls: 0,
        unknownPathCalls: null,
        sampleRecordIds: ["rec-pnpm"],
        sampleCommands: ["pnpm test"],
      },
    ],
    changedRecords: [
      {
        recordId: "rec-git",
        command: "git status",
        toolName: "bash",
        familyId: "bash:git:status:clean",
        baselineStatus: "fast_path",
        candidateStatus: "review",
        transition: "fast_path->review",
        baselineRuleId: "allow-git",
        candidateRuleId: "review-git",
        baselineReason: "allow-git: read-only Git inspection",
        candidateReason: "review-git: proposed tighter review",
        fidelity: "high",
      },
      {
        recordId: "rec-pnpm",
        command: "pnpm test",
        toolName: "bash",
        familyId: "bash:pnpm:test:clean",
        baselineStatus: "review",
        candidateStatus: "fast_path",
        transition: "review->fast_path",
        baselineReason: "no matching rule",
        candidateRuleId: "allow-pnpm-test",
        candidateReason: "allow-pnpm-test: approved test runner",
        fidelity: "redacted",
      },
    ],
    warnings: [
      "replay delta: path-fact context not supplied; unknownPathCalls is null (path-unknown evidence not computed)",
    ],
  };
}

function adversarialReport(): AdversarialValidationReport {
  return {
    version: 1,
    proposalId: "prop-allow-pnpm-test",
    status: "failed",
    generatedCaseCount: 2,
    evaluatedCaseCount: 2,
    failedCaseCount: 1,
    skippedCaseCount: 0,
    cases: [
      {
        id: "adv-pipe",
        command: "pnpm test | sh",
        category: "pipeline",
        expectation: "not-fast-path",
        rationale: "pipe-to-shell must not inherit the allow",
        source: "sample-mutation",
        derivedFrom: "pnpm test",
      },
    ],
    results: [
      {
        caseId: "adv-pipe",
        command: "pnpm test | sh",
        category: "pipeline",
        expectation: "not-fast-path",
        outcome: "failed",
        actualStatus: "fast_path",
        actualRuleId: "allow-pnpm-test",
        actualReason: "candidate matched too broadly",
        diagnostics: ["decision: fast_path"],
      },
    ],
    warnings: ["one adversarial case failed"],
  };
}

function structuredProposal(): StructuredRatchetProposal {
  return {
    version: 1,
    id: "prop-allow-pnpm-test",
    kind: "data-pack-policy",
    title: "Allow pnpm test",
    summary: "Allow repeated local pnpm test runs.",
    reason: "Repeated review friction with no captured denials.",
    createdAt: GENERATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-project-overlay",
      path: "/home/nathan/.config/pi/pi-clearance/projects/pi-clearance.json",
      projectKey: "pi-clearance",
      projectRoot: "/home/nathan/dev/pi-clearance",
    },
    change: {
      kind: "policy-pack",
      packId: "user-project-dev",
      ruleId: "allow-pnpm-test",
      effect: "allow",
      reason: "local test command",
      match: { program: "pnpm" },
      rawPackPatch: [{ op: "add", path: "/packs/0/rules/-" }],
    },
    evidence: {
      corpusSummary: {
        totalRecords: 9,
        totalUniqueCommands: 6,
        modelReviewLoad: { calls: 3, uniqueCommands: 2 },
        redactedCalls: 1,
        lowFidelityCalls: 1,
      },
      familyIds: ["bash:pnpm:test:clean"],
      recordIds: ["rec-pnpm"],
      calls: 2,
      uniqueCommands: 1,
      reviewCalls: 2,
      hardBlockCalls: 0,
      modelReviewCalls: 2,
      capturedDenialCalls: 0,
      replayStatusCounts: [{ label: "review", calls: 2, uniqueCommands: 1 }],
      capturedOutcomeCounts: [{ label: "model-review", calls: 2 }],
      sampleCommands: ["pnpm test", "pnpm test -- --runInBand"],
      replayDelta: replayDelta(),
      adversarial: adversarialReport(),
    },
    examples: [
      {
        command: "pnpm test",
        matches: true,
        capturedOutcome: "model-review",
      },
    ],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
      replay: {
        status: "fail",
        code: "replay-regression",
        message: "replay found a regression",
      },
      adversarial: {
        status: "fail",
        code: "adversarial-failed",
        message: "adversarial validation failed",
      },
    },
    trustNotes: [
      {
        kind: "project-overlay",
        message: "writes only user-owned project overlay after approval",
        severity: "warning",
      },
    ],
    warnings: ["proposal warning"],
  };
}

function proposalWithoutReplayOrAdversarial(): StructuredRatchetProposal {
  return {
    version: 1,
    id: "prop-reviewer-guidance",
    kind: "reviewer-config",
    title: "Append reviewer guidance",
    summary: "Append reviewer prompt guidance for test commands.",
    reason: "Repeated ambiguous test reviews.",
    createdAt: GENERATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-project-overlay",
      path: "/home/nathan/.config/pi/pi-clearance/projects/pi-clearance.json",
      projectKey: "pi-clearance",
      projectRoot: "/home/nathan/dev/pi-clearance",
    },
    change: {
      kind: "reviewer-config",
      pointer: "/reviewer/projectPromptAppends/-",
      op: "append-string",
      before: [],
      after: "Prefer review for commands with parser uncertainty.",
      rendered: "Append reviewer guidance.",
    },
    evidence: {
      familyIds: ["bash:pnpm:test:clean"],
      recordIds: ["rec-pnpm"],
      calls: 2,
      uniqueCommands: 1,
      reviewCalls: 2,
      hardBlockCalls: 0,
      modelReviewCalls: 2,
      capturedDenialCalls: 0,
      replayStatusCounts: [{ label: "review", calls: 2 }],
      capturedOutcomeCounts: [{ label: "model-review", calls: 2 }],
      sampleCommands: ["pnpm test"],
    },
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
    },
    trustNotes: [],
    warnings: [],
  };
}

function proposalBatch(): StructuredProposalBatch {
  return {
    version: 1,
    generatedAt: GENERATED_AT,
    source: {
      corpusSummary: {
        totalRecords: 9,
        totalUniqueCommands: 6,
        modelReviewLoad: { calls: 3, uniqueCommands: 2 },
        redactedCalls: 1,
        lowFidelityCalls: 1,
      },
      warnings: ["source warning"],
    },
    proposals: [structuredProposal(), proposalWithoutReplayOrAdversarial()],
    warnings: ["batch warning"],
  };
}

describe("structured markdown renderer", () => {
  it("renders a CorpusQueryModel built by buildCorpusQueryModel in report section order", async () => {
    const model = await buildIntegrationCorpusModel();
    const markdown = renderCorpusSummaryMarkdown(model);

    expect(sectionOrder(markdown)).toEqual([
      "## Summary",
      "## Captured outcomes",
      "## Top reviewed families",
      "## Top contentious families",
      "## Top unknown-tool review load",
    ]);
    expect(markdown).toContain(
      "- Replay statuses: fast_path: 1 call; review: 3 calls; hard_block: 1 call",
    );
    expect(markdown).toContain(
      "- Model-review load: 2 calls / 2 unique commands",
    );
    expect(markdown).toContain("- Redacted rows: 1 call");
    expect(markdown).toContain("`legacy_edit`");
    expect(markdown).toContain("Unsupported tools have no analyzer here");
  });

  it("renders replay deltas with reductions, expansions, regressions, blocks, unknowns, low-fidelity, and redactions", () => {
    const markdown = renderReplayDeltaMarkdown(replayDelta());

    expect(markdown).toContain(
      "- Review reductions: 2 calls / 2 unique commands moved `review->fast_path`; reduction 40%",
    );
    expect(markdown).toContain("unchanged reviews: 3 calls");
    expect(markdown).toContain(
      "sealed-floor 1 call; active-deny 1 call; unknown-tool 1 call; unknown-path not computed",
    );
    expect(markdown).toContain("low-fidelity rows 1 call; redactions 1 call");
    expect(markdown).toContain("EXPANSION `review->fast_path`");
    expect(markdown).toContain("UNCHANGED REVIEW `review->review`");
    expect(markdown).toContain("REGRESSION `fast_path->review`");
    expect(markdown).toContain("`pnpm test` (redacted)");
    expect(markdown).toContain("path-fact context not supplied");
    expect(markdown.indexOf("### Regressions")).toBeLessThan(
      markdown.indexOf("### Transitions"),
    );
    expect(markdown.indexOf("REGRESSION `fast_path->review`")).toBeLessThan(
      markdown.indexOf("EXPANSION `review->fast_path`"),
    );
  });

  it("renders proposal summaries with compact evidence, validation, replay, adversarial, trust, warnings, and samples", () => {
    const markdown = renderStructuredProposalSummaryMarkdown(
      structuredProposal(),
    );

    expect(markdown).toContain(
      "## Proposal `prop-allow-pnpm-test`: Allow pnpm test",
    );
    expect(markdown).toContain("- Kind: data-pack-policy");
    expect(markdown).toContain("user-project overlay");
    expect(markdown).toContain("- Application mode: writable-after-approval");
    expect(markdown).toContain("- Calls: 2 calls / 1 unique command");
    expect(markdown).toContain(
      "- Replay: fail (replay-regression) — replay found a regression",
    );
    expect(markdown).toContain("- Replay evidence: REGRESSION");
    expect(markdown).toContain("- Adversarial evidence: failed");
    expect(markdown).toContain("failed/errored 1");
    expect(markdown).toContain("Failed/errored case `adv-pipe`");
    expect(markdown).toContain(
      "- warning `project-overlay` — writes only user-owned project overlay after approval",
    );
    expect(markdown).toContain("- proposal warning");
    expect(markdown).toContain("  - `pnpm test -- --runInBand`");
  });

  it("counts errored adversarial results alongside failed cases", () => {
    const proposal = structuredProposal();
    const adversarial: AdversarialValidationReport = {
      ...adversarialReport(),
      failedCaseCount: 0,
      results: [
        {
          caseId: "adv-error",
          command: "pnpm test | sh",
          category: "pipeline",
          expectation: "not-fast-path",
          outcome: "errored",
          diagnostics: ["parser failed"],
        },
      ],
    };
    const markdown = renderStructuredProposalSummaryMarkdown({
      ...proposal,
      evidence: { ...proposal.evidence, adversarial },
    });

    expect(markdown).toContain(
      "Cases: generated 2; evaluated 2; failed/errored 1; skipped 0",
    );
    expect(markdown).toContain(
      "Failed/errored case `adv-error` (pipeline, errored)",
    );
  });

  it("renders honest pending and skipped states when replay or adversarial evidence is absent", () => {
    const markdown = renderStructuredProposalSummaryMarkdown(
      proposalWithoutReplayOrAdversarial(),
    );

    expect(markdown).toContain(
      "- Replay: pending (replay-not-attached) — no replay validation check attached",
    );
    expect(markdown).toContain(
      "- Adversarial: skipped (adversarial-not-attached) — no adversarial validation check attached",
    );
    expect(markdown).toContain(
      "- Replay evidence: pending — no replay delta attached",
    );
    expect(markdown).toContain(
      "- Adversarial evidence: skipped — no adversarial report attached",
    );
  });

  it("renders the full structured report in useful legacy-compatible order", async () => {
    const model = await buildIntegrationCorpusModel();
    const markdown = renderStructuredRatchetMarkdown({
      generatedAt: GENERATED_AT,
      repoRoot: "/home/nathan/dev/pi-clearance",
      sourcePath: "structured-corpus.json",
      corpus: model,
      replayDeltas: [replayDelta()],
      proposals: proposalBatch(),
    });

    expectInOrder(markdown, [
      "# Structured ratchet report",
      "## Summary",
      "## Captured outcomes",
      "## Top reviewed families",
      "## Top contentious families",
      "## Top unknown-tool review load",
      "## Replay delta",
      "## Proposal summaries",
      "### Proposal `prop-allow-pnpm-test`: Allow pnpm test",
      "## Warnings",
    ]);
    expect(markdown).toContain("Repository: /home/nathan/dev/pi-clearance");
    expect(markdown).toContain("- proposal batch: batch warning");
    expect(markdown).toContain(
      "- proposal prop-allow-pnpm-test: proposal warning",
    );
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("keeps the structured renderer pure presentation source", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../src/replay/structured-markdown.ts", import.meta.url),
      ),
      "utf8",
    );

    const forbidden: readonly [string, RegExp][] = [
      ["filesystem imports", /from\s+["'](?:node:)?fs(?:\/promises)?["']/u],
      ["Pi runtime imports", /@earendil-works\/pi|ExtensionAPI|\bpi\./u],
      [
        "config writer imports",
        /config\/(?:loader|paths|writer)|pack-enablement-writer|apply-writer/u,
      ],
      [
        "model adapter imports",
        /model-adapter|ModelAdapter|runtime\/reviewer/u,
      ],
      [
        "shell execution APIs",
        /(?:node:)?child_process|\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(|shell\s*:\s*true/u,
      ],
      [
        "policy interpreter",
        /policy\/interpreter|from\s+["'][^"']*interpreter/u,
      ],
      [
        "legacy ratchet markdown",
        /ratchet-markdown|RatchetReport|from\s+["']\.\/ratchet(?:\.ts)?["']/u,
      ],
    ];

    for (const [label, pattern] of forbidden) {
      expect(
        source,
        `structured-markdown must not import/use ${label}`,
      ).not.toMatch(pattern);
    }
  });
});

function sectionOrder(markdown: string): readonly string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .filter((line) => !line.startsWith("###"));
}

function expectInOrder(markdown: string, needles: readonly string[]): void {
  let lastIndex = -1;
  for (const needle of needles) {
    const index = markdown.indexOf(needle);
    expect(index, `missing ${needle}`).toBeGreaterThan(-1);
    expect(
      index,
      `${needle} should appear after prior section`,
    ).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
}
