import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type {
  ProposalKind,
  ProposalTarget,
  RuleProposal,
} from "../../src/replay/proposals.ts";
import type {
  ReviewerConfigChangeKind,
  ReviewerConfigProposal,
  ReviewerConfigTarget,
} from "../../src/replay/reviewer-config-proposals.ts";
import {
  presentReviewerProposal,
  presentRuleProposal,
  renderDesignInputArtifact,
  routeReviewerProposal,
  routeRuleProposal,
} from "../../src/skill/clearance-tune/presentation.ts";
import {
  isStructuredRatchetProposalLike,
  presentStructuredProposal,
} from "../../src/skill/clearance-tune/structured-presentation.ts";
import { structuredProposal } from "./structured-proposal-fixture.ts";

const MATCH = {
  all: [
    { program: "git" },
    { arg0In: ["status"] },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
} as const;

function ruleProposal(
  overrides: Partial<RuleProposal> & {
    readonly kind?: ProposalKind;
    readonly target?: ProposalTarget;
  } = {},
): RuleProposal {
  const kind = overrides.kind ?? "data";
  const target = overrides.target ?? "user-global";

  return {
    id: `prop:${kind}:${target}`,
    kind,
    target,
    effect: "allow",
    ruleId: `generated-${kind}-${target}`,
    ...(target === "shipped-pack" ? { packId: "bash.dev.verify" } : {}),
    match: MATCH,
    reason: "Reduce repeated git status review friction.",
    scope: target === "user-project" ? "project" : "global",
    provenance: { source: "generated" },
    intendedProvenance:
      target === "user-project" ? "user-project" : "user-global",
    evidence: {
      executable: "git",
      calls: 4,
      unique: 1,
      reviewCalls: 3,
      hardBlockCalls: 0,
      modelReviewCalls: 2,
      capturedDenialCalls: 1,
      behaviors: ["vcs-read"],
      sampleCommands: ["git status --short"],
      capturedOutcomeBreakdown: new Map(),
    },
    examples: [
      {
        command: "git status --short",
        matches: true,
        note: "corpus command verified against proposed matcher",
      },
    ],
    fixtureSuggestions: [
      {
        command: "git status --short",
        expected: "fast_path",
        reason: "Positive example",
        provenance: "prop:test",
      },
    ],
    floorOverlap: {
      status: "disjoint",
      action: "emit",
      checkedFloorRuleIds: [],
      overlappingFloorRuleIds: [],
      note: "allow draft is disjoint from checked floor denies",
    },
    approvalFraming: {
      writesExecutableCode: false,
      touchesDsl: kind === "core-matcher",
      routesAsDesignInput:
        target === "shipped-pack" || target === "core-matcher",
      requiresAcknowledgment: kind !== "data",
      summary: "approval framing summary",
    },
    modelDrafted: false,
    warnings: [],
    ...overrides,
  };
}

function reviewerProposal(
  overrides: Partial<ReviewerConfigProposal> & {
    readonly kind?: ReviewerConfigChangeKind;
    readonly target?: ReviewerConfigTarget;
  } = {},
): ReviewerConfigProposal {
  const target = overrides.target ?? "user-global";
  const kind = overrides.kind ?? "global-append";
  const rendered =
    target === "user-global"
      ? 'reviewer.promptAppends[0]: + "Prefer bounded local workflows."'
      : 'promptAppends[0]: + "Prefer bounded local workflows."';

  return {
    id: `revprop:${kind}:${target}`,
    kind,
    target,
    diff: {
      target,
      pointer:
        target === "user-global"
          ? "/reviewer/promptAppends/-"
          : "/promptAppends/-",
      op: "append-string",
      before: 0,
      after: "Prefer bounded local workflows.",
      rendered,
    },
    reason: "Reviewer prompt guidance can reduce repeated model review.",
    evidence: {
      scope: "family",
      executable: "just",
      calls: 5,
      unique: 1,
      reviewCalls: 5,
      hardBlockCalls: 0,
      modelReviewCalls: 4,
      capturedDenialCalls: 0,
      behaviors: ["workflow-local"],
      sampleCommands: ["just --list"],
      capturedOutcomeBreakdown: new Map(),
    },
    examples: [{ command: "just --list", note: "repeated family" }],
    validation: { schemaOk: true, schemaErrors: [] },
    provenance: { source: "generated" },
    approvalFraming: {
      changesReviewPath: false,
      requiresAcknowledgment: false,
      consentRequired: false,
      summary: "Adjusts reviewer prompt guidance after user approval.",
    },
    modelDrafted: false,
    warnings: [],
    ...overrides,
  };
}

describe("ratchet apply presentation and routing", () => {
  it("routes every rule proposal kind/target pair through write or design-input paths", () => {
    const kinds: readonly ProposalKind[] = ["data", "core-matcher"];
    const targets: readonly ProposalTarget[] = [
      "user-global",
      "user-project",
      "shipped-pack",
      "core-matcher",
    ];

    for (const kind of kinds) {
      for (const target of targets) {
        const route = routeRuleProposal(ruleProposal({ kind, target }));
        if (
          kind === "data" &&
          (target === "user-global" || target === "user-project")
        ) {
          expect(route, `${kind}/${target}`).toBe("write-overlay");
        } else {
          expect(route, `${kind}/${target}`).toBe("route-design-input");
        }
      }
    }
  });

  it("routes every reviewer-config proposal to reviewer writes", () => {
    expect(
      routeReviewerProposal(reviewerProposal({ target: "user-global" })),
    ).toBe("write-reviewer");
    expect(
      routeReviewerProposal(reviewerProposal({ target: "user-project" })),
    ).toBe("write-reviewer");
  });

  it("renders rule diff text with the generated pack and exact RawPolicyPackRule JSON", () => {
    const proposal = ruleProposal({
      target: "user-project",
      intendedProvenance: "user-project",
      ruleId: "allow-git-status",
    });
    const presentation = presentRuleProposal(proposal, true);
    const ruleJson = presentation.diffText.split("Rule JSON:\n")[1];

    expect(presentation.diffText).toContain("Merge pack: ratchet.generated");
    expect(presentation.diffText).toContain("Replaces existing rule:");
    expect(JSON.parse(ruleJson ?? "{}")).toEqual({
      id: "allow-git-status",
      effect: "allow",
      match: MATCH,
      reason: "Reduce repeated git status review friction.",
      provenance: { source: "user-project" },
    });
  });

  it("passes reviewer diff text through verbatim", () => {
    const proposal = reviewerProposal({
      diff: {
        target: "user-global",
        pointer: "/reviewer/contextMode",
        op: "set",
        before: "minimal",
        after: "recentContext",
        rendered: 'reviewer.contextMode: "minimal" → "recentContext"',
      },
    });

    expect(presentReviewerProposal(proposal, true).diffText).toBe(
      proposal.diff.rendered,
    );
  });

  it("sets trustRequired only for untrusted project writes", () => {
    expect(
      presentRuleProposal(ruleProposal({ target: "user-project" }), false)
        .trustRequired,
    ).toBe(true);
    expect(
      presentRuleProposal(ruleProposal({ target: "user-project" }), true)
        .trustRequired,
    ).toBe(false);
    expect(
      presentRuleProposal(ruleProposal({ target: "user-global" }), false)
        .trustRequired,
    ).toBe(false);
    expect(
      presentRuleProposal(ruleProposal({ target: "core-matcher" }), false)
        .trustRequired,
    ).toBe(false);
    expect(
      presentReviewerProposal(
        reviewerProposal({ target: "user-project" }),
        false,
      ).trustRequired,
    ).toBe(true);
    expect(
      presentReviewerProposal(
        reviewerProposal({ target: "user-global" }),
        false,
      ).trustRequired,
    ).toBe(false);
  });

  it("renders routed design-input artifacts with the intended home or blocker", () => {
    const core = renderDesignInputArtifact(
      ruleProposal({
        kind: "core-matcher",
        target: "core-matcher",
        coreMatcher: {
          name: "gitOptionValueArg",
          signature: "{ program, option, value }",
          gap: "Data DSL cannot bind option values to project paths.",
          rationale: "Needed for git -C paths.",
          examples: [],
        },
      }),
    );
    const shipped = renderDesignInputArtifact(
      ruleProposal({ target: "shipped-pack", packId: "bash.dev.verify" }),
    );
    expect(core).toContain("epic-parser-and-policy-core");
    expect(shipped).toContain("bash.dev.verify");
  });

  it("renders structured proposals through the helper presentation seam", () => {
    const proposal = structuredProposal();
    const presentation = presentStructuredProposal(proposal);

    expect(isStructuredRatchetProposalLike(proposal)).toBe(true);
    expect(isStructuredRatchetProposalLike(ruleProposal())).toBe(false);
    expect(isStructuredRatchetProposalLike(reviewerProposal())).toBe(false);
    expect(presentation).toMatchObject({
      proposalId: proposal.id,
      kind: "structured-proposal",
      route: "structured-writable-after-approval",
      title: proposal.title,
      trustRequired: true,
    });
    expect(presentation.diffText).toContain("Pack id: `ratchet.generated`");
    expect(presentation.diffText).toContain("Raw matcher JSON");
    expect(presentation.framing.summary).toContain(
      "Generation/rendering is not approval",
    );
    expect(presentation.evidence.sampleCommands).toContain("echo `tick`");
    expect(presentation.examples).toEqual([
      {
        command: "git custom-safe",
        matches: true,
        note: "corpus command verified against proposed matcher",
      },
    ]);
    expect(presentation.fixtureSuggestions).toEqual([
      {
        command: "git custom-safe",
        expected: "fast_path",
        reason: "positive structured proposal fixture",
      },
    ]);
    expect(presentation.warnings).toContain("structured display seam warning");
  });

  it("keeps presentation modules pure and free of write/execution APIs", () => {
    const sources = [
      "../../src/skill/clearance-tune/presentation.ts",
      "../../src/skill/clearance-tune/structured-presentation.ts",
    ].map((sourcePath) =>
      readFileSync(fileURLToPath(new URL(sourcePath, import.meta.url)), "utf8"),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/from\s+["'](?:node:)?fs/u);
      expect(source).not.toMatch(/from\s+["'](?:node:)?child_process/u);
      expect(source).not.toMatch(
        /\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(/u,
      );
      expect(source).not.toContain("ExtensionAPI");
      expect(source).not.toMatch(
        /apply-writer|planRuleWrite|planReviewerConfigWrite/u,
      );
    }
  });
});
