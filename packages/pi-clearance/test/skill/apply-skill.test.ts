import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createAuditLogger } from "../../src/audit/logger.ts";
import { noopAuditSink } from "../../src/audit/sink.ts";
import { loadConfig } from "../../src/config/loader.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
} from "../../src/config/schema.ts";
import { composeEffectivePolicy } from "../../src/policy/composer.ts";
import type { ReplayCorpus } from "../../src/replay/history.ts";
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
import { runRatchetCli } from "../../src/skill/clearance-tune/cli.ts";

const CUSTOM_SAFE_COMMAND = "git custom-safe";
const OVERBROAD_COMMAND = "rm -rf /";

const CUSTOM_SAFE_MATCH = {
  all: [
    { program: "git" },
    { arg0In: ["custom-safe"] },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
} as const;

interface TestProject {
  readonly cwd: string;
  readonly runDir: string;
  readonly configHome: string;
  readonly userConfigRoot: string;
  readonly globalConfigFile: string;
  readonly env: NodeJS.ProcessEnv;
}

async function makeProject(name: string): Promise<TestProject> {
  const root = await mkdtemp(
    path.join(tmpdir(), `pi-auto-approve-skill-${name}-`),
  );
  const cwd = path.join(root, "repo");
  const configHome = path.join(root, "config-home");
  const userConfigRoot = path.join(configHome, "pi", "pi-auto-approve");
  const runDir = path.join(
    userConfigRoot,
    "ratchet",
    "2026-06-25T00-00-00-000Z",
  );
  const globalConfigFile = path.join(userConfigRoot, "global.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
  };

  await writeJson(path.join(cwd, ".keep"), { ok: true });
  await writeJson(globalConfigFile, { version: 1 });

  return { cwd, runDir, configHome, userConfigRoot, globalConfigFile, env };
}

async function loadProjectConfig(project: TestProject) {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = project.configHome;
  try {
    return await loadConfig({ cwd: project.cwd });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
}

function replayCorpus(command = CUSTOM_SAFE_COMMAND): ReplayCorpus {
  return {
    entries: [
      {
        command,
        toolName: "bash",
        source: "corpus",
        sources: ["corpus"],
        provenance: "apply-skill-test",
        expectedLabel: "review",
        fidelity: "high",
      },
    ],
    sourceSummary: new Map([["corpus", 1]]),
    unmatchedAuditEntries: 0,
    warnings: [],
  };
}

async function seedRun(
  project: TestProject,
  proposals: readonly (RuleProposal | ReviewerConfigProposal)[],
  corpus: ReplayCorpus = replayCorpus(),
): Promise<void> {
  await writeJson(path.join(project.runDir, "proposals.json"), proposals);
  await writeJson(path.join(project.runDir, "deferred.json"), []);
  await writeJson(path.join(project.runDir, "corpus.json"), corpus);
}

function ruleProposal(
  overrides: Partial<RuleProposal> & {
    readonly kind?: ProposalKind;
    readonly target?: ProposalTarget;
  } = {},
): RuleProposal {
  const kind = overrides.kind ?? "data";
  const target = overrides.target ?? "user-global";
  const ruleId = overrides.ruleId ?? "allow-git-custom-safe";

  return {
    id: `prop:${kind}:${target}:${ruleId}`,
    kind,
    target,
    effect: "allow",
    ruleId,
    ...(target === "shipped-pack" ? { packId: "bash.dev.verify" } : {}),
    match: CUSTOM_SAFE_MATCH,
    reason: "Allow repeated project-local git custom-safe command.",
    scope: target === "user-project" ? "project" : "global",
    provenance: { source: "generated" },
    intendedProvenance:
      target === "user-project" ? "user-project" : "user-global",
    evidence: {
      executable: "git",
      calls: 3,
      unique: 1,
      reviewCalls: 3,
      hardBlockCalls: 0,
      modelReviewCalls: 1,
      capturedDenialCalls: 0,
      behaviors: ["workflow-local"],
      sampleCommands: [CUSTOM_SAFE_COMMAND],
      capturedOutcomeBreakdown: new Map(),
    },
    examples: [{ command: CUSTOM_SAFE_COMMAND, matches: true }],
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

function overbroadAllowProposal(): RuleProposal {
  return ruleProposal({
    id: "prop:data:user-global:allow-rm-overbroad",
    ruleId: "allow-rm-overbroad",
    match: { program: "rm" },
    reason:
      "Intentionally over-broad allow used to prove write-time floor rejection.",
    evidence: {
      executable: "rm",
      calls: 1,
      unique: 1,
      reviewCalls: 1,
      hardBlockCalls: 0,
      modelReviewCalls: 0,
      capturedDenialCalls: 0,
      behaviors: [],
      sampleCommands: [OVERBROAD_COMMAND],
      capturedOutcomeBreakdown: new Map(),
    },
    examples: [{ command: OVERBROAD_COMMAND, matches: true }],
  });
}

function coreMatcherProposal(): RuleProposal {
  return ruleProposal({
    kind: "core-matcher",
    target: "core-matcher",
    id: "prop:core-matcher:core-matcher:local-workflow-tool",
    ruleId: "local-workflow-tool",
    coreMatcher: {
      name: "localWorkflowTool",
      signature: "localWorkflowTool(name: string)",
      gap: "Existing data matchers cannot express the project-local helper boundary.",
      rationale: "A core matcher would make the policy auditable.",
      examples: [{ command: "tool --list", matches: true }],
    },
  });
}

function reviewerProposal(
  overrides: Partial<ReviewerConfigProposal> & {
    readonly kind?: ReviewerConfigChangeKind;
    readonly target?: ReviewerConfigTarget;
  } = {},
): ReviewerConfigProposal {
  const kind = overrides.kind ?? "global-append";
  const target = overrides.target ?? "user-global";

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
      rendered:
        target === "user-global"
          ? 'reviewer.promptAppends[0]: + "Prefer bounded local workflows."'
          : 'promptAppends[0]: + "Prefer bounded local workflows."',
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

describe("ratchet apply skill integration", () => {
  it("ships the native-mode ratchet skill without a public bin", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    );
    const skill = await readFile(
      path.join(process.cwd(), "src/skill/clearance-tune/SKILL.md"),
      "utf8",
    );

    // The public package executable is gone: no bin field, and bin/ is not
    // published. The dev wrapper lives under scripts/dev/ instead.
    expect(packageJson).not.toHaveProperty("bin");
    expect(packageJson.files).not.toContain("bin");
    expect(packageJson.files).not.toContain("scripts");
    expect(packageJson.files).toContain("src");
    expect(packageJson.files).toContain("docs");

    // The Tune skill stays registered as native-mode guidance.
    expect(packageJson.pi.skills).toContain(
      "./src/skill/clearance-tune/SKILL.md",
    );

    // Native Tune workflow is the required path.
    expect(skill).toContain("/clearance tune");
    expect(skill).not.toContain("/auto-reviewer ratchet on");
    expect(skill).not.toContain("/auto-reviewer ratchet off");
    expect(skill).toContain("clearance_status");
    expect(skill).toContain("clearance_generate_proposals");
    expect(skill).toContain("clearance_present");
    expect(skill).toContain("clearance_propose");
    expect(skill).toContain("writes only user-owned config");
    expect(skill).toContain("core-matcher");
    expect(skill).not.toContain("trusted-module");

    // The legacy helper CLI is not the required workflow or approval path.
    expect(skill).not.toContain("show <proposal-id>");
    expect(skill).not.toContain("pi-auto-approve-ratchet apply");

    // The helper survives only as a non-published debug fallback.
    expect(skill).toContain("runRatchetCli()");
    expect(skill).toContain("scripts/dev/pi-clearance-tune.cjs");
    expect(skill).toContain("not the approval path");
  });

  it("runs propose -> show -> approval-boundary apply -> verify for a generated data allow", async () => {
    const project = await makeProject("full-loop");
    const corpusPath = path.join(project.userConfigRoot, "custom-corpus.json");
    await writeJson(corpusPath, [
      {
        command: CUSTOM_SAFE_COMMAND,
        expected: "review",
        reason: "unapproved local git helper should review before ratchet",
      },
    ]);

    const propose = await runRatchetCli(
      [
        "propose",
        "--run-dir",
        project.runDir,
        "--no-audit",
        "--corpus",
        corpusPath,
      ],
      { cwd: project.cwd, env: project.env },
    );
    expect(propose.exitCode).toBe(0);

    const proposals = JSON.parse(
      await readFile(path.join(project.runDir, "proposals.json"), "utf8"),
    ) as readonly RuleProposal[];
    const proposal = proposals.find((candidate) =>
      candidate.evidence.sampleCommands.includes(CUSTOM_SAFE_COMMAND),
    );
    expect(proposal).toBeDefined();
    if (proposal === undefined) {
      throw new Error("expected generated custom-safe proposal");
    }

    const beforeShow = await readFile(project.globalConfigFile, "utf8");
    const show = await runRatchetCli(
      ["show", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("## Exact diff");
    expect(show.stdout).toContain("Route: write-overlay");
    await expect(readFile(project.globalConfigFile, "utf8")).resolves.toBe(
      beforeShow,
    );

    // The test models the normal Pi approval boundary: only after `show` has
    // rendered the exact diff do we call `apply`.
    const apply = await runRatchetCli(
      ["apply", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain("Verification ok.");
    expect(apply.stdout).toContain("Expansions: 1 calls / 1 unique");

    const global = JSON.parse(await readFile(project.globalConfigFile, "utf8"));
    const normalized = normalizeConfig(GlobalConfigSchema, global);
    expect(normalized.ok).toBe(true);
    expect(global.packs[0]).toMatchObject({
      id: "ratchet.generated",
      rules: [{ id: proposal.ruleId, effect: "allow" }],
    });

    const composed = await composeEffectivePolicy(
      await loadProjectConfig(project),
      { audit: createAuditLogger({ sink: noopAuditSink }) },
    );
    expect(composed.ok).toBe(true);

    const verification = await readFile(
      path.join(project.runDir, "verification.md"),
      "utf8",
    );
    expect(verification).toContain("`review->fast_path` — 1 call");

    const verify = await runRatchetCli(
      ["verify", "--run-dir", project.runDir],
      {
        cwd: project.cwd,
        env: project.env,
      },
    );
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toContain("Fixture regressions:");
  });

  it("rejects an over-broad allow at write time without writing or leaving a backup", async () => {
    const project = await makeProject("overbroad");
    const proposal = overbroadAllowProposal();
    await seedRun(project, [proposal], replayCorpus(OVERBROAD_COMMAND));
    const before = await readFile(project.globalConfigFile, "utf8");

    const apply = await runRatchetCli(
      ["apply", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );

    expect(apply.exitCode).toBe(2);
    expect(apply.stdout).toContain(
      "Rejected at write-time floor-overlap validation",
    );
    await expect(readFile(project.globalConfigFile, "utf8")).resolves.toBe(
      before,
    );
    await expect(stat(`${project.globalConfigFile}.bak`)).rejects.toThrow();
  });

  it("routes core-matcher proposals to design input artifacts without code or config writes", async () => {
    const project = await makeProject("core-matcher");
    const proposal = coreMatcherProposal();
    await seedRun(project, [proposal]);
    const before = await readFile(project.globalConfigFile, "utf8");

    const apply = await runRatchetCli(
      ["apply", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );

    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain("Design-input artifact written");
    await expect(readFile(project.globalConfigFile, "utf8")).resolves.toBe(
      before,
    );
    const artifactPath = path.join(
      project.runDir,
      "design-inputs",
      "prop-core-matcher-core-matcher-local-workflow-tool.md",
    );
    await expect(stat(artifactPath)).resolves.toBeTruthy();
    await expect(readFile(artifactPath, "utf8")).resolves.toContain(
      "epic-parser-and-policy-core",
    );
  });

  it("applies reviewer-config proposals and reloads valid merged config", async () => {
    const project = await makeProject("reviewer-config");
    const proposal = reviewerProposal();
    await seedRun(project, [proposal], replayCorpus("just --list"));

    const apply = await runRatchetCli(
      ["apply", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );

    expect(apply.exitCode).toBe(0);
    const global = JSON.parse(await readFile(project.globalConfigFile, "utf8"));
    expect(global.reviewer.promptAppends).toContain(
      "Prefer bounded local workflows.",
    );
    expect(normalizeConfig(GlobalConfigSchema, global).ok).toBe(true);

    const composed = await composeEffectivePolicy(
      await loadProjectConfig(project),
      { audit: createAuditLogger({ sink: noopAuditSink }) },
    );
    expect(composed.ok).toBe(true);
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(value, jsonReplacer, 2)}\n`,
    "utf8",
  );
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }
  return value;
}
