import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  type AuditLogger,
  createArrayAuditSink,
  createAuditLogger,
} from "../../src/audit/log.ts";
import type { ResolvedConfig } from "../../src/config/loader.ts";
import type { ConfigPaths } from "../../src/config/paths.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
  ProjectOverlaySchema,
} from "../../src/config/schema.ts";
import type { ComposerResult } from "../../src/policy/composer.ts";
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
import { REVIEWER_BASE_CONTRACT } from "../../src/runtime/reviewer-prompts.ts";
import {
  type PlanWritePorts,
  planReviewerConfigWrite,
  planRuleWrite,
  RATCHET_GENERATED_PACK_ID,
} from "../../src/skill/clearance-tune/apply-writer.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../fixtures/resolved-config.ts";

const MATCH = {
  all: [
    { program: "git" },
    { arg0In: ["status"] },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
} as const;

const TRUSTED_PROJECT = {
  trusted: true,
} as const;

const PATHS: ConfigPaths = {
  userConfigRoot: "/user-config/pi-clearance",
  globalConfigFile: "/user-config/pi-clearance/global.json",
  projectDir: "/user-config/pi-clearance/projects/repo-12345678",
  projectOverlayFile:
    "/user-config/pi-clearance/projects/repo-12345678/overlay.json",
  repoPolicyFile: "/repo/.pi-clearance/policy.json",
  projectKey: "repo-12345678",
};

function resolvedConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    version: 1,
    cwd: "/repo",
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    display: defaultResolvedDisplay(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: TRUSTED_PROJECT,
    reviewer: defaultResolvedReviewer(),
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function ruleProposal(
  overrides: Partial<RuleProposal> & {
    readonly kind?: ProposalKind;
    readonly target?: ProposalTarget;
  } = {},
): RuleProposal {
  const kind = overrides.kind ?? "data";
  const target = overrides.target ?? "user-global";

  return {
    id: `prop:${kind}:${target}:allow-git-status`,
    kind,
    target,
    effect: "allow",
    ruleId: "allow-git-status",
    match: MATCH,
    reason: "Allow repeated git status inspection.",
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
      capturedDenialCalls: 0,
      behaviors: ["vcs-read"],
      sampleCommands: ["git status --short"],
      capturedOutcomeBreakdown: new Map(),
    },
    examples: [{ command: "git status --short", matches: true }],
    fixtureSuggestions: [],
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
      summary: "data-only overlay proposal",
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
  const kind = overrides.kind ?? "global-append";
  const target = overrides.target ?? "user-global";
  const pointer =
    target === "user-global" ? "/reviewer/promptAppends/-" : "/promptAppends/-";
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
      pointer,
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
    examples: [{ command: "just --list" }],
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

function composerOk(): ComposerResult {
  return { ok: true, effectivePolicy: {}, warnings: [] };
}

function ports(
  compose: PlanWritePorts["compose"] = async () => composerOk(),
): PlanWritePorts {
  return {
    compose,
    silentAudit: createAuditLogger({ sink: createArrayAuditSink() }),
  };
}

function globalConfig(raw: Record<string, unknown> = {}) {
  return { version: 1, ...raw };
}

function overlayConfig(raw: Record<string, unknown> = {}) {
  return { version: 1, ...raw };
}

describe("ratchet apply write planner", () => {
  it("merges data rule plans into ratchet.generated with replace and append semantics", async () => {
    const existingRule = {
      id: "allow-git-status",
      effect: "review",
      match: { program: "git" },
      reason: "old reason",
      provenance: { source: "user-global" },
    };
    const otherRule = {
      id: "allow-git-log",
      effect: "allow",
      match: { all: [{ program: "git" }, { arg0In: ["log"] }] },
      reason: "allow log",
      provenance: { source: "user-global" },
    };
    const currentRaw = globalConfig({
      packs: [
        { version: 1, id: "custom.pack", rules: [] },
        {
          version: 1,
          id: RATCHET_GENERATED_PACK_ID,
          rules: [existingRule, otherRule],
        },
      ],
    });

    const replace = await planRuleWrite(
      ruleProposal(),
      resolvedConfig(),
      currentRaw,
      PATHS,
      ports(),
    );
    expect(replace.ok).toBe(true);
    if (!replace.ok) {
      throw new Error("expected replace plan");
    }

    const replacedConfig = normalizeConfig(
      GlobalConfigSchema,
      replace.plan.mergedJson,
    );
    expect(replacedConfig.ok).toBe(true);
    if (!replacedConfig.ok) {
      throw new Error("expected normalized replacement config");
    }
    const replacedPack = replacedConfig.value.packs.find(
      (pack) => pack.id === RATCHET_GENERATED_PACK_ID,
    );
    expect(replacedPack?.rules.map((rule) => rule.id)).toEqual([
      "allow-git-status",
      "allow-git-log",
    ]);
    expect(replacedPack?.rules[0]).toEqual({
      id: "allow-git-status",
      effect: "allow",
      match: MATCH,
      reason: "Allow repeated git status inspection.",
      provenance: { source: "user-global" },
    });

    const append = await planRuleWrite(
      ruleProposal({ ruleId: "allow-git-diff" }),
      resolvedConfig(),
      currentRaw,
      PATHS,
      ports(),
    );
    expect(append.ok).toBe(true);
    if (!append.ok) {
      throw new Error("expected append plan");
    }
    const appendedConfig = normalizeConfig(
      GlobalConfigSchema,
      append.plan.mergedJson,
    );
    expect(appendedConfig.ok).toBe(true);
    if (!appendedConfig.ok) {
      throw new Error("expected normalized append config");
    }
    expect(
      appendedConfig.value.packs
        .find((pack) => pack.id === RATCHET_GENERATED_PACK_ID)
        ?.rules.map((rule) => rule.id),
    ).toEqual(["allow-git-status", "allow-git-log", "allow-git-diff"]);
    expect(append.plan.target).toEqual({
      kind: "global-config",
      path: PATHS.globalConfigFile,
      backupPath: `${PATHS.globalConfigFile}.bak`,
    });
  });

  it("returns schema errors and no plan when the merged target config is invalid", async () => {
    const result = await planRuleWrite(
      ruleProposal(),
      resolvedConfig(),
      globalConfig({ mystery: true }),
      PATHS,
      ports(),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "schema" } });
    if (!result.ok && result.error.kind === "schema") {
      expect(result.error.errors.join("\n")).toContain("$.mystery");
    }
  });

  it("rejects floor-overlapping rule writes through the injected silent compose pass", async () => {
    let receivedAudit: AuditLogger | undefined;
    const sink = createArrayAuditSink();
    const silentAudit = createAuditLogger({ sink });
    const compose = vi.fn(
      async (_config: ResolvedConfig, audit: AuditLogger) => {
        receivedAudit = audit;
        return {
          ok: false,
          effectivePolicy: {},
          reason: "sealed floor overlap",
          errors: ["allow-git-status overlaps floor.deny"],
        } satisfies ComposerResult;
      },
    );

    const result = await planRuleWrite(
      ruleProposal(),
      resolvedConfig(),
      globalConfig(),
      PATHS,
      { compose, silentAudit },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "floor-overlap",
        errors: ["allow-git-status overlaps floor.deny"],
      },
    });
    expect(receivedAudit).toBe(silentAudit);
    expect(sink.entries).toEqual([]);
  });

  it("rejects reviewer override plans whose write-time override text fails runtime validation", async () => {
    const proposal = reviewerProposal({
      kind: "override-set",
      diff: {
        target: "user-global",
        pointer: "/reviewer/promptOverride",
        op: "set",
        before: null,
        after: "Return yes or no.",
        rendered: 'reviewer.promptOverride: null → "Return yes or no."',
      },
    });

    const result = await planReviewerConfigWrite(
      proposal,
      resolvedConfig(),
      globalConfig(),
      PATHS,
      ports(),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "override-invalid",
        reason: "missing required JSON response schema literal",
      },
    });
  });

  it("reconstructs reviewer mergedJson against the current resolved reviewer at write time", async () => {
    const current = resolvedConfig({
      reviewer: {
        ...defaultResolvedReviewer(),
        promptAppends: ["Already current."],
      },
    });
    const proposal = reviewerProposal({
      diff: {
        target: "user-global",
        pointer: "/reviewer/promptAppends/-",
        op: "append-string",
        before: 0,
        after: "New write-time append.",
        rendered: 'reviewer.promptAppends[0]: + "New write-time append."',
      },
    });

    const result = await planReviewerConfigWrite(
      proposal,
      current,
      globalConfig({
        mode: "ask",
        reviewer: {
          promptPosture: "reviewer.default",
          promptAppends: ["Stale raw value."],
          projectPromptAppends: [],
          promptOverride: null,
          model: null,
          tokenBudget: { window: "24h", limit: null },
        },
      }),
      PATHS,
      ports(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected reviewer plan");
    }
    const normalized = normalizeConfig(
      GlobalConfigSchema,
      result.plan.mergedJson,
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) {
      throw new Error("expected normalized reviewer config");
    }
    expect(normalized.value.reviewer.promptAppends).toEqual([
      "Already current.",
      "New write-time append.",
    ]);
  });

  it("plans project reviewer writes by preserving overlay fields and updating promptAppends", async () => {
    const result = await planReviewerConfigWrite(
      reviewerProposal({ target: "user-project" }),
      resolvedConfig(),
      overlayConfig({
        packs: [{ version: 1, id: "project.pack", rules: [] }],
        promptAppends: ["Stale raw value."],
      }),
      PATHS,
      ports(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected project reviewer plan");
    }
    const normalized = normalizeConfig(
      ProjectOverlaySchema,
      result.plan.mergedJson,
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) {
      throw new Error("expected normalized project overlay");
    }
    expect(normalized.value).toEqual({
      version: 1,
      packs: [{ version: 1, id: "project.pack", rules: [] }],
      packEnablement: {
        enabledPackagePacks: [],
        disabledPackagePacks: [],
        disabledConfigPacks: [],
      },
      projectScope: {
        roots: [],
        writableDirectories: [],
        tempDirectories: [],
        deniedDirectories: [],
        safeHomeDirectories: [],
        safeHomeUseDefaults: true,
        agentSupportDirectories: [],
        agentSupportUseDefaults: true,
        unknownPathBehavior: "review",
        sensitivePathBehavior: "review",
        homePathBehavior: "allow",
      },
      promptAppends: ["Prefer bounded local workflows."],
    });
    expect(result.plan.target).toEqual({
      kind: "project-overlay",
      path: PATHS.projectOverlayFile,
      backupPath: `${PATHS.projectOverlayFile}.bak`,
    });
  });

  it("accepts a valid reviewer override after schema and override validation", async () => {
    const overrideText = [
      REVIEWER_BASE_CONTRACT.text,
      "Return a JSON response schema object with decision and reason fields.",
    ].join("\n\n");
    const result = await planReviewerConfigWrite(
      reviewerProposal({
        kind: "override-set",
        diff: {
          target: "user-global",
          pointer: "/reviewer/promptOverride",
          op: "set",
          before: null,
          after: overrideText,
          rendered: "reviewer.promptOverride: null → <override>",
        },
      }),
      resolvedConfig(),
      globalConfig(),
      PATHS,
      ports(),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses routed design-input proposals as not writable", async () => {
    const result = await planRuleWrite(
      ruleProposal({ target: "shipped-pack", packId: "bash.dev.verify" }),
      resolvedConfig(),
      globalConfig(),
      PATHS,
      ports(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "not-writable" },
    });
  });

  it("keeps the write planner pure and free of filesystem imports", () => {
    const modulePath = fileURLToPath(
      new URL(
        "../../src/skill/clearance-tune/apply-writer.ts",
        import.meta.url,
      ),
    );
    const source = readFileSync(modulePath, "utf8");

    expect(source).not.toMatch(/from\s+["'](?:node:)?fs/u);
    expect(source).not.toMatch(/from\s+["'](?:node:)?child_process/u);
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("writeFile");
  });
});
