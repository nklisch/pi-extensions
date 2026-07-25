import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  createArrayAuditSink,
  createAuditLogger,
} from "../../src/audit/log.ts";
import type { ResolvedConfig } from "../../src/config/loader.ts";
import { composeEffectivePolicy } from "../../src/policy/composer.ts";
import type { EffectivePolicy } from "../../src/policy/core.ts";
import type {
  CorpusEntry,
  CorpusExpectedLabel,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import {
  type ModelDrafter,
  proposeRules,
  type RuleProposal,
} from "../../src/replay/proposals.ts";
import { replayHistory } from "../../src/replay/ratchet.ts";
import { readReplayCorpus } from "../../src/replay/reader.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../fixtures/resolved-config.ts";
import { fixtureCorpusPaths } from "./fixture-corpus.ts";

const FIXED_CLOCK = () => new Date("2026-06-25T12:00:00.000Z");
const REPLAY_SRC_DIR = fileURLToPath(
  new URL("../../src/replay/", import.meta.url),
);
const GIT_REV_PARSE_COMMAND = "git rev-parse --show-toplevel";
const GIT_STATUS_WITH_C_COMMAND =
  "git -C /home/nathan/dev/pi-clearance status --short";
const PNPM_VERIFY_COMMAND = "pnpm run custom-check";
const NPM_VERIFY_COMMAND = "npm run ci";
const MAKE_TEST_COMMAND = "make -f /tmp/evil";

function resolvedConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  const trusted = overrides.trustedProject?.trusted ?? false;

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
    trustedProject: {
      trusted,
      ...overrides.trustedProject,
    },
    reviewer: defaultResolvedReviewer(),
    errors: [],
    warnings: [],
    ...overrides,
  };
}

async function composeDefaultPolicy(): Promise<EffectivePolicy> {
  const result = await composeEffectivePolicy(resolvedConfig(), {
    audit: createAuditLogger({ sink: createArrayAuditSink() }),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`default policy composition failed: ${result.reason}`);
  }

  return result.effectivePolicy;
}

function entry(
  command: string,
  expectedLabel: CorpusExpectedLabel,
): CorpusEntry {
  return {
    command,
    toolName: "bash",
    source: "corpus",
    sources: ["corpus"],
    provenance: "proposal-integration-test",
    expectedLabel,
    fidelity: "high",
  };
}

function integrationEntries(): readonly CorpusEntry[] {
  return [
    entry(GIT_REV_PARSE_COMMAND, "fast_path"),
    entry(GIT_STATUS_WITH_C_COMMAND, "review"),
    entry(PNPM_VERIFY_COMMAND, "fast_path"),
    entry(NPM_VERIFY_COMMAND, "fast_path"),
    entry(MAKE_TEST_COMMAND, "review"),
  ];
}

function mergeCorpus(
  corpus: ReplayCorpus,
  extraEntries: readonly CorpusEntry[],
): ReplayCorpus {
  const entries = [...corpus.entries, ...extraEntries];

  return {
    entries,
    sourceSummary: sourceSummary(entries),
    unmatchedAuditEntries: corpus.unmatchedAuditEntries,
    warnings: corpus.warnings,
  };
}

function sourceSummary(
  entries: readonly CorpusEntry[],
): ReadonlyMap<CorpusSource, number> {
  const summary = new Map<CorpusSource, number>([
    ["session", 0],
    ["audit", 0],
    ["corpus", 0],
  ]);

  for (const item of entries) {
    summary.set(item.source, (summary.get(item.source) ?? 0) + 1);
  }

  return summary;
}

async function replayFixtureCorpus(policy: EffectivePolicy) {
  const corpus = mergeCorpus(
    readReplayCorpus({ auditLogPath: "", corpusPaths: fixtureCorpusPaths() }),
    integrationEntries(),
  );

  return replayHistory(corpus, policy, {
    clock: FIXED_CLOCK,
    sourcePath: "shipped corpus + proposal integration commands",
  });
}

function positiveCorpusExamples(
  proposal: RuleProposal,
  corpusCommands: ReadonlySet<string>,
): readonly string[] {
  return proposal.examples
    .filter((example) => example.matches && corpusCommands.has(example.command))
    .map((example) => example.command);
}

function fixtureCommandsFor(
  proposal: RuleProposal,
  expected: "fast_path" | "review" | "hard_block",
): readonly string[] {
  return proposal.fixtureSuggestions
    .filter((fixture) => fixture.expected === expected)
    .map((fixture) => fixture.command);
}

function findProposal(
  proposals: readonly RuleProposal[],
  command: string,
): RuleProposal | undefined {
  return proposals.find((proposal) =>
    proposal.evidence.sampleCommands.includes(command),
  );
}

function expectedFixtureLabel(
  effect: RuleProposal["effect"],
): "fast_path" | "review" | "hard_block" {
  switch (effect) {
    case "allow":
      return "fast_path";
    case "deny":
      return "hard_block";
    case "review":
      return "review";
  }
}

function replaySourceFiles(dir = REPLAY_SRC_DIR): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entryDirent) => {
    const path = join(dir, entryDirent.name);
    if (entryDirent.isDirectory()) {
      return replaySourceFiles(path);
    }
    return entryDirent.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) {
      return [...item.entries()].sort(([left], [right]) =>
        String(left).localeCompare(String(right)),
      );
    }

    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    }

    return item;
  });
}

describe("policy proposal integration", () => {
  it("generates grounded proposals from shipped corpus replay output", async () => {
    const policy = await composeDefaultPolicy();
    const report = await replayFixtureCorpus(policy);
    const proposals = await proposeRules(
      { report, currentPolicy: policy },
      { clock: FIXED_CLOCK, maxClusters: 100, maxProposals: 100 },
    );
    const corpusCommands = new Set(report.perCommand.map((row) => row.command));

    expect(report.perCommand).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: GIT_REV_PARSE_COMMAND,
          status: "fast_path",
        }),
        expect.objectContaining({
          command: GIT_STATUS_WITH_C_COMMAND,
          status: "fast_path",
        }),
        expect.objectContaining({
          command: PNPM_VERIFY_COMMAND,
          status: "fast_path",
        }),
        expect.objectContaining({
          command: NPM_VERIFY_COMMAND,
          status: "fast_path",
        }),
        expect.objectContaining({
          command: MAKE_TEST_COMMAND,
          status: "review",
        }),
      ]),
    );

    const selected = [findProposal(proposals, MAKE_TEST_COMMAND)];

    expect(selected.every((proposal) => proposal !== undefined)).toBe(true);
    for (const proposal of selected) {
      expect(proposal).toBeDefined();
      if (proposal === undefined) {
        continue;
      }
      const positives = positiveCorpusExamples(proposal, corpusCommands);
      expect(positives.length).toBeGreaterThan(0);
      expect(proposal.fixtureSuggestions.length).toBeGreaterThan(0);
      expect(
        fixtureCommandsFor(proposal, expectedFixtureLabel(proposal.effect)),
      ).toEqual(expect.arrayContaining([...positives]));
    }
  });

  it("does not propose an already-covered git rev-parse allow", async () => {
    const policy = await composeDefaultPolicy();
    const report = await replayFixtureCorpus(policy);
    const proposals = await proposeRules(
      { report, currentPolicy: policy },
      { clock: FIXED_CLOCK, maxClusters: 100, maxProposals: 100 },
    );

    expect(
      report.perCommand.find((row) => row.command === GIT_REV_PARSE_COMMAND),
    ).toMatchObject({ status: "fast_path" });
    expect(findProposal(proposals, GIT_REV_PARSE_COMMAND)).toBeUndefined();
  });

  it("does not propose a supported git leading-option gap", async () => {
    const policy = await composeDefaultPolicy();
    const report = await replayFixtureCorpus(policy);
    const proposals = await proposeRules(
      { report, currentPolicy: policy },
      { clock: FIXED_CLOCK, maxClusters: 100, maxProposals: 100 },
    );

    expect(
      report.perCommand.find(
        (row) => row.command === GIT_STATUS_WITH_C_COMMAND,
      ),
    ).toMatchObject({ status: "fast_path" });
    expect(findProposal(proposals, GIT_STATUS_WITH_C_COMMAND)).toBeUndefined();
  });

  it("does not emit floor-overlapping or risky-family allow proposals", async () => {
    const policy = await composeDefaultPolicy();
    const report = await replayFixtureCorpus(policy);
    const proposals = await proposeRules(
      { report, currentPolicy: policy },
      { clock: FIXED_CLOCK, maxClusters: 100, maxProposals: 100 },
    );
    const rmProposal =
      findProposal(proposals, "rm -rf /") ??
      findProposal(proposals, "rm -rf -- /");
    const forcePushProposal = proposals.find((proposal) =>
      proposal.evidence.sampleCommands.some(
        (command) =>
          command.includes("push --force") || command.includes("+HEAD:main"),
      ),
    );

    expect(rmProposal).toBeDefined();
    expect(rmProposal?.effect).not.toBe("allow");
    expect(rmProposal?.floorOverlap.action).toBe("downgraded-to-review");
    expect(
      proposals.filter(
        (proposal) =>
          proposal.effect === "allow" &&
          proposal.evidence.sampleCommands.some((command) =>
            command.startsWith("rm "),
          ),
      ),
    ).toEqual([]);

    expect(forcePushProposal?.effect).not.toBe("allow");
  });

  it("is deterministic without a model drafter and round-trips good and bad model drafts", async () => {
    const policy = await composeDefaultPolicy();
    const report = await replayFixtureCorpus(policy);
    const input = { report, currentPolicy: policy };
    const noModel = await proposeRules(input, {
      clock: FIXED_CLOCK,
      maxClusters: 100,
      maxProposals: 100,
    });
    const noModelAgain = await proposeRules(input, {
      clock: FIXED_CLOCK,
      maxClusters: 100,
      maxProposals: 100,
    });

    expect(stableSerialize(noModelAgain)).toBe(stableSerialize(noModel));

    const goodModelDrafter = vi.fn<ModelDrafter>(async ({ cluster }) => {
      if (!cluster.sampleCommands.includes(MAKE_TEST_COMMAND)) {
        return undefined;
      }

      return {
        match: {
          all: [
            { program: "make" },
            { flagPresent: "f" },
            { noSubstitution: true },
            { noStdoutRedirect: true },
          ],
        },
        effect: "allow",
        reason: "model drafted the make file convenience rule",
      };
    });
    const withGoodModel = await proposeRules(input, {
      clock: FIXED_CLOCK,
      maxClusters: 100,
      maxProposals: 100,
      modelDrafter: goodModelDrafter,
    });
    expect(findProposal(withGoodModel, MAKE_TEST_COMMAND)).toMatchObject({
      modelDrafted: true,
      reason: "model drafted the make file convenience rule",
    });

    const badModelDrafter = vi.fn<ModelDrafter>(async ({ cluster }) => {
      if (!cluster.sampleCommands.includes(MAKE_TEST_COMMAND)) {
        return undefined;
      }

      // Does not match the cluster's own samples, so sample verification
      // must discard it instead of emitting a proposal.
      return {
        match: { all: [{ program: "make" }, { arg0In: ["clean"] }] },
        effect: "allow",
        reason: "over-broad draft should be discarded",
      };
    });
    const withBadModel = await proposeRules(input, {
      clock: FIXED_CLOCK,
      maxClusters: 100,
      maxProposals: 100,
      modelDrafter: badModelDrafter,
    });
    expect(findProposal(withBadModel, MAKE_TEST_COMMAND)).toMatchObject({
      modelDrafted: false,
      effect: "allow",
    });
  });

  it("keeps replay proposal code free of shell execution APIs", () => {
    const forbidden =
      /(?:node:)?child_process|\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(|shell\s*:\s*true/;

    for (const path of replaySourceFiles()) {
      expect(
        readFileSync(path, "utf8"),
        `${path} must not execute commands`,
      ).not.toMatch(forbidden);
    }
  });
});
