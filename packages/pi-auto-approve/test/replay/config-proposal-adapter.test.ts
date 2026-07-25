import { describe, expect, it } from "vitest";
import type { ResolvedReviewerConfig } from "../../src/config/loader.ts";
import type { PackEnablementPlan } from "../../src/packs/enablement.ts";
import type { PackRegistryEntry } from "../../src/packs/registry.ts";
import {
  ConfigProposalAdapterError,
  packagePackEnablementToStructuredProposal,
  projectScopeChangeToStructuredProposal,
  proposeStructuredReviewerConfig,
  reviewerConfigProposalToStructuredProposal,
} from "../../src/replay/config-proposal-adapter.ts";
import type { ProposalEvidence } from "../../src/replay/proposal-schema.ts";
import {
  isWritableProposal,
  proposalJsonRoundTrip,
  validateStructuredProposal,
} from "../../src/replay/proposal-schema.ts";
import type {
  CapturedOutcomeLabel,
  FrictionFamily,
  OutcomeTally,
  PerCommandRow,
  RatchetReport,
  ReplaySummary,
} from "../../src/replay/ratchet.ts";
import type {
  ReviewerConfigProposal,
  ReviewerProposalEvidence,
} from "../../src/replay/reviewer-config-proposals.ts";

const CREATED_AT = "2026-06-26T00:00:00.000Z";
const PROJECT_ROOT = "/home/nathan/dev/pi-auto-approve";
const PROJECT_OVERLAY_PATH =
  "/home/nathan/.config/pi/pi-auto-approve/projects/pi-auto-approve-abc12345/overlay.json";
const GLOBAL_CONFIG_PATH =
  "/home/nathan/.config/pi/pi-auto-approve/global.json";
const PROJECT_KEY = "pi-auto-approve-abc12345";

const ADAPTER_OPTIONS = {
  createdAt: CREATED_AT,
  globalConfigPath: GLOBAL_CONFIG_PATH,
  projectOverlayPath: PROJECT_OVERLAY_PATH,
  projectKey: PROJECT_KEY,
  projectRoot: PROJECT_ROOT,
};

const baseReviewer: ResolvedReviewerConfig = {
  promptPosture: "reviewer.strict",
  promptAppends: [],
  projectPromptAppends: [],
  promptOverride: null,
  model: null,
  tokenBudget: { window: "24h", limit: null },
  contextMode: "minimal",
  recentContext: {
    decisionLimit: 25,
    decisionWindow: "2h",
    conversationTurns: 3,
    conversationCharLimit: 6000,
  },
  escalation: { enabled: true, denialLimit: 3, window: "10m" },
};

function reviewerEvidence(
  overrides: Partial<ReviewerProposalEvidence> = {},
): ReviewerProposalEvidence {
  return {
    scope: "family",
    executable: "pnpm",
    calls: 8,
    unique: 2,
    reviewCalls: 8,
    hardBlockCalls: 0,
    modelReviewCalls: 8,
    capturedDenialCalls: 0,
    behaviors: ["local test workflow"],
    sampleCommands: ["pnpm test"],
    capturedOutcomeBreakdown: new Map<CapturedOutcomeLabel, number>([
      ["model-review", 8],
    ]),
    ...overrides,
  };
}

function reviewerProposal(
  overrides: Partial<ReviewerConfigProposal> = {},
): ReviewerConfigProposal {
  return {
    id: "revprop:project-append:pnpm",
    kind: "project-append",
    target: "user-project",
    diff: {
      target: "user-project",
      pointer: "/promptAppends/-",
      op: "append-string",
      before: [],
      after:
        "Treat `pnpm test` as a known local workflow when this project is explicitly trusted.",
      rendered:
        '/promptAppends/- append "Treat `pnpm test` as a known local workflow when this project is explicitly trusted."',
    },
    reason: "Repeated pnpm test calls route through model review.",
    evidence: reviewerEvidence(),
    examples: [
      {
        command: "pnpm test",
        capturedOutcome: "model-review",
        note: "representative reviewed command",
      },
    ],
    validation: { schemaOk: true, schemaErrors: [] },
    provenance: { source: "generated" },
    approvalFraming: {
      changesReviewPath: true,
      requiresAcknowledgment: true,
      consentRequired: true,
      summary: "project prompt append requires explicit approval",
    },
    modelDrafted: false,
    warnings: [],
    ...overrides,
  };
}

describe("config-proposal-adapter — reviewer config", () => {
  it("maps reviewer proposals to exact structured config diffs and writable targets", () => {
    const structured = reviewerConfigProposalToStructuredProposal(
      reviewerProposal(),
      ADAPTER_OPTIONS,
    );

    expect(validateStructuredProposal(structured)).toMatchObject({ ok: true });
    expect(isWritableProposal(structured)).toBe(true);
    expect(structured).toMatchObject({
      kind: "reviewer-config",
      applicationMode: "writable-after-approval",
      intendedProvenance: "user-project",
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
      },
      validation: {
        configSchema: { status: "pass", code: "config-schema-ok" },
        promptOverride: { status: "skipped" },
        trust: { status: "pending", code: "reviewer-config-ack-required" },
      },
    });
    expect(structured.change).toMatchObject({
      before: [],
      after:
        "Treat `pnpm test` as a known local workflow when this project is explicitly trusted.",
      rendered:
        '/promptAppends/- append "Treat `pnpm test` as a known local workflow when this project is explicitly trusted."',
    });
    expect(structured.examples).toEqual([
      {
        command: "pnpm test",
        matches: true,
        capturedOutcome: "model-review",
        note: "representative reviewed command",
      },
    ]);
    expect(structured.trustNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "reviewer-config-change" }),
        expect.objectContaining({ kind: "project-prompt-append" }),
        expect.objectContaining({ kind: "consent-required" }),
      ]),
    );
    expect(structured.warnings).toEqual(
      expect.arrayContaining([
        "changes model-review behavior",
        "requires explicit approval before writing reviewer config",
      ]),
    );
    expect(proposalJsonRoundTrip(structured)).toEqual(structured);
  });

  it("preserves prompt override validation evidence", () => {
    const structured = reviewerConfigProposalToStructuredProposal(
      reviewerProposal({
        id: "revprop:override-set",
        kind: "override-set",
        target: "user-global",
        diff: {
          target: "user-global",
          pointer: "/reviewer/promptOverride",
          op: "set",
          before: null,
          after: "Return JSON with decision and reason fields.",
          rendered: "/reviewer/promptOverride set prompt override",
        },
        validation: {
          schemaOk: true,
          schemaErrors: [],
          overrideValid: true,
          overrideReason: "prompt override satisfies response contract",
        },
      }),
      ADAPTER_OPTIONS,
    );

    expect(structured.target).toEqual({
      kind: "user-global-config",
      path: GLOBAL_CONFIG_PATH,
    });
    expect(structured.validation.promptOverride).toMatchObject({
      status: "pass",
      code: "prompt-override-ok",
      message: "prompt override satisfies response contract",
    });
    expect(structured.trustNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "prompt-override" }),
      ]),
    );
  });

  it("adds structured reviewer output as an additive generator bridge", async () => {
    const structured = await proposeStructuredReviewerConfig(
      {
        report: report({
          topContentiousFamilies: [family()],
        }),
        currentReviewer: baseReviewer,
        trustedProject: true,
      },
      { ...ADAPTER_OPTIONS, maxProposals: 1 },
    );

    expect(structured).toHaveLength(1);
    const proposal = mustGet(structured, 0);
    expect(proposal).toMatchObject({ kind: "reviewer-config" });
    expect(validateStructuredProposal(proposal)).toMatchObject({ ok: true });
    expect(proposalJsonRoundTrip(proposal)).toEqual(proposal);
  });
});

describe("config-proposal-adapter — project scope", () => {
  it("emits schema-valid project-scope config proposals against the project overlay", () => {
    const structured = projectScopeChangeToStructuredProposal({
      id: "scope:project-root",
      createdAt: CREATED_AT,
      projectRoot: PROJECT_ROOT,
      projectKey: PROJECT_KEY,
      projectOverlayPath: PROJECT_OVERLAY_PATH,
      reason: "Teach path facts about the project root.",
      patch: [
        {
          op: "replace",
          path: "/projectScope/roots",
          before: [],
          value: [PROJECT_ROOT],
        },
        {
          op: "replace",
          path: "/projectScope/unknownPathBehavior",
          before: "review",
          value: "deny",
        },
      ],
      evidence: proposalEvidence(),
    });

    expect(validateStructuredProposal(structured)).toMatchObject({ ok: true });
    expect(structured).toMatchObject({
      kind: "project-scope-config",
      intendedProvenance: "user-project",
      target: {
        kind: "user-project-overlay",
        path: PROJECT_OVERLAY_PATH,
        projectKey: PROJECT_KEY,
        projectRoot: PROJECT_ROOT,
      },
      change: { kind: "project-scope-config" },
      validation: {
        configSchema: {
          status: "pass",
          code: "project-overlay-schema-ok",
        },
        trust: { status: "pending" },
      },
    });
    expect(structured.trustNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "path-scope-boundary" }),
      ]),
    );
    expect(proposalJsonRoundTrip(structured)).toEqual(structured);
  });

  it("accepts project-scope array append patches when the appended value validates", () => {
    const structured = projectScopeChangeToStructuredProposal({
      id: "scope:append-writable-dir",
      createdAt: CREATED_AT,
      projectRoot: PROJECT_ROOT,
      reason: "Teach path facts about a writable source directory.",
      patch: [
        {
          op: "add",
          path: "/projectScope/writableDirectories/-",
          value: "./src",
        },
      ],
    });

    expect(validateStructuredProposal(structured)).toMatchObject({ ok: true });
    expect(structured.change).toMatchObject({
      kind: "project-scope-config",
      patch: [
        {
          op: "add",
          path: "/projectScope/writableDirectories/-",
          value: "./src",
        },
      ],
    });
  });

  it("refuses invalid values appended through project-scope array patches", () => {
    expect(() =>
      projectScopeChangeToStructuredProposal({
        id: "scope:bad-array-append",
        createdAt: CREATED_AT,
        projectRoot: PROJECT_ROOT,
        reason: "Bad proposal should fail.",
        patch: [
          {
            op: "add",
            path: "/projectScope/writableDirectories/-",
            value: "",
          },
        ],
      }),
    ).toThrow(ConfigProposalAdapterError);
  });

  it("preserves JSON Pointer empty path segments instead of collapsing them", () => {
    const structured = projectScopeChangeToStructuredProposal({
      id: "scope:empty-pointer-segment",
      createdAt: CREATED_AT,
      projectRoot: PROJECT_ROOT,
      reason:
        "Exercise JSON Pointer empty-key semantics without changing final config.",
      patch: [
        {
          op: "add",
          path: "/projectScope//-",
          value: "temporary",
        },
        {
          op: "remove",
          path: "/projectScope/",
        },
      ],
    });

    expect(validateStructuredProposal(structured)).toMatchObject({ ok: true });
    expect(structured.change).toMatchObject({
      kind: "project-scope-config",
      patch: [
        { op: "add", path: "/projectScope//-" },
        { op: "remove", path: "/projectScope/" },
      ],
    });
  });

  it("refuses unknownPathBehavior allow rather than representing unsafe scope config", () => {
    expect(() =>
      projectScopeChangeToStructuredProposal({
        id: "scope:bad-unknown-allow",
        createdAt: CREATED_AT,
        projectRoot: PROJECT_ROOT,
        reason: "Bad proposal should fail.",
        patch: [
          {
            op: "replace",
            path: "/projectScope/unknownPathBehavior",
            before: "review",
            value: "allow",
          },
        ],
      }),
    ).toThrow(ConfigProposalAdapterError);
  });

  it("refuses unknownPathBehavior allow nested inside a project-scope object patch", () => {
    expect(() =>
      projectScopeChangeToStructuredProposal({
        id: "scope:bad-unknown-allow-object",
        createdAt: CREATED_AT,
        projectRoot: PROJECT_ROOT,
        reason: "Bad proposal should fail.",
        patch: [
          {
            op: "replace",
            path: "/projectScope",
            value: { unknownPathBehavior: "allow" },
          },
        ],
      }),
    ).toThrow(ConfigProposalAdapterError);
  });
});

describe("config-proposal-adapter — package pack enablement", () => {
  it("enriches package enablement proposals with registry metadata and availability", () => {
    const plan = packEnablementPlan({
      action: "enable",
      scope: "global",
      packId: "pack:demo",
      targetPath: GLOBAL_CONFIG_PATH,
      requiredAcknowledgementCodes: ["metadata-danger-0"],
      warnings: [
        {
          code: "metadata-danger-0",
          level: "danger",
          message: "package pack can mutate dependencies",
          source: "metadata",
          requiresAcknowledgement: true,
        },
      ],
    });
    const structured = packagePackEnablementToStructuredProposal({
      plan,
      createdAt: CREATED_AT,
      evidence: proposalEvidence(),
      registryEntry: registryEntry({ enabled: false }),
    });

    expect(validateStructuredProposal(structured)).toMatchObject({ ok: true });
    expect(structured).toMatchObject({
      kind: "package-pack-enablement",
      applicationMode: "writable-after-approval",
      target: {
        kind: "package-pack-config",
        path: GLOBAL_CONFIG_PATH,
        packId: "pack:demo",
        packageName: "@demo/pi-pack",
        packageVersion: "1.2.3",
      },
      change: {
        kind: "package-pack-enablement",
        packId: "pack:demo",
        enable: true,
        packageName: "@demo/pi-pack",
        packageVersion: "1.2.3",
        packagePath: "/packages/demo",
        metadataWarnings: ["metadata warning from registry"],
      },
      validation: {
        packageAvailability: {
          status: "pass",
          code: "package-pack-available-disabled",
        },
      },
    });
    expect(structured.summary).toContain("available but disabled");
    expect(structured.trustNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "package-metadata-warning" }),
        expect.objectContaining({ kind: "package-available-not-enabled" }),
      ]),
    );
    expect(structured.warnings).toEqual(
      expect.arrayContaining([
        "package pack pack:demo is available but not enabled",
        "[warning][metadata] metadata warning from registry",
      ]),
    );
    expect(proposalJsonRoundTrip(structured)).toEqual(structured);
  });

  it("distinguishes already-enabled package packs without enabling during generation", () => {
    const structured = packagePackEnablementToStructuredProposal({
      plan: packEnablementPlan({
        action: "enable",
        scope: "project",
        packId: "pack:demo",
        targetPath: PROJECT_OVERLAY_PATH,
        requiredAcknowledgementCodes: [],
        warnings: [],
      }),
      createdAt: CREATED_AT,
      evidence: proposalEvidence(),
      registryEntry: registryEntry({ enabled: true }),
    });

    expect(structured.title).toContain("already enabled");
    expect(structured.validation.packageAvailability).toMatchObject({
      status: "pass",
      code: "package-pack-already-enabled",
      details: { enabled: true },
    });
    expect(
      structured.change.kind === "package-pack-enablement"
        ? structured.change.plan.after.packEnablement.enabledPackagePacks
        : [],
    ).toEqual(["pack:demo"]);
  });
});

function mustGet<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected item at index ${index}`);
  }
  return item;
}

function proposalEvidence(): ProposalEvidence {
  return {
    familyIds: ["family-demo"],
    recordIds: ["record-1"],
    calls: 5,
    uniqueCommands: 2,
    reviewCalls: 3,
    hardBlockCalls: 0,
    modelReviewCalls: 1,
    capturedDenialCalls: 0,
    replayStatusCounts: [{ label: "review", calls: 3 }],
    capturedOutcomeCounts: [{ label: "model-review", calls: 1 }],
    sampleCommands: ["demo-tool --help"],
  };
}

function packEnablementPlan(input: {
  readonly action: "enable" | "disable";
  readonly subject?: "package" | "config-pack";
  readonly scope: "global" | "project";
  readonly packId: string;
  readonly targetPath: string;
  readonly requiredAcknowledgementCodes: readonly string[];
  readonly warnings: PackEnablementPlan["warnings"];
}): PackEnablementPlan {
  return {
    id: `pack-enable:test-${input.action}-${input.packId}`,
    request: {
      action: input.action,
      scope: input.scope,
      subject: input.subject ?? "package",
      packId: input.packId,
    },
    targetPath: input.targetPath,
    patch: [
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: input.action === "enable" ? [] : [input.packId],
        value: input.action === "enable" ? [input.packId] : [],
      },
    ],
    before: {
      scope: input.scope,
      packEnablement: {
        enabledPackagePacks: input.action === "enable" ? [] : [input.packId],
        disabledPackagePacks: [],
        disabledConfigPacks: [],
      },
      packs: [],
    },
    after: {
      scope: input.scope,
      packEnablement: {
        enabledPackagePacks: input.action === "enable" ? [input.packId] : [],
        disabledPackagePacks: input.action === "enable" ? [] : [input.packId],
        disabledConfigPacks: [],
      },
      packs: [],
    },
    warnings: input.warnings,
    requiredAcknowledgementCodes: input.requiredAcknowledgementCodes,
  };
}

function registryEntry(input: {
  readonly enabled: boolean;
}): PackRegistryEntry {
  return {
    id: "pack:demo",
    pack: {
      version: 1,
      id: "pack:demo",
      metadata: {
        title: "Demo package pack",
        description: "demo package pack",
        warnings: [
          { level: "warning", message: "metadata warning from registry" },
        ],
      },
      rules: [],
    },
    metadata: {
      title: "Demo package pack",
      description: "demo package pack",
      docs: [],
      tags: ["demo"],
      warnings: [
        { level: "warning", message: "metadata warning from registry" },
      ],
      examples: [],
    },
    metadataCompleteness: {
      hasTitle: true,
      hasDescription: true,
      hasDocs: false,
      hasTags: true,
      hasExamples: false,
      missingFields: ["docs", "examples"],
    },
    source: {
      kind: "package",
      packageName: "@demo/pi-pack",
      packageVersion: "1.2.3",
      packagePath: "/packages/demo",
    },
    inBaseline: false,
    availability: {
      available: true,
      enabled: input.enabled,
      enabledBy: input.enabled ? [{ kind: "global-config" }] : [],
    },
  };
}

function tally(calls = 0, unique = calls): OutcomeTally {
  return { calls, unique };
}

function outcomeMap(
  entries: readonly (readonly [CapturedOutcomeLabel, OutcomeTally])[] = [],
): ReadonlyMap<CapturedOutcomeLabel, OutcomeTally> {
  return new Map(entries);
}

function summary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    totalCalls: 12,
    totalUnique: 3,
    fastPathCalls: 0,
    fastPathUnique: 0,
    reviewCalls: 12,
    reviewUnique: 3,
    hardBlockCalls: 0,
    hardBlockUnique: 0,
    byCapturedOutcome: outcomeMap([["model-review", tally(12, 3)]]),
    modelReviewLoad: tally(12, 3),
    redactedCalls: 0,
    ...overrides,
  };
}

function family(overrides: Partial<FrictionFamily> = {}): FrictionFamily {
  const executable = overrides.executable ?? "pnpm";
  return {
    executable,
    calls: 8,
    unique: 2,
    reviewCalls: 8,
    hardBlockCalls: 0,
    modelReviewCalls: 8,
    capturedDenialCalls: 0,
    sampleCommands: [`${executable} test`],
    ...overrides,
  };
}

function row(overrides: Partial<PerCommandRow> = {}): PerCommandRow {
  const command = overrides.command ?? "pnpm test";
  return {
    command,
    count: 4,
    toolName: "bash",
    executable: "pnpm",
    status: "review",
    reason: "model review needed",
    capturedOutcomes: new Map<CapturedOutcomeLabel, number>([
      ["model-review", 4],
    ]),
    fidelity: "high",
    sources: ["session"],
    ...overrides,
  };
}

function report(overrides: Partial<RatchetReport> = {}): RatchetReport {
  const topContentiousFamilies = overrides.topContentiousFamilies ?? [family()];
  return {
    generatedAt: "2026-06-25T12:00:00.000Z",
    corpus: {
      totalCalls: 12,
      totalUnique: 3,
      sources: new Map([
        ["session", 12],
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
    topContentiousFamilies,
    topUnknownTools: [],
    perCommand: topContentiousFamilies.map((entry) =>
      row({
        command: entry.sampleCommands[0] ?? `${entry.executable} test`,
        executable: entry.executable,
        count: entry.calls,
      }),
    ),
    ...overrides,
  };
}
