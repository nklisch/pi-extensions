import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ReplayCorpus } from "../../src/replay/history.ts";
import type { StructuredRatchetProposal } from "../../src/replay/proposal-schema.ts";
import { validateStructuredProposalBatch } from "../../src/replay/proposal-schema.ts";
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
import { structuredProposal } from "./structured-proposal-fixture.ts";

const MATCH = {
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

function corpus(command = "git custom-safe"): ReplayCorpus {
  return {
    entries: [
      {
        command,
        toolName: "bash",
        source: "corpus",
        sources: ["corpus"],
        provenance: "apply-cli-test",
        expectedLabel: "review",
        fidelity: "high",
      },
    ],
    sourceSummary: new Map([["corpus", 1]]),
    unmatchedAuditEntries: 0,
    warnings: [],
  };
}

async function makeProject(name: string): Promise<TestProject> {
  const root = await mkdtemp(path.join(tmpdir(), `pi-clearance-${name}-`));
  const cwd = path.join(root, "repo");
  const configHome = path.join(root, "config-home");
  const userConfigRoot = path.join(configHome, "pi", "pi-clearance");
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

async function seedRun(
  project: TestProject,
  proposals: readonly (
    | RuleProposal
    | ReviewerConfigProposal
    | StructuredRatchetProposal
  )[],
  testCorpus: ReplayCorpus = corpus(),
): Promise<void> {
  await writeJson(path.join(project.runDir, "proposals.json"), proposals);
  await writeJson(path.join(project.runDir, "deferred.json"), []);
  await writeJson(path.join(project.runDir, "corpus.json"), testCorpus);
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
    id: `prop:${kind}:${target}:allow-git-custom-safe`,
    kind,
    target,
    effect: "allow",
    ruleId: "allow-git-custom-safe",
    ...(target === "shipped-pack" ? { packId: "bash.dev.verify" } : {}),
    match: MATCH,
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
      sampleCommands: ["git custom-safe"],
      capturedOutcomeBreakdown: new Map(),
    },
    examples: [{ command: "git custom-safe", matches: true }],
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
        'reviewer.promptAppends[0]: + "Prefer bounded local workflows."',
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

describe("Tune helper CLI", () => {
  it("usage copy identifies the helper as internal plumbing and points to native Tune mode", async () => {
    const help = await runRatchetCli(["--help"]);

    expect(help.exitCode).toBe(1);
    expect(help.stdout).toMatch(/internal|development/i);
    expect(help.stdout).toContain("Usage: scripts/dev/pi-clearance-tune.cjs");
    expect(help.stdout).not.toContain(
      "Usage: pi-clearance-ratchet <command>",
    );
    expect(help.stdout).toContain("/clearance tune");
    expect(help.stdout).not.toContain("/auto-reviewer ratchet on");
    expect(help.stdout).not.toContain("/auto-reviewer ratchet off");
  });

  it("propose writes legacy and structured report/proposal artifacts", async () => {
    const project = await makeProject("propose");
    const corpusPath = path.join(project.userConfigRoot, "test-corpus.json");
    await writeJson(corpusPath, [
      {
        command: "git custom-safe",
        expected: "review",
        reason: "unapproved local git helper should review before ratchet",
      },
    ]);

    const result = await runRatchetCli(
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

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Helper CLI package parity disclosure");
    await expect(
      stat(path.join(project.runDir, "report.md")),
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(project.runDir, "proposals.json")),
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(project.runDir, "structured-report.md")),
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(project.runDir, "structured-proposals.json")),
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(project.runDir, "proposal-cards.md")),
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(project.runDir, "deferred.json")),
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(project.runDir, "corpus.json")),
    ).resolves.toBeTruthy();

    const structuredBatch = JSON.parse(
      await readFile(
        path.join(project.runDir, "structured-proposals.json"),
        "utf8",
      ),
    ) as unknown;
    const validation = validateStructuredProposalBatch(structuredBatch);
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      throw new Error(validation.errors.join("\n"));
    }
    expect(validation.batch.proposals.length).toBeGreaterThan(0);
    expect(validation.batch.warnings.join("\n")).toContain(
      "Helper CLI package parity disclosure",
    );
    await expect(
      readFile(path.join(project.runDir, "structured-report.md"), "utf8"),
    ).resolves.toContain("# Structured ratchet report");
    await expect(
      readFile(path.join(project.runDir, "proposal-cards.md"), "utf8"),
    ).resolves.toContain("# Proposal");
  });

  it("lists, shows, applies, and verifies a data rule without performing approval itself", async () => {
    const project = await makeProject("data-rule");
    const proposal = ruleProposal();
    await seedRun(project, [proposal]);

    const list = await runRatchetCli(["list", "--run-dir", project.runDir], {
      cwd: project.cwd,
      env: project.env,
    });
    expect(list).toMatchObject({ exitCode: 0 });
    expect(list.stdout).toContain(proposal.id);

    const beforeShow = await readFile(project.globalConfigFile, "utf8");
    const show = await runRatchetCli(
      ["show", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("## Exact diff");
    expect(show.stdout).toContain("allow-git-custom-safe");
    await expect(readFile(project.globalConfigFile, "utf8")).resolves.toBe(
      beforeShow,
    );

    const apply = await runRatchetCli(
      ["apply", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );
    expect([0, 1]).toContain(apply.exitCode);
    expect(apply.stdout).toContain("Verification");
    await expect(stat(`${project.globalConfigFile}.bak`)).resolves.toBeTruthy();
    await expect(
      stat(path.join(project.runDir, "verification.md")),
    ).resolves.toBeTruthy();

    const global = JSON.parse(await readFile(project.globalConfigFile, "utf8"));
    expect(global.packs[0]).toMatchObject({
      id: "ratchet.generated",
      rules: [{ id: "allow-git-custom-safe", effect: "allow" }],
    });

    const verify = await runRatchetCli(
      ["verify", "--run-dir", project.runDir],
      {
        cwd: project.cwd,
        env: project.env,
      },
    );
    expect([0, 1]).toContain(verify.exitCode);
    expect(verify.stdout).toContain("Fixture regressions:");
  });

  it("shows structured proposal cards without writing and refuses structured apply", async () => {
    const project = await makeProject("structured-show");
    const proposal = structuredProposal();
    const designInput = structuredProposal({
      id: "structured-prop:shipped-pack-design-input",
      title: "Design shipped pack rule",
      applicationMode: "design-input-only",
      target: {
        kind: "design-input",
        route: "shipped-pack",
        suggestedPath: "packs/bash.dev.verify.ts",
      },
    });
    await seedRun(project, [proposal, designInput]);
    const beforeShow = await readFile(project.globalConfigFile, "utf8");

    const show = await runRatchetCli(
      ["show", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );

    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain(
      "# Proposal `structured-prop:allow-git-custom-safe`: Allow git custom-safe",
    );
    expect(show.stdout).toContain("## Approval boundary");
    expect(show.stdout).toContain("Generation/rendering is not approval");
    expect(show.stdout).toContain("## Exact change");
    expect(show.stdout).toContain("Pack id: `ratchet.generated`");
    await expect(readFile(project.globalConfigFile, "utf8")).resolves.toBe(
      beforeShow,
    );

    const designShow = await runRatchetCli(
      ["show", designInput.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );
    expect(designShow.exitCode).toBe(0);
    expect(designShow.stdout).toContain("- Route: design-input-only");
    expect(designShow.stdout).toContain(
      "This card is design input only: it does not write config",
    );

    const apply = await runRatchetCli(
      ["apply", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );

    expect(apply.exitCode).toBe(2);
    expect(apply.stdout).toContain("Structured proposals are display-only");
    await expect(readFile(project.globalConfigFile, "utf8")).resolves.toBe(
      beforeShow,
    );
    await expect(stat(`${project.globalConfigFile}.bak`)).rejects.toThrow();
  });

  it("rejects invalid write plans with exit 2 and leaves the target untouched", async () => {
    const project = await makeProject("reject");
    const invalid = ruleProposal({
      id: "prop:data:user-global:invalid",
      ruleId: "invalid-empty-matcher",
      match: {},
    });
    await seedRun(project, [invalid]);
    const before = await readFile(project.globalConfigFile, "utf8");

    const apply = await runRatchetCli(
      ["apply", invalid.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );

    expect(apply.exitCode).toBe(2);
    expect(apply.stdout).toContain("Rejected at write-time");
    await expect(readFile(project.globalConfigFile, "utf8")).resolves.toBe(
      before,
    );
    await expect(stat(`${project.globalConfigFile}.bak`)).rejects.toThrow();
  });

  it("routes design-input proposals to an artifact without writing config", async () => {
    const project = await makeProject("design-input");
    const routed = ruleProposal({
      kind: "core-matcher",
      target: "core-matcher",
      id: "prop:core-matcher:core-matcher",
      coreMatcher: {
        name: "localWorkflowTool",
        signature: "localWorkflowTool(name: string)",
        gap: "Existing data matchers cannot express the project-local helper boundary.",
        rationale: "A core matcher would make the policy auditable.",
        examples: [{ command: "tool --list", matches: true }],
      },
    });
    await seedRun(project, [routed]);
    const before = await readFile(project.globalConfigFile, "utf8");

    const apply = await runRatchetCli(
      ["apply", routed.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );

    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain("Design-input artifact written");
    await expect(
      stat(
        path.join(
          project.runDir,
          "design-inputs",
          "prop-core-matcher-core-matcher.md",
        ),
      ),
    ).resolves.toBeTruthy();
    await expect(readFile(project.globalConfigFile, "utf8")).resolves.toBe(
      before,
    );
  });

  it("applies reviewer-config proposals through the same write boundary", async () => {
    const project = await makeProject("reviewer");
    const proposal = reviewerProposal();
    await seedRun(project, [proposal], corpus("just --list"));

    const apply = await runRatchetCli(
      ["apply", proposal.id, "--run-dir", project.runDir],
      { cwd: project.cwd, env: project.env },
    );

    expect([0, 1]).toContain(apply.exitCode);
    const global = JSON.parse(await readFile(project.globalConfigFile, "utf8"));
    expect(global.reviewer.promptAppends).toContain(
      "Prefer bounded local workflows.",
    );
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
