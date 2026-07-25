import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  proposalCardFromStructuredProposal,
  renderProposalCardMarkdown,
  renderStructuredProposalCardMarkdown,
  summarizeWarnings,
} from "../../src/replay/proposal-card.ts";
import type {
  AdversarialValidationReport,
  ProposalEvidence,
  ProposalValidation,
  ReplayDelta,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
  PROPOSAL_SCHEMA_VERSION,
} from "../../src/replay/proposal-schema.ts";

const CREATED_AT = "2026-06-27T00:00:00.000Z";

type ProposalOptions = {
  readonly evidence?: ProposalEvidence;
  readonly validation?: ProposalValidation;
  readonly warnings?: readonly string[];
};

function summarySnapshot(
  replayStatusCounts: ReplayDelta["baseline"]["replayStatusCounts"],
): ReplayDelta["baseline"] {
  return {
    totalRecords: 12,
    totalUniqueCommands: 5,
    replayStatusCounts,
    capturedOutcomeCounts: [{ label: "model-review", calls: 4 }],
    sourceCounts: [{ label: "session", calls: 12 }],
    modelReviewLoad: { calls: 4, uniqueCommands: 2 },
    lowFidelityCalls: 1,
    redactedCalls: 1,
    unmatchedAuditEntries: 0,
  };
}

function replayDelta(status: ReplayDelta["status"] = "passed"): ReplayDelta {
  const regression = {
    transition: "fast_path->review" as const,
    kind: "allow-to-review" as const,
    calls: 1,
    uniqueCommands: 1,
    message: "candidate would move a known allow back to review",
  };
  const regressions = status === "regression" ? [regression] : [];

  return {
    version: 1,
    status,
    baseline: summarySnapshot([
      { label: "fast_path", calls: 3, uniqueCommands: 2 },
      { label: "review", calls: 6, uniqueCommands: 3 },
      { label: "hard_block", calls: 3, uniqueCommands: 1 },
    ]),
    candidate: summarySnapshot([
      { label: "fast_path", calls: 5, uniqueCommands: 3 },
      { label: "review", calls: 4, uniqueCommands: 2 },
      { label: "hard_block", calls: 3, uniqueCommands: 1 },
    ]),
    changedCalls: status === "regression" ? 3 : 2,
    changedUniqueCommands: status === "regression" ? 3 : 2,
    transitions: [
      { transition: "review->fast_path", calls: 2, uniqueCommands: 2 },
      ...(status === "regression"
        ? [
            {
              transition: "fast_path->review" as const,
              calls: 1,
              uniqueCommands: 1,
            },
          ]
        : []),
    ],
    improvement: {
      reviewToAllowCalls: 2,
      reviewToAllowUniqueCommands: 2,
      reviewReductionPercent: 33,
      remainingReviewCalls: 4,
      unchangedReviewCalls: 4,
    },
    blocked: {
      unknownToolCalls: 1,
      unknownPathCalls: null,
      sealedFloorBlockCalls: 3,
      activeDenyBlockCalls: 0,
      lowFidelityCalls: 1,
      redactedCalls: 1,
    },
    regressions,
    changedFamilies: [
      {
        familyId: "bash:pnpm:test",
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
      ...(status === "regression"
        ? [
            {
              familyId: "bash:git:status",
              toolName: "bash" as const,
              executable: "git",
              calls: 1,
              uniqueCommands: 1,
              baselineStatusCounts: [{ label: "fast_path" as const, calls: 1 }],
              candidateStatusCounts: [{ label: "review" as const, calls: 1 }],
              transitions: [
                {
                  transition: "fast_path->review" as const,
                  calls: 1,
                  uniqueCommands: 1,
                },
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
          ]
        : []),
    ],
    changedRecords: [],
    warnings: ["path-fact context not supplied"],
  };
}

function adversarialReport(
  status: AdversarialValidationReport["status"] = "passed",
): AdversarialValidationReport {
  return {
    version: ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
    proposalId: "prop-data-1",
    status,
    generatedCaseCount: status === "not-run" ? 0 : 2,
    evaluatedCaseCount: status === "not-run" ? 0 : 2,
    failedCaseCount: status === "failed" ? 1 : 0,
    skippedCaseCount: 0,
    cases:
      status === "not-run"
        ? []
        : [
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
    results:
      status === "failed"
        ? [
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
          ]
        : status === "passed"
          ? [
              {
                caseId: "adv-pipe",
                command: "pnpm test | sh",
                category: "pipeline",
                expectation: "not-fast-path",
                outcome: "passed",
                actualStatus: "review",
                actualReason: "pipeline stays reviewed",
                diagnostics: [],
              },
            ]
          : [],
    warnings: status === "failed" ? ["one adversarial case failed"] : [],
  };
}

function validation(
  overrides: Partial<ProposalValidation> = {},
): ProposalValidation {
  return {
    schema: { status: "pass", code: "schema-ok", message: "schema validates" },
    replay: { status: "pass", code: "replay-ok", message: "replay passed" },
    adversarial: {
      status: "pass",
      code: "adversarial-ok",
      message: "adversarial cases passed",
    },
    ...overrides,
  };
}

function evidence(
  options: {
    readonly replay?: ReplayDelta;
    readonly adversarial?: AdversarialValidationReport;
    readonly sampleCommands?: readonly string[];
  } = {},
): ProposalEvidence {
  return {
    familyIds: ["bash:pnpm:test"],
    recordIds: ["rec-1", "rec-2"],
    calls: 6,
    uniqueCommands: 2,
    reviewCalls: 4,
    hardBlockCalls: 1,
    modelReviewCalls: 3,
    capturedDenialCalls: 1,
    replayStatusCounts: [{ label: "review", calls: 4, uniqueCommands: 2 }],
    capturedOutcomeCounts: [{ label: "model-review", calls: 3 }],
    sampleCommands: options.sampleCommands ?? ["pnpm test", "git status"],
    ...(options.replay === undefined ? {} : { replayDelta: options.replay }),
    ...(options.adversarial === undefined
      ? {}
      : { adversarial: options.adversarial }),
  };
}

function dataPackPolicyProposal(
  options: ProposalOptions & {
    readonly match?: unknown;
    readonly sampleCommands?: readonly string[];
  } = {},
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-data-1",
    kind: "data-pack-policy",
    title: "Allow pnpm test",
    summary: "Allow repeated local pnpm test runs.",
    reason: "Repeated review friction with no captured denials.",
    createdAt: CREATED_AT,
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
      match: options.match ?? { program: "pnpm", args: ["test"] },
      rawPackPatch: [
        {
          op: "add",
          path: "/packs/0/rules/-",
          value: { id: "allow-pnpm-test", effect: "allow" },
        },
      ],
      fileWrite: {
        path: "/home/nathan/.config/pi/pi-clearance/projects/pi-clearance.json",
        format: "json",
        mode: "patch",
        atomic: true,
        backupRequired: true,
        patch: [
          {
            op: "add",
            path: "/packs/0/rules/-",
            value: { id: "allow-pnpm-test", effect: "allow" },
          },
        ],
      },
    },
    evidence:
      options.evidence ??
      evidence({
        replay: replayDelta(),
        adversarial: adversarialReport(),
        ...(options.sampleCommands === undefined
          ? {}
          : { sampleCommands: options.sampleCommands }),
      }),
    examples: [{ command: "pnpm test", matches: true }],
    fixtureSuggestions: [
      {
        command: "pnpm test -- --runInBand",
        expected: "fast_path",
        reason: "local test runner stays inside project",
        provenance: "fixtures.yaml",
      },
    ],
    validation: options.validation ?? validation(),
    trustNotes: [
      {
        kind: "project-overlay",
        message: "writes user-owned project overlay only after approval",
        severity: "warning",
      },
    ],
    warnings: [...(options.warnings ?? [])],
  };
}

function reviewerConfigProposal(
  options: ProposalOptions = {},
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-reviewer-1",
    kind: "reviewer-config",
    title: "Append reviewer guidance",
    summary: "Append reviewer prompt guidance for local tests.",
    reason: "Repeated ambiguous test reviews.",
    createdAt: CREATED_AT,
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
      after: "Prefer review for parser uncertainty.",
      rendered:
        "+ reviewer.projectPromptAppends += Prefer review for parser uncertainty.",
    },
    evidence: options.evidence ?? evidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: options.validation ?? {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
    },
    trustNotes: [],
    warnings: [...(options.warnings ?? [])],
  };
}

function projectScopeProposal(
  options: ProposalOptions = {},
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-scope-1",
    kind: "project-scope-config",
    title: "Allow writes under ./src",
    summary: "Add ./src to writable directories.",
    reason: "All captured writes target ./src; scope the allow there.",
    createdAt: CREATED_AT,
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
      kind: "project-scope-config",
      patch: [
        {
          op: "add",
          path: "/projectScope/writableDirectories/-",
          value: "./src",
        },
      ],
    },
    evidence: options.evidence ?? evidence({ replay: replayDelta() }),
    examples: [],
    fixtureSuggestions: [],
    validation: options.validation ?? validation(),
    trustNotes: [
      {
        kind: "path-scope",
        message: "writable directories widen project-local write scope",
        severity: "warning",
      },
    ],
    warnings: [...(options.warnings ?? [])],
  };
}

function packagePackEnablementProposal(
  options: ProposalOptions = {},
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-pack-1",
    kind: "package-pack-enablement",
    title: "Enable package test-safety pack",
    summary: "Enable package-contributed pack test-safety.",
    reason: "Pack is installed and matches captured friction.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-global",
    applicationMode: "writable-after-approval",
    target: {
      kind: "package-pack-config",
      path: "~/.config/pi-clearance/config.json",
      packId: "test-safety",
      packageName: "pi-test-safety",
      packageVersion: "1.0.0",
    },
    change: {
      kind: "package-pack-enablement",
      packId: "test-safety",
      enable: true,
      packageName: "pi-test-safety",
      packageVersion: "1.0.0",
      packagePath: "/home/nathan/.pi/packages/pi-test-safety",
      metadataWarnings: ["pack metadata asks for careful review"],
      plan: {
        id: "plan-enable-test-safety",
        request: {
          action: "enable",
          scope: "global",
          subject: "package",
          packId: "test-safety",
        },
        targetPath: "~/.config/pi-clearance/config.json",
        patch: [
          {
            op: "replace",
            path: "/packEnablement/enabledPackagePacks",
            before: [],
            value: ["test-safety"],
          },
        ],
        before: {
          scope: "global",
          packEnablement: {
            enabledPackagePacks: [],
            disabledPackagePacks: [],
            disabledConfigPacks: [],
          },
          packs: [],
        },
        after: {
          scope: "global",
          packEnablement: {
            enabledPackagePacks: ["test-safety"],
            disabledPackagePacks: [],
            disabledConfigPacks: [],
          },
          packs: [],
        },
        warnings: [
          {
            code: "metadata-danger-0",
            level: "danger",
            message: "package pack metadata requires acknowledgement",
            source: "metadata",
            requiresAcknowledgement: true,
          },
        ],
        requiredAcknowledgementCodes: ["metadata-danger-0"],
      },
    },
    evidence: options.evidence ?? evidence({ replay: replayDelta() }),
    examples: [],
    fixtureSuggestions: [],
    validation:
      options.validation ??
      validation({
        trust: {
          status: "pending",
          code: "trust-pending",
          message: "operator acknowledgement pending",
        },
      }),
    trustNotes: [
      {
        kind: "package-pack",
        message: "installation is not enablement",
        severity: "info",
      },
    ],
    warnings: [...(options.warnings ?? [])],
  };
}

function packFileAuthoringProposal(
  options: ProposalOptions = {},
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-authoring-1",
    kind: "pack-file-authoring",
    title: "Draft core matcher",
    summary: "Design input for a core matcher.",
    reason: "The data DSL cannot express this matcher shape.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    applicationMode: "design-input-only",
    target: {
      kind: "design-input",
      route: "core-matcher",
      suggestedPath: "./.pi/packs/core-matcher.json",
    },
    change: {
      kind: "pack-file-authoring",
      authoringKind: "core-matcher",
      matcherName: "isForcePushToProtectedBranch",
      matcherSignature: "(shape: BashCommandShape) => boolean",
      rationale:
        "Force-push checks need a core matcher until the DSL grows this matcher.",
      fileWrite: {
        path: "./.pi/packs/core-matcher.json",
        format: "json",
        mode: "create",
        atomic: false,
        backupRequired: false,
        contents: '{"kind":"core-matcher-design-input"}',
      },
    },
    evidence: options.evidence ?? evidence({ replay: replayDelta() }),
    examples: [],
    fixtureSuggestions: [],
    validation:
      options.validation ??
      validation({
        trust: {
          status: "pass",
          code: "trust-structural",
          message: "structural matcher; no executable code or DSL change",
        },
      }),
    trustNotes: [],
    warnings: [...(options.warnings ?? [])],
  };
}

describe("proposal-card renderer", () => {
  it.each([
    ["data-pack-policy", dataPackPolicyProposal(), "writable-after-approval"],
    ["reviewer-config", reviewerConfigProposal(), "writable-after-approval"],
    ["project-scope-config", projectScopeProposal(), "writable-after-approval"],
    [
      "package-pack-enablement",
      packagePackEnablementProposal(),
      "writable-after-approval",
    ],
    ["pack-file-authoring", packFileAuthoringProposal(), "design-input-only"],
  ] as const)("renders a %s card with the required view model fields", (_kind, proposal, route) => {
    const card = proposalCardFromStructuredProposal(proposal);
    const markdown = renderProposalCardMarkdown(card);

    expect(card.kind).toBe(proposal.kind);
    expect(card.route).toBe(route);
    expect(card.target.label).not.toHaveLength(0);
    expect(card.target.trustBoundary).not.toHaveLength(0);
    expect(card.exactChange.text).not.toHaveLength(0);
    expect(card.validation.length).toBeGreaterThan(0);
    expect(card.impact.calls).toBe(proposal.evidence.calls);
    expect(card.approvalText).toContain("Generation/rendering is not approval");
    expect(markdown).toContain(card.exactChange.text);
    expect(markdown).toContain(
      "## Routine examples and fixture-suggestion commands",
    );
  });

  it("surfaces required acknowledgement codes before approval", () => {
    const dataPack = proposalCardFromStructuredProposal(
      dataPackPolicyProposal(),
    );
    const dataPackMarkdown = renderProposalCardMarkdown(dataPack);

    expect(dataPack.requiredAcknowledgementCodes).toEqual([
      "ratchet-trust-note-project-overlay-0",
    ]);
    expect(dataPack.trustNotes).toContainEqual({
      severity: "warning",
      message:
        "project-overlay — writes user-owned project overlay only after approval",
      requiredAcknowledgementCode: "ratchet-trust-note-project-overlay-0",
    });
    expect(dataPackMarkdown).toContain("### Required acknowledgement codes");
    expect(dataPackMarkdown).toContain(
      "`ratchet-trust-note-project-overlay-0`",
    );
    expect(dataPackMarkdown).toContain(
      "requires acknowledgement: `ratchet-trust-note-project-overlay-0`",
    );

    const packagePack = proposalCardFromStructuredProposal(
      packagePackEnablementProposal(),
    );
    const packagePackMarkdown = renderProposalCardMarkdown(packagePack);

    expect(packagePack.requiredAcknowledgementCodes).toEqual([
      "metadata-danger-0",
    ]);
    expect(packagePackMarkdown).toContain("`metadata-danger-0`");
  });

  it("renders exact change text for every structured proposal kind", () => {
    const policyPack = proposalCardFromStructuredProposal(
      dataPackPolicyProposal(),
    );
    expect(policyPack.requiredAcknowledgementCodes).toEqual([
      "ratchet-trust-note-project-overlay-0",
    ]);
    expect(policyPack.exactChange.text).toContain(
      "Pack id: `user-project-dev`",
    );
    expect(policyPack.exactChange.text).toContain("Raw matcher JSON");
    expect(policyPack.exactChange.text).toContain("File-write description");
    expect(policyPack.exactChange.text).toContain(
      "`ratchet-trust-note-project-overlay-0`",
    );

    const reviewer = proposalCardFromStructuredProposal(
      reviewerConfigProposal(),
    );
    expect(reviewer.requiredAcknowledgementCodes).toEqual([]);
    expect(reviewer.exactChange.text).toContain(
      "Pointer: `/reviewer/projectPromptAppends/-`",
    );
    expect(reviewer.exactChange.text).toContain("Rendered diff");
    expect(reviewer.exactChange.text).toContain("Before");
    expect(reviewer.exactChange.text).toContain("After");
    expect(reviewer.exactChange.text).toContain(
      "Required acknowledgements: none",
    );

    const scope = proposalCardFromStructuredProposal(projectScopeProposal());
    expect(scope.requiredAcknowledgementCodes).toEqual([
      "ratchet-trust-note-path-scope-0",
    ]);
    expect(scope.exactChange.text).toContain("Target overlay");
    expect(scope.exactChange.text).toContain(
      "ADD `/projectScope/writableDirectories/-`",
    );
    expect(scope.exactChange.text).toContain(
      "`ratchet-trust-note-path-scope-0`",
    );

    const pack = proposalCardFromStructuredProposal(
      packagePackEnablementProposal(),
    );
    expect(pack.exactChange.text).toContain("Action: enable");
    expect(pack.exactChange.text).toContain("Pack metadata");
    expect(pack.exactChange.text).toContain("Plan patch");
    expect(pack.exactChange.text).toContain("Required acknowledgements");
    expect(pack.warnings).toContain(
      "package metadata: pack metadata asks for careful review",
    );

    const authoring = proposalCardFromStructuredProposal(
      packFileAuthoringProposal(),
    );
    expect(authoring.route).toBe("design-input-only");
    expect(authoring.exactChange.text).toContain("Route: design-input-only");
    expect(authoring.exactChange.text).toContain("Matcher signature");
    expect(authoring.exactChange.text).toContain("Suggested file write");
    expect(authoring.exactChange.text).toContain(
      "Raw rule/module/core matcher details",
    );
  });

  it("shows missing replay and adversarial evidence honestly", () => {
    const proposal = reviewerConfigProposal({
      evidence: evidence(),
      validation: {
        schema: { status: "pass", code: "schema-ok", message: "ok" },
      },
    });
    const card = proposalCardFromStructuredProposal(proposal);
    const markdown = renderProposalCardMarkdown(card);

    expect(card.impact.replay).toMatchObject({ status: "not-run" });
    expect(card.adversarial).toMatchObject({ status: "not-run" });
    expect(card.validation).toContainEqual({
      name: "replay",
      status: "pending",
      code: "replay-not-attached",
      message: "no replay validation check attached",
    });
    expect(card.validation).toContainEqual({
      name: "adversarial",
      status: "skipped",
      code: "adversarial-not-attached",
      message: "no adversarial validation check attached",
    });
    expect(markdown).toContain("- Status: not-run");
    expect(markdown).toContain("Replay delta not attached");
  });

  it("summarizes duplicate and long warning lists without hiding exact changes", () => {
    const proposal = dataPackPolicyProposal({
      warnings: [
        "repeat warning",
        "repeat warning",
        "warning 2",
        "warning 3",
        "warning 4",
        "warning 5",
        "warning 6",
      ],
    });
    const card = proposalCardFromStructuredProposal(proposal);
    const markdown = renderProposalCardMarkdown(card);

    expect(summarizeWarnings(["a", "a", "b"], 1)).toEqual({
      total: 3,
      shown: ["a"],
      omitted: 2,
    });
    expect(card.warningSummary).toMatchObject({ total: 8, omitted: 3 });
    expect(
      card.warnings.filter((warning) => warning === "repeat warning"),
    ).toHaveLength(2);
    expect(markdown).toContain("… 3 more warning(s) in structured details");
    expect(markdown).toContain("## Exact change");
    expect(markdown).toContain("Raw matcher JSON");
    expect(markdown).toContain("Raw pack patch");
  });

  it("renders replay regressions before routine examples", () => {
    const proposal = dataPackPolicyProposal({
      evidence: evidence({ replay: replayDelta("regression") }),
      validation: validation({
        replay: {
          status: "fail",
          code: "replay-regression",
          message: "replay found a regression",
        },
      }),
    });
    const card = proposalCardFromStructuredProposal(proposal);
    const markdown = renderProposalCardMarkdown(card);

    expect(card.impact.replay).toMatchObject({
      status: "regression",
      regressionCount: 1,
      reviewToAllowCalls: 2,
    });
    expect(card.impact.replay?.changedFamilies.join("\n")).toContain("git");
    expect(card.impact.replay?.blockedSummary.join("\n")).toContain(
      "unknown-path: not computed",
    );
    expect(markdown).toContain("**Replay regressions:** 1 call regressed");
    expect(markdown.indexOf("**Replay regressions:**")).toBeLessThan(
      markdown.indexOf("## Routine examples"),
    );
    expect(markdown.indexOf("Failed validation checks")).toBeLessThan(
      markdown.indexOf("## Routine examples"),
    );
  });

  it("renders adversarial failures before routine examples", () => {
    const proposal = dataPackPolicyProposal({
      evidence: evidence({ adversarial: adversarialReport("failed") }),
      validation: validation({
        adversarial: {
          status: "fail",
          code: "adversarial-failed",
          message: "one adversarial case failed",
        },
      }),
    });
    const card = proposalCardFromStructuredProposal(proposal);
    const markdown = renderProposalCardMarkdown(card);

    expect(card.adversarial).toMatchObject({
      status: "failed",
      failedCaseCount: 1,
      failedCases: [
        {
          command: "pnpm test | sh",
          category: "pipeline",
          actualStatus: "fast_path",
        },
      ],
    });
    expect(markdown).toContain(
      "**Adversarial failed/errored cases:** 1 case failed or errored",
    );
    expect(markdown).toContain(
      "`pnpm test | sh` (pipeline) → actual fast_path",
    );
    expect(
      markdown.indexOf("**Adversarial failed/errored cases:**"),
    ).toBeLessThan(markdown.indexOf("## Routine examples"));
  });

  it("does not invent adversarial case counts when validation fails without a report", () => {
    const proposal = dataPackPolicyProposal({
      evidence: evidence(),
      validation: validation({
        adversarial: {
          status: "fail",
          code: "adversarial-report-missing",
          message: "validation failed before report attachment",
        },
      }),
    });
    const card = proposalCardFromStructuredProposal(proposal);
    const markdown = renderProposalCardMarkdown(card);

    expect(card.adversarial).toEqual({
      status: "failed",
      generatedCaseCount: 0,
      evaluatedCaseCount: 0,
      failedCaseCount: 0,
      failedCases: [],
    });
    expect(markdown).toContain(
      "**Adversarial validation failed:** no per-case adversarial report is attached",
    );
    expect(markdown).toContain(
      "- Adversarial: fail (adversarial-report-missing) — validation failed before report attachment",
    );
    expect(markdown).not.toContain("1 case failed");
  });

  it("counts errored adversarial results alongside failed cases for display", () => {
    const erroredReport: AdversarialValidationReport = {
      ...adversarialReport("failed"),
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
    const proposal = dataPackPolicyProposal({
      evidence: evidence({ adversarial: erroredReport }),
      validation: validation({
        adversarial: {
          status: "fail",
          code: "adversarial-errored",
          message: "adversarial evaluator errored",
        },
      }),
    });
    const card = proposalCardFromStructuredProposal(proposal);
    const markdown = renderProposalCardMarkdown(card);

    expect(card.adversarial?.failedCaseCount).toBe(1);
    expect(card.adversarial?.failedCases).toEqual([
      { command: "pnpm test | sh", category: "pipeline" },
    ]);
    expect(markdown).toContain("failed/errored 1");
    expect(markdown).toContain(
      "**Adversarial failed/errored cases:** 1 case failed or errored",
    );
  });

  it("escapes JSON code blocks and inline commands containing backticks", () => {
    const proposal = dataPackPolicyProposal({
      match: {
        program: "bash",
        command: "echo `date`",
        fence: "contains ``` inside JSON",
      },
      sampleCommands: ["echo `date`"],
    });
    const markdown = renderStructuredProposalCardMarkdown(proposal);

    expect(markdown).toContain("`` echo `date` ``");
    expect(markdown).toContain("````json");
    expect(markdown).toContain("contains ``` inside JSON");
  });

  it("renders markdown from ProposalCardView rather than the raw proposal", () => {
    const card = proposalCardFromStructuredProposal(dataPackPolicyProposal());
    const markdown = renderProposalCardMarkdown({
      ...card,
      exactChange: { label: "Custom view", text: "custom-only-view-text" },
    });

    expect(markdown).toContain("### Custom view");
    expect(markdown).toContain("custom-only-view-text");
    expect(renderStructuredProposalCardMarkdown(dataPackPolicyProposal())).toBe(
      renderProposalCardMarkdown(
        proposalCardFromStructuredProposal(dataPackPolicyProposal()),
      ),
    );
  });

  it("keeps the proposal card renderer pure presentation source", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../src/replay/proposal-card.ts", import.meta.url),
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
        "legacy proposal types",
        /RuleProposal|ReviewerConfigProposal|from\s+["'][^"']*(?:proposals|reviewer-config-proposals)["']/u,
      ],
    ];

    for (const [label, pattern] of forbidden) {
      expect(source, `proposal-card must not import/use ${label}`).not.toMatch(
        pattern,
      );
    }
  });
});
