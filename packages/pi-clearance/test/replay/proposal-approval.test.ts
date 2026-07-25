import { describe, expect, it } from "vitest";

import type { PackEnablementPlan } from "../../src/packs/enablement.ts";
import {
  evaluateProposalApprovalGate,
  isDesignInputOnlyProposal,
} from "../../src/replay/proposal-approval.ts";
import type {
  JsonPatchOperation,
  ProposalEvidence,
  ProposalValidation,
  ProposalValidationCheck,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import { PROPOSAL_SCHEMA_VERSION } from "../../src/replay/proposal-schema.ts";

const CREATED_AT = "2026-06-27T00:00:00.000Z";
const GLOBAL_CONFIG_PATH =
  "/home/nathan/.config/pi/pi-auto-approve/global.json";
const PROJECT_OVERLAY_PATH =
  "/home/nathan/.config/pi/pi-auto-approve/projects/pi-auto-approve-abc12345/overlay.json";
const PROJECT_ROOT = "/home/nathan/dev/pi-auto-approve";
const PROJECT_KEY = "pi-auto-approve-abc12345";

function check(
  status: ProposalValidationCheck["status"],
  code = `${status}-check`,
): ProposalValidationCheck {
  return { status, code, message: `${code} message` };
}

function writablePolicyValidation(
  overrides: Partial<ProposalValidation> = {},
): ProposalValidation {
  return {
    schema: check("pass", "schema-ok"),
    matcherCompile: check("pass", "matcher-ok"),
    floorOverlap: check("pass", "floor-ok"),
    replay: check("pass", "replay-ok"),
    adversarial: check("pass", "adversarial-ok"),
    configSchema: check("pending", "config-writer-validates"),
    trust: check("pass", "trust-ok"),
    ...overrides,
  };
}

function evidence(): ProposalEvidence {
  return {
    familyIds: ["family-git-status"],
    recordIds: ["record-1"],
    calls: 3,
    uniqueCommands: 1,
    reviewCalls: 3,
    hardBlockCalls: 0,
    modelReviewCalls: 3,
    capturedDenialCalls: 0,
    replayStatusCounts: [{ label: "review", calls: 3 }],
    capturedOutcomeCounts: [{ label: "model-review", calls: 3 }],
    sampleCommands: ["git status --short"],
  };
}

function dataPackProposal(
  overrides: {
    readonly validation?: ProposalValidation;
    readonly intendedProvenance?: StructuredRatchetProposal["intendedProvenance"];
    readonly applicationMode?: StructuredRatchetProposal["applicationMode"];
    readonly target?: StructuredRatchetProposal["target"];
    readonly effect?: "allow" | "deny" | "review";
    readonly rawPackPatch?: readonly JsonPatchOperation[];
  } = {},
): StructuredRatchetProposal {
  const target = overrides.target ?? {
    kind: "user-global-config" as const,
    path: GLOBAL_CONFIG_PATH,
  };
  const rawPackPatch = overrides.rawPackPatch ?? [
    {
      op: "add" as const,
      path: "/packs/-",
      value: {
        version: 1,
        id: "user-global-git",
        rules: [
          {
            id: "allow-git-status",
            effect: overrides.effect ?? "allow",
            match: { all: [{ program: "git" }, { arg0In: ["status"] }] },
            reason: "read-only git status",
            provenance: { source: "user-global" },
          },
        ],
      },
    },
  ];

  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-data-1",
    kind: "data-pack-policy",
    title: "Allow git status",
    summary: "Adds a user-owned data pack rule.",
    reason: "Repeated reviewed git status calls.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: overrides.intendedProvenance ?? "user-global",
    applicationMode: overrides.applicationMode ?? "writable-after-approval",
    target,
    change: {
      kind: "policy-pack",
      packId: "user-global-git",
      ruleId: "allow-git-status",
      effect: overrides.effect ?? "allow",
      reason: "read-only git status",
      match: { all: [{ program: "git" }, { arg0In: ["status"] }] },
      rawPackPatch,
      ...(target.kind === "user-global-config" ||
      target.kind === "user-project-overlay"
        ? {
            fileWrite: {
              path: target.path,
              format: "json" as const,
              mode: "patch" as const,
              atomic: true,
              backupRequired: true,
              patch: rawPackPatch,
            },
          }
        : {}),
    },
    evidence: evidence(),
    examples: [
      {
        command: "git status --short",
        matches: true,
        capturedOutcome: "model-review",
      },
    ],
    fixtureSuggestions: [],
    validation: overrides.validation ?? writablePolicyValidation(),
    trustNotes: [],
    warnings: [],
  };
}

function reviewerProposal(
  validation: ProposalValidation = {
    schema: check("pass", "schema-ok"),
    configSchema: check("pending", "writer-validates-config"),
    promptOverride: check("pending", "writer-validates-prompt"),
    replay: check("pending", "reviewer-replay-not-deterministic"),
  },
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-reviewer-1",
    kind: "reviewer-config",
    title: "Append reviewer prompt guidance",
    summary: "Adds project reviewer guidance.",
    reason: "Repeated model-review friction.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-project-overlay",
      path: PROJECT_OVERLAY_PATH,
      projectKey: PROJECT_KEY,
      projectRoot: PROJECT_ROOT,
    },
    change: {
      kind: "reviewer-config",
      pointer: "/promptAppends/-",
      op: "append-string",
      before: [],
      after: "Prefer structural local test workflow review.",
      rendered: "append prompt guidance",
    },
    evidence: evidence(),
    examples: [],
    fixtureSuggestions: [],
    validation,
    trustNotes: [],
    warnings: [],
  };
}

function packageProposal(plan: PackEnablementPlan): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: plan.id,
    kind: "package-pack-enablement",
    title: "Enable package pack",
    summary: "Enables a package-contributed pack.",
    reason: "Package pack reduces repeated review load.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance:
      plan.request.scope === "global" ? "user-global" : "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "package-pack-config",
      path: plan.targetPath,
      packId: plan.request.packId,
    },
    change: {
      kind: "package-pack-enablement",
      packId: plan.request.packId,
      enable: plan.request.action === "enable",
      metadataWarnings: [],
      plan,
    },
    evidence: evidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: check("pass", "schema-ok"),
      packageAvailability: check("pass", "package-available"),
      replay: check("pass", "replay-ok"),
      trust: check("pending", "warning-ack-required"),
    },
    trustNotes: [],
    warnings: [],
  };
}

function packEnablementPlan(): PackEnablementPlan {
  return {
    id: "pack-enable:test-demo",
    request: {
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:demo",
    },
    targetPath: GLOBAL_CONFIG_PATH,
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
    warnings: [
      {
        code: "metadata-danger-0",
        level: "danger",
        message: "package warning",
        source: "metadata",
        requiresAcknowledgement: true,
      },
    ],
    requiredAcknowledgementCodes: ["metadata-danger-0"],
  };
}

describe("proposal approval gate", () => {
  it("routes reject, revise, and aborted decisions to no-write", () => {
    for (const decision of ["reject", "revise", "aborted"] as const) {
      expect(
        evaluateProposalApprovalGate({
          proposal: dataPackProposal({
            validation: writablePolicyValidation({
              replay: check("fail", "replay-regression"),
            }),
          }),
          decision,
        }),
      ).toMatchObject({ ok: true, route: "no-write" });
    }
  });

  it("routes accepted design-input-only proposals away from writers", () => {
    const proposal = dataPackProposal({
      applicationMode: "design-input-only",
      intendedProvenance: "shipped",
      target: { kind: "design-input", route: "shipped-pack" },
      rawPackPatch: [],
    });

    expect(isDesignInputOnlyProposal(proposal)).toBe(true);
    expect(
      evaluateProposalApprovalGate({ proposal, decision: "accept" }),
    ).toMatchObject({ ok: true, route: "design-input-only" });
  });

  it("accepts writable reviewer config proposals while leaving writer-owned checks pending", () => {
    expect(
      evaluateProposalApprovalGate({
        proposal: reviewerProposal(),
        decision: "accept",
      }),
    ).toMatchObject({ ok: true, route: "writable" });
  });

  it("blocks accepted writable proposals with failed validation checks", () => {
    const result = evaluateProposalApprovalGate({
      proposal: dataPackProposal({
        validation: writablePolicyValidation({
          replay: check("fail", "replay-regression"),
        }),
      }),
      decision: "accept",
    });

    expect(result).toMatchObject({ ok: false, route: "no-write" });
    expect(result.ok ? [] : result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "replay", status: "fail" }),
      ]),
    );
  });

  it("blocks accepted writable proposals with provenance mismatches", () => {
    const result = evaluateProposalApprovalGate({
      proposal: dataPackProposal({ intendedProvenance: "user-project" }),
      decision: "accept",
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "proposal-intended-provenance-mismatch",
        }),
      ]),
    );
  });

  it("requires allow-rule matcher, floor, replay, and adversarial safety before writing", () => {
    const result = evaluateProposalApprovalGate({
      proposal: dataPackProposal({
        validation: writablePolicyValidation({
          adversarial: check("pending", "adversarial-not-run"),
        }),
      }),
      decision: "accept",
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "adversarial", status: "pending" }),
      ]),
    );
  });

  it("returns required trust-note acknowledgement codes for accepted generic config proposals", () => {
    expect(
      evaluateProposalApprovalGate({
        proposal: {
          ...dataPackProposal(),
          trustNotes: [
            {
              kind: "acknowledgment-required",
              message: "This warning was shown on the proposal card.",
              severity: "warning",
            },
          ],
        },
        decision: "accept",
      }),
    ).toMatchObject({
      ok: true,
      route: "writable",
      requiredAcknowledgementCodes: [
        "ratchet-trust-note-acknowledgment-required-0",
      ],
    });
  });

  it("returns required package-enable acknowledgement codes for accepted package proposals", () => {
    expect(
      evaluateProposalApprovalGate({
        proposal: packageProposal(packEnablementPlan()),
        decision: "accept",
      }),
    ).toMatchObject({
      ok: true,
      route: "writable",
      requiredAcknowledgementCodes: ["metadata-danger-0"],
    });
  });

  it("blocks package-pack writes while package evidence is pending", () => {
    const result = evaluateProposalApprovalGate({
      proposal: {
        ...packageProposal(packEnablementPlan()),
        validation: {
          schema: check("pass", "schema-ok"),
          packageAvailability: check("pending", "package-registry-unavailable"),
          replay: check("pending", "replay-delta-not-run-pending"),
        },
      },
      decision: "accept",
    });

    expect(result).toMatchObject({ ok: false, route: "no-write" });
    expect(result.ok ? [] : result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "packageAvailability",
          status: "pending",
        }),
        expect.objectContaining({ check: "replay", status: "pending" }),
      ]),
    );
  });

  it("re-validates the structured proposal transport before approval", () => {
    const malformed = {
      ...dataPackProposal(),
      title: "",
    } as StructuredRatchetProposal;

    const result = evaluateProposalApprovalGate({
      proposal: malformed,
      decision: "accept",
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "proposal-schema-invalid-0" }),
      ]),
    );
  });

  it("rejects non-JSON proposal payloads hidden under unknown fields", () => {
    const proposal = dataPackProposal();
    if (proposal.change.kind !== "policy-pack") {
      throw new Error("expected policy-pack proposal");
    }
    const malformed: StructuredRatchetProposal = {
      ...proposal,
      change: {
        ...proposal.change,
        match: new Map([["program", "git"]]),
      },
    };

    const result = evaluateProposalApprovalGate({
      proposal: malformed,
      decision: "accept",
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "proposal-json-incompatible-0" }),
      ]),
    );
  });
});
