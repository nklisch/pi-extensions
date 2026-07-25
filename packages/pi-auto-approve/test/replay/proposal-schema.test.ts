import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import type {
  AdversarialValidationReport,
  ProposalEvidence,
  ProposalExample,
  ProposalFixtureSuggestion,
  ProposalTrustNote,
  ProposalValidation,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  ADVERSARIAL_CASE_CATEGORIES,
  ADVERSARIAL_CASE_EXPECTATIONS,
  ADVERSARIAL_CASE_RESULT_OUTCOMES,
  ADVERSARIAL_CASE_SOURCES,
  ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
  ADVERSARIAL_VALIDATION_STATUSES,
  AdversarialValidationReportSchema,
  assertStructuredProposal,
  isWritableProposal,
  PROPOSAL_APPLICATION_MODES,
  PROPOSAL_BATCH_SCHEMA_VERSION,
  PROPOSAL_CHANGE_KINDS,
  PROPOSAL_SCHEMA_VERSION,
  PROPOSAL_TARGET_KINDS,
  PROPOSAL_VALIDATION_STATUSES,
  ProposalSchemaError,
  proposalJsonRoundTrip,
  STRUCTURED_PROPOSAL_KINDS,
  StructuredRatchetProposalSchema,
  validateStructuredProposal,
  validateStructuredProposalBatch,
} from "../../src/replay/proposal-schema.ts";

// ---------------------------------------------------------------------------
// Builders — complete, valid sub-objects (no Partial/spread so
// exactOptionalPropertyTypes stays satisfied). Optional fields are omitted
// unless a builder deliberately exercises them.
// ---------------------------------------------------------------------------

function validEvidence(): ProposalEvidence {
  return {
    corpusSummary: {
      totalRecords: 24,
      totalUniqueCommands: 6,
      modelReviewLoad: { calls: 4, uniqueCommands: 2 },
      redactedCalls: 1,
      lowFidelityCalls: 1,
    },
    familyIds: ["fam-git-status"],
    recordIds: ["rec-1", "rec-2"],
    calls: 24,
    uniqueCommands: 6,
    reviewCalls: 8,
    hardBlockCalls: 2,
    modelReviewCalls: 4,
    capturedDenialCalls: 3,
    replayStatusCounts: [
      { label: "review", calls: 8 },
      { label: "hard_block", calls: 2 },
    ],
    capturedOutcomeCounts: [
      { label: "model-review", calls: 4 },
      { label: "human-deny", calls: 3 },
    ],
    sampleCommands: ["git status", "git push"],
  };
}

function validAdversarialReport(): AdversarialValidationReport {
  return {
    version: ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
    proposalId: "prop-data-1",
    status: "failed",
    generatedCaseCount: 2,
    evaluatedCaseCount: 2,
    failedCaseCount: 1,
    skippedCaseCount: 0,
    cases: [
      {
        id: "adv-path-1",
        command: "git status ../outside",
        category: "path-scope",
        expectation: "not-fast-path",
        rationale: "path escape should not become a fast-path allow",
        source: "sample-mutation",
        derivedFrom: "git status",
      },
      {
        id: "adv-pipe-1",
        command: "git status | sh",
        category: "pipeline",
        expectation: "hard_block",
        rationale: "pipe-to-shell remains sealed-floor territory",
        source: "program-catalog",
      },
    ],
    results: [
      {
        caseId: "adv-path-1",
        command: "git status ../outside",
        category: "path-scope",
        expectation: "not-fast-path",
        outcome: "passed",
        actualStatus: "review",
        actualReason: "path scope unknown",
        diagnostics: [],
      },
      {
        caseId: "adv-pipe-1",
        command: "git status | sh",
        category: "pipeline",
        expectation: "hard_block",
        outcome: "failed",
        actualStatus: "fast_path",
        actualRuleId: "allow-git-status",
        actualReason: "matched candidate allow",
        diagnostics: ["expected hard_block, got fast_path"],
      },
    ],
    warnings: ["one adversarial case failed"],
  };
}

function validValidation(): ProposalValidation {
  return {
    schema: {
      status: "pass",
      code: "schema-ok",
      message: "proposal conforms to structured schema",
    },
  };
}

function validExample(): ProposalExample {
  return {
    command: "git status",
    matches: true,
    capturedOutcome: "model-review",
    note: "would match the proposed matcher",
  };
}

function validFixture(): ProposalFixtureSuggestion {
  return {
    command: "git status",
    expected: "fast_path",
    reason: "baseline allow for read-only git status",
    provenance: "fixtures.yaml",
  };
}

function validTrustNote(): ProposalTrustNote {
  return {
    kind: "opaque-matcher",
    message: "matcher is structural; verify no path escape",
    severity: "warning",
  };
}

const CREATED_AT = "2026-06-26T00:00:00.000Z";

function dataPackPolicyProposal(): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-data-1",
    kind: "data-pack-policy",
    title: "Allow git status",
    summary: "Structural allow for read-only git status.",
    reason: "8 review calls with no captured denials; safe read-only command.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-global",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-global-config",
      path: "~/.config/pi-auto-approve/config.json",
    },
    change: {
      kind: "policy-pack",
      packId: "user-global-bash",
      ruleId: "allow-git-status",
      effect: "allow",
      reason: "read-only git status",
      match: { toolName: "bash", executable: "git", args: ["status"] },
      rawPackPatch: [
        {
          op: "add",
          path: "/packs/0/rules/-",
          value: { id: "allow-git-status", effect: "allow" },
        },
      ],
      fileWrite: {
        path: "~/.config/pi-auto-approve/config.json",
        format: "json",
        mode: "patch",
        atomic: true,
        backupRequired: true,
        patch: [
          {
            op: "add",
            path: "/packs/0/rules/-",
            value: { id: "allow-git-status", effect: "allow" },
          },
        ],
      },
    },
    evidence: validEvidence(),
    examples: [validExample()],
    fixtureSuggestions: [validFixture()],
    validation: validValidation(),
    trustNotes: [validTrustNote()],
    warnings: [],
  };
}

function reviewerConfigProposal(): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-reviewer-1",
    kind: "reviewer-config",
    title: "Append project prompt for test commands",
    summary: "Append a reviewer prompt fragment for test friction.",
    reason: "Test commands trigger review; an append narrows the prompt.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-project-overlay",
      path: "./.pi/auto-reviewer.json",
      projectKey: "pi-auto-approve",
      projectRoot: "/home/nathan/dev/pi-auto-approve",
    },
    change: {
      kind: "reviewer-config",
      pointer: "/reviewer/projectPromptAppends/-",
      op: "append-string",
      before: [],
      after: "Prefer structural allow for read-only test runs.",
      rendered: 'reviewer.projectPromptAppends += "Prefer structural allow..."',
    },
    evidence: validEvidence(),
    examples: [validExample()],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
      configSchema: {
        status: "pass",
        code: "config-schema-ok",
        message: "overlay validates",
      },
      promptOverride: {
        status: "skipped",
        code: "prompt-override-na",
        message: "no override set",
      },
    },
    trustNotes: [],
    warnings: [],
  };
}

function projectScopeProposal(): StructuredRatchetProposal {
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
      path: "./.pi/auto-reviewer.json",
      projectKey: "pi-auto-approve",
      projectRoot: "/home/nathan/dev/pi-auto-approve",
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
    evidence: validEvidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
      configSchema: {
        status: "pass",
        code: "config-schema-ok",
        message: "overlay validates",
      },
    },
    trustNotes: [
      {
        kind: "path-scope",
        message: "writableDirectories widens path scope; verify roots",
        severity: "warning",
      },
    ],
    warnings: [],
  };
}

function packagePackEnablementProposal(): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-pack-1",
    kind: "package-pack-enablement",
    title: "Enable shipped test-safety pack",
    summary: "Enable package-contributed pack 'test-safety'.",
    reason: "Pack is installed and matches captured friction.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-global",
    applicationMode: "writable-after-approval",
    target: {
      kind: "package-pack-config",
      path: "~/.config/pi-auto-approve/config.json",
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
      metadataWarnings: [
        "pack declares destructive-git matcher; review before enable",
      ],
      plan: {
        id: "pack-enable:test-safety",
        request: {
          action: "enable",
          scope: "global",
          subject: "package",
          packId: "test-safety",
        },
        targetPath: "~/.config/pi-auto-approve/config.json",
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
            code: "metadata-warning-0",
            level: "warning",
            message:
              "pack declares destructive-git matcher; review before enable",
            source: "metadata",
            requiresAcknowledgement: false,
          },
        ],
        requiredAcknowledgementCodes: [],
      },
    },
    evidence: validEvidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
      packageAvailability: {
        status: "pass",
        code: "package-available",
        message: "package installed and currently disabled",
      },
      trust: {
        status: "pending",
        code: "trust-pending",
        message: "operator trust record not confirmed",
      },
    },
    trustNotes: [
      {
        kind: "package-pack",
        message: "enablement is not installation",
        severity: "info",
      },
    ],
    warnings: ["pack carries a danger-level metadata warning"],
  };
}

function packFileAuthoringProposal(): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-authoring-1",
    kind: "pack-file-authoring",
    title: "Draft core matcher for git push guards",
    summary: "Design input: a core matcher gating force-push.",
    reason:
      "Force-push friction needs a core matcher; structural matchers cannot express it.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    applicationMode: "design-input-only",
    target: {
      kind: "design-input",
      route: "core-matcher",
      suggestedPath: "./.pi/packs/git-push-guards.json",
    },
    change: {
      kind: "pack-file-authoring",
      authoringKind: "core-matcher",
      matcherName: "isForcePush",
      matcherSignature: "(shape: BashCommandShape) => boolean",
      rationale:
        "Force-push needs a core matcher; structural matchers cannot express branch protection.",
      fileWrite: {
        path: "./.pi/packs/git-push-guards.json",
        format: "json",
        mode: "create",
        atomic: false,
        backupRequired: false,
        contents: '{"kind":"core-matcher-design-input"}',
      },
    },
    evidence: validEvidence(),
    examples: [validExample()],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
      trust: {
        status: "pass",
        code: "trust-structural",
        message: "structural matcher; no executable code or DSL change",
      },
    },
    trustNotes: [],
    warnings: ["design-input only; not writable"],
  };
}

/** Deep-clone a valid proposal as a mutable record and apply a mutation. */
function withMutation(
  base: StructuredRatchetProposal,
  mutate: (draft: Record<string, unknown>) => void,
): unknown {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  mutate(draft);
  return draft;
}

/** Cast a nested draft field to a mutable record for further mutation. */
function field(
  draft: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return draft[key] as Record<string, unknown>;
}

const ALL_VALID_PROPOSALS: ReadonlyArray<StructuredRatchetProposal> = [
  dataPackPolicyProposal(),
  reviewerConfigProposal(),
  projectScopeProposal(),
  packagePackEnablementProposal(),
  packFileAuthoringProposal(),
];

// ---------------------------------------------------------------------------
// Schema version + helper arrays
// ---------------------------------------------------------------------------

describe("proposal schema — version and helper arrays", () => {
  it("exports schema version 1", () => {
    expect(PROPOSAL_SCHEMA_VERSION).toBe(1);
    expect(PROPOSAL_BATCH_SCHEMA_VERSION).toBe(1);
    expect(ADVERSARIAL_VALIDATION_SCHEMA_VERSION).toBe(1);
  });

  it("enumerates every proposal kind, application mode, and status", () => {
    expect(STRUCTURED_PROPOSAL_KINDS).toEqual([
      "data-pack-policy",
      "reviewer-config",
      "project-scope-config",
      "package-pack-enablement",
      "pack-file-authoring",
    ]);
    expect(PROPOSAL_APPLICATION_MODES).toEqual([
      "writable-after-approval",
      "design-input-only",
    ]);
    expect(PROPOSAL_VALIDATION_STATUSES).toEqual([
      "pass",
      "fail",
      "skipped",
      "pending",
    ]);
    expect(PROPOSAL_CHANGE_KINDS).toEqual([
      "policy-pack",
      "reviewer-config",
      "project-scope-config",
      "package-pack-enablement",
      "pack-file-authoring",
    ]);
    expect(PROPOSAL_TARGET_KINDS).toEqual([
      "user-global-config",
      "user-project-overlay",
      "package-pack-config",
      "design-input",
    ]);
  });

  it("enumerates adversarial evidence literals", () => {
    expect(ADVERSARIAL_VALIDATION_STATUSES).toEqual([
      "not-run",
      "passed",
      "failed",
    ]);
    expect(ADVERSARIAL_CASE_CATEGORIES).toEqual([
      "path-scope",
      "quoting",
      "substitution",
      "redirect",
      "operator",
      "pipeline",
      "cwd-prefix",
      "program-specific",
      "parser-footgun",
    ]);
    expect(ADVERSARIAL_CASE_EXPECTATIONS).toEqual([
      "not-fast-path",
      "hard_block",
      "review",
    ]);
    expect(ADVERSARIAL_CASE_SOURCES).toEqual([
      "template",
      "sample-mutation",
      "program-catalog",
    ]);
    expect(ADVERSARIAL_CASE_RESULT_OUTCOMES).toEqual([
      "passed",
      "failed",
      "skipped",
      "errored",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Valid proposals — every kind, every target, every change variant
// ---------------------------------------------------------------------------

describe("proposal schema — valid proposals", () => {
  it.each([
    ["data-pack-policy", dataPackPolicyProposal()],
    ["reviewer-config", reviewerConfigProposal()],
    ["project-scope-config", projectScopeProposal()],
    ["package-pack-enablement", packagePackEnablementProposal()],
    ["pack-file-authoring", packFileAuthoringProposal()],
  ])("validates a %s proposal", (_label, proposal) => {
    const result = validateStructuredProposal(proposal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.id).toBe(proposal.id);
    }
  });

  it("every valid proposal passes Value.Check directly against the schema", () => {
    for (const proposal of ALL_VALID_PROPOSALS) {
      expect(Value.Check(StructuredRatchetProposalSchema, proposal)).toBe(true);
    }
  });

  it("accepts each target kind via a distinct proposal", () => {
    const targetKinds = ALL_VALID_PROPOSALS.map((p) => p.target.kind);
    expect(new Set(targetKinds)).toEqual(
      new Set([
        "user-global-config",
        "user-project-overlay",
        "package-pack-config",
        "design-input",
      ]),
    );
    for (const proposal of ALL_VALID_PROPOSALS) {
      expect(validateStructuredProposal(proposal).ok).toBe(true);
    }
  });

  it("accepts each design-input route", () => {
    for (const route of ["shipped-pack", "core-matcher"] as const) {
      const mutant = withMutation(packFileAuthoringProposal(), (draft) => {
        field(draft, "target").route = route;
      });
      expect(validateStructuredProposal(mutant).ok).toBe(true);
    }
  });

  it("accepts a policy-pack proposal with a review effect and no fileWrite", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      delete field(draft, "change").fileWrite;
      field(draft, "change").effect = "review";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Strict field rejection (additionalProperties: false)
// ---------------------------------------------------------------------------

describe("proposal schema — strict field rejection", () => {
  it("rejects unknown top-level fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      draft.unexpected = "x";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown target fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "target").unexpected = "x";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown change fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "change").unexpected = "x";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown validation fields", () => {
    const mutant = withMutation(reviewerConfigProposal(), (draft) => {
      field(draft, "validation").unexpected = "x";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown validation-check fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(field(draft, "validation"), "schema").unexpected = "x";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown file-write fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(field(draft, "change"), "fileWrite").unexpected = "x";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown evidence fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "evidence").unexpected = "x";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown example fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      const examples = draft.examples as unknown as Record<string, unknown>[];
      const first = examples[0] as unknown as Record<string, unknown>;
      if (first !== undefined) {
        first.unexpected = "x";
      }
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown json-patch-operation fields", () => {
    const mutant = withMutation(projectScopeProposal(), (draft) => {
      const patch = field(draft, "change").patch as unknown as Record<
        string,
        unknown
      >[];
      const first = patch[0] as unknown as Record<string, unknown>;
      if (first !== undefined) {
        first.unexpected = "x";
      }
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects unknown trust-note fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      const notes = field(draft, "trustNotes") as unknown as Record<
        string,
        unknown
      >[];
      const first = notes[0] as unknown as Record<string, unknown>;
      if (first !== undefined) {
        first.unexpected = "x";
      }
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kind / version / discriminator rejection
// ---------------------------------------------------------------------------

describe("proposal schema — kind and version", () => {
  it("rejects an unknown proposal kind", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      draft.kind = "not-a-real-kind";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects an unknown change kind", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "change").kind = "not-a-real-change-kind";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects the wrong schema version", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      draft.version = 2;
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects a string version", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      draft.version = "1";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects an unknown design-input route", () => {
    const mutant = withMutation(packFileAuthoringProposal(), (draft) => {
      field(draft, "target").route = "not-a-route";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects an unknown authoring kind", () => {
    const mutant = withMutation(packFileAuthoringProposal(), (draft) => {
      field(draft, "change").authoringKind = "not-an-authoring-kind";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects an unknown validation status", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(field(draft, "validation"), "schema").status = "maybe";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip + no Map / function / compiled-matcher state
// ---------------------------------------------------------------------------

describe("proposal schema — JSON round-trip and raw-JSON contract", () => {
  it.each([
    ["data-pack-policy", dataPackPolicyProposal()],
    ["reviewer-config", reviewerConfigProposal()],
    ["project-scope-config", projectScopeProposal()],
    ["package-pack-enablement", packagePackEnablementProposal()],
    ["pack-file-authoring", packFileAuthoringProposal()],
  ])("round-trips a %s proposal through JSON unchanged", (_label, proposal) => {
    const roundTripped = proposalJsonRoundTrip(proposal);
    expect(roundTripped).toEqual(proposal);
  });

  it("serializes without a custom replacer", () => {
    const proposal = dataPackPolicyProposal();
    const json = JSON.stringify(proposal);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(validateStructuredProposal(JSON.parse(json)).ok).toBe(true);
  });

  it("rejects an evidence object carrying a legacy capturedOutcomeBreakdown field", () => {
    // The legacy ProposalEvidence stored outcomes in a ReadonlyMap under this
    // key. Strict rejection proves the structured contract is array-shaped.
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "evidence").capturedOutcomeBreakdown = {
        "model-review": 4,
        "human-deny": 3,
      };
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects a Map instance where an evidence count array is required", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "evidence").capturedOutcomeCounts = new Map([
        ["model-review", 4],
      ]);
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("proposalJsonRoundTrip throws when evidence holds a Map (Map does not survive JSON)", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "evidence").capturedOutcomeCounts = new Map([
        ["model-review", 4],
      ]);
    }) as StructuredRatchetProposal;
    expect(() => proposalJsonRoundTrip(mutant)).toThrow(ProposalSchemaError);
  });

  it("rejects an extra compiledMatch field on the proposal (no compiled-matcher slot)", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      draft.compiledMatch = () => true;
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects an extra compiledMatch field on the change", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "change").compiledMatch = () => true;
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("proposalJsonRoundTrip throws when change.match is a function (functions do not survive JSON)", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "change").match = () => true;
    }) as StructuredRatchetProposal;
    // A function validates against Type.Unknown(), but JSON.stringify drops it,
    // the required `match` key vanishes, and re-validation fails. This is the
    // proof that the contract carries raw JSON, not compiled predicates.
    expect(validateStructuredProposal(mutant).ok).toBe(true);
    expect(() => proposalJsonRoundTrip(mutant)).toThrow(ProposalSchemaError);
  });
});

// ---------------------------------------------------------------------------
// Adversarial evidence contract
// ---------------------------------------------------------------------------

function proposalWithAdversarialReport(
  mutateReport?: (report: Record<string, unknown>) => void,
): unknown {
  return withMutation(dataPackPolicyProposal(), (draft) => {
    const report = JSON.parse(
      JSON.stringify(validAdversarialReport()),
    ) as Record<string, unknown>;
    mutateReport?.(report);
    field(draft, "evidence").adversarial = report;
  });
}

describe("proposal schema — adversarial evidence contract", () => {
  it("accepts a strict typed adversarial report and keeps the field optional", () => {
    expect(
      Value.Check(AdversarialValidationReportSchema, validAdversarialReport()),
    ).toBe(true);
    expect(validateStructuredProposal(dataPackPolicyProposal()).ok).toBe(true);

    const proposal = proposalWithAdversarialReport();
    const result = validateStructuredProposal(proposal);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.evidence.adversarial?.status).toBe("failed");
      expect(proposalJsonRoundTrip(result.proposal)).toEqual(result.proposal);
    }
  });

  it.each([
    [
      "unknown status",
      (report: Record<string, unknown>) => {
        report.status = "ok";
      },
    ],
    [
      "unknown category",
      (report: Record<string, unknown>) => {
        const cases = report.cases as Array<Record<string, unknown>>;
        const firstCase = cases[0];
        if (firstCase) {
          firstCase.category = "network";
        }
      },
    ],
    [
      "unknown result outcome",
      (report: Record<string, unknown>) => {
        const results = report.results as Array<Record<string, unknown>>;
        const firstResult = results[0];
        if (firstResult) {
          firstResult.outcome = "maybe";
        }
      },
    ],
    [
      "negative count",
      (report: Record<string, unknown>) => {
        report.failedCaseCount = -1;
      },
    ],
    [
      "function command",
      (report: Record<string, unknown>) => {
        const cases = report.cases as Array<Record<string, unknown>>;
        const firstCase = cases[0];
        if (firstCase) {
          firstCase.command = () => "git status";
        }
      },
    ],
    [
      "extra nested field",
      (report: Record<string, unknown>) => {
        const cases = report.cases as Array<Record<string, unknown>>;
        const firstCase = cases[0];
        if (firstCase) {
          firstCase.compiledMatcher = { opaque: true };
        }
      },
    ],
  ])("rejects malformed adversarial evidence: %s", (_label, mutateReport) => {
    expect(
      validateStructuredProposal(proposalWithAdversarialReport(mutateReport))
        .ok,
    ).toBe(false);
  });

  it("rejects Map instances in the adversarial evidence slot", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "evidence").adversarial = new Map([["status", "passed"]]);
    });

    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation status taxonomy
// ---------------------------------------------------------------------------

describe("proposal schema — validation status taxonomy", () => {
  it("accepts every validation status value on every optional check", () => {
    for (const status of PROPOSAL_VALIDATION_STATUSES) {
      const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
        const validation = field(draft, "validation");
        validation.matcherCompile = { status, code: "x", message: "m" };
        validation.replay = { status, code: "x", message: "m" };
        validation.adversarial = { status, code: "x", message: "m" };
      });
      expect(validateStructuredProposal(mutant).ok).toBe(true);
    }
  });

  it("accepts a proposal whose replay and adversarial checks are pending/skipped", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      const validation = field(draft, "validation");
      validation.replay = {
        status: "pending",
        code: "replay-pending",
        message: "replay-delta story fills this",
      };
      validation.adversarial = {
        status: "skipped",
        code: "adversarial-skipped",
        message: "not run yet",
      };
    });
    const result = validateStructuredProposal(mutant);
    expect(result.ok).toBe(true);
  });

  it("isWritableProposal reflects applicationMode, not validation status", () => {
    // A writable proposal stays writable even with pending/skipped checks; the
    // staged status is never collapsed into a single pass/fail boolean here.
    const writable = dataPackPolicyProposal();
    expect(isWritableProposal(writable)).toBe(true);
    const designInput = packFileAuthoringProposal();
    expect(isWritableProposal(designInput)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Writable vs design-input helpers
// ---------------------------------------------------------------------------

describe("proposal schema — writable vs design-input", () => {
  it("isWritableProposal is true only for writable-after-approval", () => {
    expect(isWritableProposal(dataPackPolicyProposal())).toBe(true);
    expect(isWritableProposal(reviewerConfigProposal())).toBe(true);
    expect(isWritableProposal(projectScopeProposal())).toBe(true);
    expect(isWritableProposal(packagePackEnablementProposal())).toBe(true);
  });

  it("isWritableProposal is false for design-input-only", () => {
    expect(isWritableProposal(packFileAuthoringProposal())).toBe(false);
  });

  it("rejects mismatched proposal kind and change kind", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      draft.kind = "reviewer-config";
    });

    const result = validateStructuredProposal(mutant);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'proposal kind "reviewer-config" requires change kind "reviewer-config"',
    );
  });

  it("rejects mismatched proposal kind and target kind", () => {
    const mutant = withMutation(packagePackEnablementProposal(), (draft) => {
      draft.target = {
        kind: "user-global-config",
        path: "/config/global.json",
      };
    });

    const result = validateStructuredProposal(mutant);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'proposal kind "package-pack-enablement" cannot target "user-global-config"',
    );
  });

  it("rejects writable pack-file authoring proposals", () => {
    const mutant = withMutation(packFileAuthoringProposal(), (draft) => {
      draft.applicationMode = "writable-after-approval";
    });

    const result = validateStructuredProposal(mutant);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'pack-file-authoring proposals must be "design-input-only"',
    );
  });

  it("applies coherence validation inside proposal batches", () => {
    const mutant = withMutation(packFileAuthoringProposal(), (draft) => {
      draft.applicationMode = "writable-after-approval";
    });
    const batch = {
      version: PROPOSAL_BATCH_SCHEMA_VERSION,
      generatedAt: CREATED_AT,
      source: { warnings: [] },
      proposals: [mutant],
      warnings: [],
    };

    const result = validateStructuredProposalBatch(batch);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("/proposals/0");
    expect(result.errors.join("\n")).toContain(
      'pack-file-authoring proposals must be "design-input-only"',
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed input + assert helper
// ---------------------------------------------------------------------------

describe("proposal schema — malformed input", () => {
  it.each([
    ["string", "not an object"],
    ["number", 42],
    ["array", [1, 2, 3]],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s input", (_label, input) => {
    const result = validateStructuredProposal(input);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects wrong-typed fields", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      field(draft, "evidence").calls = "many";
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("rejects a missing required field", () => {
    const mutant = withMutation(dataPackPolicyProposal(), (draft) => {
      delete draft.reason;
    });
    expect(validateStructuredProposal(mutant).ok).toBe(false);
  });

  it("assertStructuredProposal throws ProposalSchemaError on invalid input", () => {
    expect(() => assertStructuredProposal({ version: 2 })).toThrow(
      ProposalSchemaError,
    );
  });

  it("assertStructuredProposal returns the proposal on valid input", () => {
    const proposal = dataPackPolicyProposal();
    const asserted = assertStructuredProposal(proposal);
    expect(asserted).toEqual(proposal);
  });

  it("ProposalSchemaError carries collected error messages", () => {
    let caught: ProposalSchemaError | undefined;
    try {
      assertStructuredProposal({ version: 99, kind: "nope" });
    } catch (error) {
      if (error instanceof ProposalSchemaError) {
        caught = error;
      }
    }
    expect(caught).toBeInstanceOf(ProposalSchemaError);
    expect(caught?.errors.length).toBeGreaterThan(0);
    expect(caught?.errors.some((e) => e.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batch transport shape
// ---------------------------------------------------------------------------

describe("proposal schema — batch transport", () => {
  function validBatch() {
    return {
      version: PROPOSAL_BATCH_SCHEMA_VERSION,
      generatedAt: CREATED_AT,
      source: {
        corpusSummary: validEvidence().corpusSummary,
        warnings: [],
      },
      proposals: ALL_VALID_PROPOSALS,
      warnings: [],
    };
  }

  it("validates a batch holding all five proposal kinds", () => {
    const result = validateStructuredProposalBatch(validBatch());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.proposals).toHaveLength(5);
    }
  });

  it("rejects a batch with an unknown top-level field", () => {
    const mutant = { ...validBatch(), unexpected: "x" };
    expect(validateStructuredProposalBatch(mutant).ok).toBe(false);
  });

  it("rejects a batch with the wrong version", () => {
    const mutant = { ...validBatch(), version: 2 };
    expect(validateStructuredProposalBatch(mutant).ok).toBe(false);
  });

  it("rejects a batch whose source carries an unknown field", () => {
    const mutant = {
      ...validBatch(),
      source: { ...validBatch().source, unexpected: "x" },
    };
    expect(validateStructuredProposalBatch(mutant).ok).toBe(false);
  });

  it("rejects a batch containing a malformed proposal", () => {
    const mutant = {
      ...validBatch(),
      proposals: [...ALL_VALID_PROPOSALS, { version: 2 }],
    };
    expect(validateStructuredProposalBatch(mutant).ok).toBe(false);
  });

  it("round-trips a valid batch through JSON", () => {
    const batch = validBatch();
    const roundTripped = JSON.parse(JSON.stringify(batch));
    expect(validateStructuredProposalBatch(roundTripped).ok).toBe(true);
  });
});
