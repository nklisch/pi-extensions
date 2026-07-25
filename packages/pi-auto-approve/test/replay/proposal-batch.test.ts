import { describe, expect, it } from "vitest";

import {
  createStructuredProposalBatch,
  getStructuredProposal,
  mergeStructuredProposalBatches,
  sortStructuredProposals,
} from "../../src/replay/proposal-batch.ts";
import type {
  ProposalEvidence,
  ProposalValidation,
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  PROPOSAL_SCHEMA_VERSION,
  validateStructuredProposalBatch,
} from "../../src/replay/proposal-schema.ts";

const CREATED_AT = "2026-06-26T00:00:00.000Z";

function evidence(overrides: Partial<ProposalEvidence> = {}): ProposalEvidence {
  return {
    familyIds: ["family-1"],
    recordIds: ["record-1"],
    calls: 10,
    uniqueCommands: 2,
    reviewCalls: 8,
    hardBlockCalls: 0,
    modelReviewCalls: 6,
    capturedDenialCalls: 0,
    replayStatusCounts: [{ label: "review", calls: 8 }],
    capturedOutcomeCounts: [{ label: "model-review", calls: 6 }],
    sampleCommands: ["git status"],
    ...overrides,
  };
}

function validation(
  overrides: Partial<ProposalValidation> = {},
): ProposalValidation {
  return {
    schema: { status: "pass", code: "schema-ok", message: "ok" },
    ...overrides,
  };
}

function proposal(
  kind: StructuredRatchetProposal["kind"],
  overrides: Partial<StructuredRatchetProposal> = {},
): StructuredRatchetProposal {
  const base = baseByKind(kind);
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: `prop:${kind}`,
    kind,
    title: `Proposal ${kind}`,
    summary: `Structured proposal for ${kind}`,
    reason: "test proposal reason",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    applicationMode:
      kind === "pack-file-authoring"
        ? "design-input-only"
        : "writable-after-approval",
    evidence: evidence(),
    examples: [
      {
        command: "git status",
        matches: true,
        capturedOutcome: "model-review",
      },
    ],
    fixtureSuggestions: [],
    validation: validation(),
    trustNotes: [],
    warnings: [],
    ...base,
    ...overrides,
  };
}

function baseByKind(
  kind: StructuredRatchetProposal["kind"],
): Pick<StructuredRatchetProposal, "target" | "change" | "intendedProvenance"> {
  switch (kind) {
    case "data-pack-policy":
      return {
        intendedProvenance: "user-global",
        target: { kind: "user-global-config", path: "/config/global.json" },
        change: {
          kind: "policy-pack",
          packId: "pack:generated",
          ruleId: "allow-git-status",
          effect: "allow",
          reason: "allow git status",
          match: { program: "git" },
          rawPackPatch: [{ op: "add", path: "/packs/-", value: {} }],
        },
      };
    case "reviewer-config":
      return {
        intendedProvenance: "user-project",
        target: {
          kind: "user-project-overlay",
          path: "/config/project.json",
          projectKey: "project-1",
          projectRoot: "/repo",
        },
        change: {
          kind: "reviewer-config",
          pointer: "/promptAppends/-",
          op: "append-string",
          before: [],
          after: "reviewer hint",
          rendered: "append reviewer hint",
        },
      };
    case "project-scope-config":
      return {
        intendedProvenance: "user-project",
        target: {
          kind: "user-project-overlay",
          path: "/config/project.json",
          projectKey: "project-1",
          projectRoot: "/repo",
        },
        change: {
          kind: "project-scope-config",
          patch: [
            {
              op: "replace",
              path: "/projectScope/roots",
              before: [],
              value: ["/repo"],
            },
          ],
        },
      };
    case "package-pack-enablement":
      return {
        intendedProvenance: "user-global",
        target: {
          kind: "package-pack-config",
          path: "/config/global.json",
          packId: "pack:demo",
          packageName: "@demo/pack",
          packageVersion: "1.0.0",
        },
        change: {
          kind: "package-pack-enablement",
          packId: "pack:demo",
          enable: true,
          packageName: "@demo/pack",
          packageVersion: "1.0.0",
          packagePath: "/packages/demo",
          metadataWarnings: [],
          plan: {
            id: "plan:pack-demo",
            request: {
              action: "enable",
              scope: "global",
              subject: "package",
              packId: "pack:demo",
            },
            targetPath: "/config/global.json",
            patch: [
              {
                op: "replace",
                path: "/packEnablement/enabledPackagePacks",
                before: [],
                value: ["pack:demo"],
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
                enabledPackagePacks: ["pack:demo"],
                disabledPackagePacks: [],
                disabledConfigPacks: [],
              },
              packs: [],
            },
            warnings: [],
            requiredAcknowledgementCodes: [],
          },
        },
      };
    case "pack-file-authoring":
      return {
        intendedProvenance: "shipped",
        target: { kind: "design-input", route: "core-matcher" },
        change: {
          kind: "pack-file-authoring",
          authoringKind: "core-matcher",
          matcherName: "gitWithPath",
          matcherSignature: "gitWithPath(): MatcherExpr",
          rationale: "core matcher design input",
        },
      };
  }
}

function batchRoundTrip(
  batch: StructuredProposalBatch,
): StructuredProposalBatch {
  const result = validateStructuredProposalBatch(
    JSON.parse(JSON.stringify(batch)),
  );
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.batch;
}

describe("proposal-batch", () => {
  it("creates a mixed-kind batch and validates every proposal", () => {
    const proposals = [
      proposal("data-pack-policy"),
      proposal("reviewer-config"),
      proposal("project-scope-config"),
      proposal("package-pack-enablement"),
      proposal("pack-file-authoring"),
    ];

    const batch = createStructuredProposalBatch({
      generatedAt: CREATED_AT,
      proposals,
      source: {
        corpusSummary: {
          totalRecords: 10,
          totalUniqueCommands: 5,
          modelReviewLoad: { calls: 4, uniqueCommands: 2 },
          redactedCalls: 0,
          lowFidelityCalls: 0,
        },
        warnings: ["source warning"],
      },
      warnings: ["generator warning"],
    });

    expect(validateStructuredProposalBatch(batch)).toMatchObject({ ok: true });
    expect(batch.proposals.map((item) => item.kind).sort()).toEqual(
      proposals.map((item) => item.kind).sort(),
    );
    expect(batch.source.warnings).toEqual(["source warning"]);
    expect(batch.warnings).toEqual(["source warning", "generator warning"]);
    expect(batchRoundTrip(batch)).toEqual(batch);
  });

  it("skips malformed proposals with warnings instead of discarding the batch", () => {
    const batch = createStructuredProposalBatch({
      generatedAt: CREATED_AT,
      proposals: [proposal("data-pack-policy"), { kind: "reviewer-config" }],
    });

    expect(batch.proposals).toHaveLength(1);
    expect(batch.proposals[0]?.kind).toBe("data-pack-policy");
    expect(batch.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Skipped malformed structured proposal at index 1",
        ),
      ]),
    );
  });

  it("returns a valid empty batch when every proposal is malformed", () => {
    const batch = createStructuredProposalBatch({
      generatedAt: CREATED_AT,
      proposals: [{ kind: "reviewer-config" }, { id: "missing-kind" }],
    });

    expect(batch.proposals).toEqual([]);
    expect(batch.warnings).toEqual([
      expect.stringContaining(
        "Skipped malformed structured proposal at index 0",
      ),
      expect.stringContaining(
        "Skipped malformed structured proposal at index 1",
      ),
    ]);
    expect(batchRoundTrip(batch)).toEqual(batch);
  });

  it("sorts deterministically by impact, then safer posture, then id", () => {
    const lowImpact = proposal("data-pack-policy", {
      id: "z-low",
      evidence: evidence({
        calls: 1,
        uniqueCommands: 1,
        reviewCalls: 1,
        modelReviewCalls: 0,
      }),
    });
    const highRisk = proposal("reviewer-config", {
      id: "b-high-risk",
      applicationMode: "writable-after-approval",
      evidence: evidence({ calls: 20, uniqueCommands: 3 }),
      trustNotes: [
        { kind: "warning", message: "review change", severity: "warning" },
      ],
    });
    const highSafe = proposal("pack-file-authoring", {
      id: "a-high-safe",
      applicationMode: "design-input-only",
      evidence: evidence({ calls: 20, uniqueCommands: 3 }),
    });

    expect(
      sortStructuredProposals([lowImpact, highRisk, highSafe]).map((p) => p.id),
    ).toEqual(["a-high-safe", "b-high-risk", "z-low"]);
  });

  it("dedupes by id or target/change fingerprint and keeps the safer version", () => {
    const writable = proposal("data-pack-policy", {
      id: "dup",
      applicationMode: "writable-after-approval",
      warnings: ["writable warning"],
      evidence: evidence({ calls: 50 }),
    });
    const designInput = proposal("pack-file-authoring", {
      id: "dup",
      applicationMode: "design-input-only",
      warnings: ["design warning"],
      evidence: evidence({ calls: 1 }),
    });
    const sameChangeDifferentId = proposal("reviewer-config", {
      id: "same-change-1",
    });
    const sameChangeDifferentId2 = proposal("reviewer-config", {
      id: "same-change-2",
      warnings: ["duplicate target/change warning"],
    });

    const batch = createStructuredProposalBatch({
      generatedAt: CREATED_AT,
      proposals: [
        writable,
        designInput,
        sameChangeDifferentId,
        sameChangeDifferentId2,
      ],
    });

    expect(batch.proposals.map((item) => item.id).sort()).toEqual([
      "dup",
      "same-change-1",
    ]);
    expect(getStructuredProposal(batch, "dup")?.kind).toBe(
      "pack-file-authoring",
    );
    expect(batch.warnings.join("\n")).toContain("kept safer proposal dup");
    expect(batch.warnings.join("\n")).toContain(
      "duplicate target/change warning",
    );
  });

  it("dedupes an incoming id and fingerprint tri-collision as one collision set", () => {
    const idCollision = proposal("data-pack-policy", {
      id: "bridge",
      evidence: evidence({ calls: 100, uniqueCommands: 10 }),
    });
    const fingerprintCollision = proposal("reviewer-config", {
      id: "fingerprint-kept",
      evidence: evidence({ calls: 100, uniqueCommands: 10 }),
      warnings: ["fingerprint loser warning"],
    });
    const bridge = proposal("reviewer-config", {
      id: "bridge",
      applicationMode: "design-input-only",
      evidence: evidence({ calls: 1, uniqueCommands: 1, reviewCalls: 1 }),
    });

    const batch = createStructuredProposalBatch({
      generatedAt: CREATED_AT,
      proposals: [idCollision, fingerprintCollision, bridge],
    });

    expect(batch.proposals).toHaveLength(1);
    expect(batch.proposals[0]).toMatchObject({
      id: "bridge",
      kind: "reviewer-config",
      applicationMode: "design-input-only",
    });
    expect(batch.warnings.join("\n")).toContain(
      "Deduped conflicting structured proposals",
    );
    expect(batch.warnings.join("\n")).toContain("fingerprint loser warning");
  });

  it("merges batches and supports lookup by proposal id", () => {
    const first = createStructuredProposalBatch({
      generatedAt: "2026-06-26T00:00:00.000Z",
      proposals: [proposal("data-pack-policy", { id: "data" })],
      warnings: ["first warning"],
    });
    const second = createStructuredProposalBatch({
      generatedAt: "2026-06-27T00:00:00.000Z",
      proposals: [proposal("pack-file-authoring", { id: "authoring" })],
      source: { warnings: ["second source warning"] },
    });

    const merged = mergeStructuredProposalBatches(first, second);

    expect(merged.generatedAt).toBe("2026-06-27T00:00:00.000Z");
    expect(getStructuredProposal(merged, "authoring")?.kind).toBe(
      "pack-file-authoring",
    );
    expect(getStructuredProposal(merged, "missing")).toBeUndefined();
    expect(merged.warnings).toEqual(["second source warning", "first warning"]);
    expect(batchRoundTrip(merged)).toEqual(merged);
  });
});
