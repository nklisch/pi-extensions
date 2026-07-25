import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/loader.ts";
import type { ConfigPaths } from "../../src/config/paths.ts";
import type {
  GlobalConfig,
  ProjectOverlayConfig,
  RepositoryPolicyConfig,
} from "../../src/config/schema.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
  ProjectOverlaySchema,
  RepositoryPolicySchema,
} from "../../src/config/schema.ts";
import type { PackEnablementPlan } from "../../src/packs/enablement.ts";
import type {
  JsonPatchOperation,
  ProposalEvidence,
  ProposalValidation,
  ProposalValidationCheck,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import { PROPOSAL_SCHEMA_VERSION } from "../../src/replay/proposal-schema.ts";
import { materializeRatchetProposalWritePlan } from "../../src/replay/proposal-write-plan.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../fixtures/resolved-config.ts";

const CREATED_AT = "2026-06-27T00:00:00.000Z";
const CWD = "/home/nathan/dev/pi-clearance";
const GLOBAL_CONFIG_PATH =
  "/home/nathan/.config/pi/pi-clearance/global.json";
const PROJECT_OVERLAY_PATH =
  "/home/nathan/.config/pi/pi-clearance/projects/pi-clearance-abc12345/overlay.json";
const PROJECT_ROOT = CWD;
const PROJECT_KEY = "pi-clearance-abc12345";

function check(
  status: ProposalValidationCheck["status"],
  code = `${status}-check`,
): ProposalValidationCheck {
  return { status, code, message: `${code} message` };
}

function validation(
  overrides: Partial<ProposalValidation> = {},
): ProposalValidation {
  return {
    schema: check("pass", "schema-ok"),
    matcherCompile: check("pass", "matcher-ok"),
    floorOverlap: check("pass", "floor-ok"),
    replay: check("pass", "replay-ok"),
    adversarial: check("pass", "adversarial-ok"),
    configSchema: check("pending", "writer-validates-config"),
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
  input: {
    readonly targetPath?: string;
    readonly targetKind?: "global" | "project" | "design-input";
    readonly patch?: readonly JsonPatchOperation[];
  } = {},
): StructuredRatchetProposal {
  const targetKind = input.targetKind ?? "global";
  const target =
    targetKind === "global"
      ? ({
          kind: "user-global-config",
          path: input.targetPath ?? GLOBAL_CONFIG_PATH,
        } as const)
      : targetKind === "project"
        ? ({
            kind: "user-project-overlay",
            path: input.targetPath ?? PROJECT_OVERLAY_PATH,
            projectKey: PROJECT_KEY,
            projectRoot: PROJECT_ROOT,
          } as const)
        : ({ kind: "design-input", route: "shipped-pack" } as const);
  const rawPackPatch = input.patch ?? [
    {
      op: "add" as const,
      path: "/packs/-",
      value: {
        version: 1,
        id: "user-global-git",
        rules: [
          {
            id: "allow-git-status",
            effect: "allow",
            match: { all: [{ program: "git" }, { arg0In: ["status"] }] },
            reason: "read-only git status",
            provenance: {
              source: targetKind === "project" ? "user-project" : "user-global",
            },
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
    intendedProvenance:
      targetKind === "project" ? "user-project" : "user-global",
    applicationMode:
      targetKind === "design-input"
        ? "design-input-only"
        : "writable-after-approval",
    target,
    change: {
      kind: "policy-pack",
      packId: "user-global-git",
      ruleId: "allow-git-status",
      effect: "allow",
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
    examples: [],
    fixtureSuggestions: [],
    validation: validation(),
    trustNotes: [],
    warnings: [],
  };
}

function reviewerProposal(
  input: { readonly before?: readonly string[] } = {},
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
      before: input.before ?? [],
      after: "Prefer structural local test workflow review.",
      rendered: "append prompt guidance",
    },
    evidence: evidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: check("pass", "schema-ok"),
      configSchema: check("pending", "writer-validates-config"),
      promptOverride: check("pending", "writer-validates-prompt"),
      replay: check("pending", "reviewer-replay-not-deterministic"),
    },
    trustNotes: [],
    warnings: [],
  };
}

function projectScopeProposal(
  patch: readonly JsonPatchOperation[] = [
    {
      op: "add",
      path: "/projectScope/writableDirectories/-",
      value: "./src",
    },
  ],
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-scope-1",
    kind: "project-scope-config",
    title: "Add writable src scope",
    summary: "Adds ./src as a writable project directory.",
    reason: "Repeated project-local write review load.",
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
    change: { kind: "project-scope-config", patch },
    evidence: evidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: check("pass", "schema-ok"),
      configSchema: check("pass", "config-ok"),
      replay: check("pass", "replay-ok"),
      trust: check("pending", "approval-required"),
    },
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

function packEnablementPlan(
  input: {
    readonly scope?: "global" | "project";
    readonly targetPath?: string;
    readonly requiredAcknowledgementCodes?: readonly string[];
  } = {},
): PackEnablementPlan {
  const scope = input.scope ?? "global";
  const targetPath =
    input.targetPath ??
    (scope === "global" ? GLOBAL_CONFIG_PATH : PROJECT_OVERLAY_PATH);
  const requiredAcknowledgementCodes = input.requiredAcknowledgementCodes ?? [];
  return {
    id: "pack-enable:test-demo",
    request: {
      action: "enable",
      scope,
      subject: "package",
      packId: "pack:demo",
    },
    targetPath,
    patch: [
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: [],
        value: ["pack:demo"],
      },
    ],
    before: {
      scope,
      packEnablement: {
        enabledPackagePacks: [],
        disabledPackagePacks: [],
        disabledConfigPacks: [],
      },
      packs: [],
    },
    after: {
      scope,
      packEnablement: {
        enabledPackagePacks: ["pack:demo"],
        disabledPackagePacks: [],
        disabledConfigPacks: [],
      },
      packs: [],
    },
    warnings: requiredAcknowledgementCodes.map((code) => ({
      code,
      level: "danger" as const,
      message: `${code} warning`,
      source: "metadata" as const,
      requiresAcknowledgement: true,
    })),
    requiredAcknowledgementCodes,
  };
}

function resolvedConfig(
  input: {
    readonly sourceSnapshots?: false;
    readonly global?: GlobalConfig;
    readonly project?: ProjectOverlayConfig;
  } = {},
): ResolvedConfig {
  return {
    version: 1,
    cwd: CWD,
    ...(input.sourceSnapshots === false
      ? {}
      : {
          sourceSnapshots: {
            paths: configPaths(),
            global: input.global ?? normalizedGlobal({ version: 1 }),
            project: input.project ?? normalizedProject({ version: 1 }),
            repository: normalizedRepository({ version: 1 }),
          },
        }),
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    display: defaultResolvedDisplay(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted: false,
    },
    reviewer: defaultResolvedReviewer(),
    errors: [],
    warnings: [],
  };
}

function configPaths(): ConfigPaths {
  return {
    userConfigRoot: "/home/nathan/.config/pi/pi-clearance",
    globalConfigFile: GLOBAL_CONFIG_PATH,
    projectDir:
      "/home/nathan/.config/pi/pi-clearance/projects/pi-clearance-abc12345",
    projectOverlayFile: PROJECT_OVERLAY_PATH,
    repoPolicyFile: `${CWD}/.pi-clearance/policy.json`,
    projectKey: PROJECT_KEY,
  };
}

function normalizedGlobal(raw: unknown): GlobalConfig {
  const result = normalizeConfig(GlobalConfigSchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

function normalizedProject(raw: unknown): ProjectOverlayConfig {
  const result = normalizeConfig(ProjectOverlaySchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

function normalizedRepository(raw: unknown): RepositoryPolicyConfig {
  const result = normalizeConfig(RepositoryPolicySchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

describe("materializeRatchetProposalWritePlan", () => {
  it("materializes data-pack proposals into deterministic config-command plans", () => {
    const proposal = dataPackProposal();
    const result = materializeRatchetProposalWritePlan({
      proposal,
      resolvedConfig: resolvedConfig(),
      cwd: CWD,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.writePlan.kind).toBe("config-command");
    if (result.writePlan.kind !== "config-command") {
      throw new Error("expected config-command write plan");
    }
    expect(result.writePlan.plan.id).toMatch(/^ratchet-proposal:/u);
    expect(result.writePlan.plan.target).toEqual({
      kind: "global",
      path: GLOBAL_CONFIG_PATH,
    });
    expect(result.writePlan.plan.patch).toEqual(
      proposal.change.kind === "policy-pack"
        ? proposal.change.rawPackPatch
        : [],
    );
    expect(result.writePlan.plan.after.packs).toHaveLength(1);
    expect(result.writePlan.acknowledgement).toEqual({
      confirmedPlanId: result.writePlan.plan.id,
      acknowledgedWarningCodes: [],
    });
  });

  it("materializes reviewer append proposals from structured pointer fields", () => {
    const result = materializeRatchetProposalWritePlan({
      proposal: reviewerProposal(),
      resolvedConfig: resolvedConfig(),
      cwd: CWD,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.writePlan.kind !== "config-command") {
      throw new Error("expected config-command write plan");
    }
    expect(result.writePlan.plan.target).toEqual({
      kind: "project",
      path: PROJECT_OVERLAY_PATH,
    });
    expect(result.writePlan.plan.patch).toEqual([
      {
        op: "add",
        path: "/promptAppends/-",
        value: "Prefer structural local test workflow review.",
      },
    ]);
    expect(result.writePlan.plan.after).toMatchObject({
      promptAppends: ["Prefer structural local test workflow review."],
    });
  });

  it("materializes project-scope proposals through project overlay schema normalization", () => {
    const result = materializeRatchetProposalWritePlan({
      proposal: projectScopeProposal(),
      resolvedConfig: resolvedConfig(),
      cwd: CWD,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.writePlan.kind !== "config-command") {
      throw new Error("expected config-command write plan");
    }
    expect(result.writePlan.plan.target.kind).toBe("project");
    expect(result.writePlan.plan.after).toMatchObject({
      projectScope: { writableDirectories: ["./src"] },
    });
  });

  it("requires acknowledgement for warning and danger trust notes on generic config plans", () => {
    const result = materializeRatchetProposalWritePlan({
      proposal: {
        ...dataPackProposal(),
        trustNotes: [
          {
            kind: "acknowledgment-required",
            message: "This warning was shown on the proposal card.",
            severity: "warning",
          },
          {
            kind: "informational",
            message: "This note does not require acknowledgement.",
            severity: "info",
          },
        ],
      },
      resolvedConfig: resolvedConfig(),
      cwd: CWD,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.writePlan.kind !== "config-command") {
      throw new Error("expected config-command write plan");
    }
    expect(result.writePlan.plan.requiredAcknowledgementCodes).toEqual([
      "ratchet-trust-note-acknowledgment-required-0",
    ]);
    expect(result.writePlan.acknowledgement.acknowledgedWarningCodes).toEqual([
      "ratchet-trust-note-acknowledgment-required-0",
    ]);
  });

  it("refuses project-scope proposals whose writable directories escape project roots", () => {
    const result = materializeRatchetProposalWritePlan({
      proposal: projectScopeProposal([
        {
          op: "add",
          path: "/projectScope/writableDirectories/-",
          value: "../outside",
        },
      ]),
      resolvedConfig: resolvedConfig(),
      cwd: CWD,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "proposal project scope failed semantic validation",
    });
    if (result.ok) {
      throw new Error("expected project scope refusal");
    }
    expect(result.errors.join("\n")).toContain(
      "outside all configured project roots",
    );
  });

  it("reuses package-pack enablement plans and builds the acknowledgement contract", () => {
    const plan = packEnablementPlan({
      requiredAcknowledgementCodes: ["metadata-danger-0"],
    });
    const result = materializeRatchetProposalWritePlan({
      proposal: packageProposal(plan),
      resolvedConfig: resolvedConfig(),
      cwd: CWD,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.writePlan.kind !== "pack-enablement") {
      throw new Error("expected pack-enablement write plan");
    }
    expect(result.writePlan.plan).toEqual(plan);
    expect(result.writePlan.acknowledgement).toEqual({
      confirmedPlanId: plan.id,
      acknowledgedWarningCodes: ["metadata-danger-0"],
    });
  });

  it("refuses design-input proposals without writer plans", () => {
    expect(
      materializeRatchetProposalWritePlan({
        proposal: dataPackProposal({ targetKind: "design-input", patch: [] }),
        resolvedConfig: resolvedConfig(),
        cwd: CWD,
      }),
    ).toMatchObject({ ok: false, reason: "proposal is design-input-only" });
  });

  it("refuses absent source snapshots before reading or writing config", () => {
    expect(
      materializeRatchetProposalWritePlan({
        proposal: dataPackProposal(),
        resolvedConfig: resolvedConfig({ sourceSnapshots: false }),
        cwd: CWD,
      }),
    ).toMatchObject({
      ok: false,
      reason: "resolved config did not include source snapshots",
    });
  });

  it("refuses target path mismatches", () => {
    expect(
      materializeRatchetProposalWritePlan({
        proposal: dataPackProposal({ targetPath: "/tmp/evil.json" }),
        resolvedConfig: resolvedConfig(),
        cwd: CWD,
      }),
    ).toMatchObject({ ok: false, reason: "proposal target path mismatch" });
  });

  it("refuses malformed proposal patches without writes", () => {
    const result = materializeRatchetProposalWritePlan({
      proposal: dataPackProposal({
        patch: [
          {
            op: "add",
            path: "/packs/99/rules/-",
            value: { id: "broken" },
          },
        ],
      }),
      resolvedConfig: resolvedConfig(),
      cwd: CWD,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "proposal patch could not be applied",
    });
  });

  it("refuses stale reviewer pointer snapshots", () => {
    const result = materializeRatchetProposalWritePlan({
      proposal: reviewerProposal({ before: ["stale"] }),
      resolvedConfig: resolvedConfig(),
      cwd: CWD,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "reviewer append proposal is stale",
    });
  });
});
