import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { ToolShape } from "../../src/parse/shape.ts";
import type { DecisionEffect, PolicyRule } from "../../src/policy/core.ts";
import { inspectable, program } from "../../src/policy/core.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import type { ReplayBashParser } from "../../src/replay/ratchet.ts";
import { renderRatchetMarkdown } from "../../src/replay/ratchet-markdown.ts";
import {
  verifyAfterWrite,
  verifyFixtures,
} from "../../src/skill/clearance-tune/verify.ts";

function rule(
  id: string,
  effect: DecisionEffect,
  executable: string,
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(program(executable)),
    reason: `reason for ${id}`,
    provenance: { source: "generated", packId: "test-pack", ruleId: id },
  };
}

function shapeFor(command: string): ToolShape {
  const executable = command.trim().split(/\s+/, 1)[0] ?? "";
  const stage =
    executable.length === 0
      ? undefined
      : {
          kind: "command" as const,
          program: {
            program: executable,
            resolvable: true,
            arguments: [],
            flags: [],
            environment: [],
            span: { start: 0, end: executable.length },
          },
          substitutions: [],
          redirects: [],
          span: { start: 0, end: command.length },
        };
  const stages = stage === undefined ? [] : [stage];

  return {
    kind: "bash",
    rawCommand: command,
    blocks:
      stage === undefined
        ? []
        : [
            {
              pipeline: {
                stages,
                pipeTargets: [],
                span: { start: 0, end: command.length },
              },
              span: { start: 0, end: command.length },
            },
          ],
    stages,
    diagnostics: [],
  };
}

const parser: ReplayBashParser = async (command) => shapeFor(command);
const fixedClock = () => new Date("2026-06-25T12:00:00.000Z");

function entry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  const source = overrides.source ?? "session";
  return {
    command: "git status",
    toolName: "bash",
    source,
    sources: overrides.sources ?? [source],
    provenance: "test",
    fidelity: overrides.fidelity ?? "high",
    ...overrides,
  };
}

function corpus(entries: readonly CorpusEntry[]): ReplayCorpus {
  return {
    entries,
    sourceSummary: sourceSummary(entries),
    unmatchedAuditEntries: 0,
    warnings: [],
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

describe("ratchet apply post-write verification", () => {
  it("produces compare-mode report, expansions, and markdown from the replay renderer", async () => {
    const bashParser = vi.fn(parser);
    const userCorpus = corpus([
      entry({ command: "git status" }),
      entry({ command: "pnpm test" }),
      entry({ command: "pnpm test" }),
    ]);
    const fixtureCorpus = corpus([]);

    const result = await verifyAfterWrite(
      userCorpus,
      fixtureCorpus,
      { active: [rule("allow-git", "allow", "git")] },
      {
        active: [
          rule("allow-git", "allow", "git"),
          rule("allow-pnpm", "allow", "pnpm"),
        ],
      },
      { bashParser, clock: fixedClock },
    );

    expect(result.report.compare).toBeDefined();
    expect(result.report.compare?.beforeSummary).toEqual(result.report.summary);
    expect([...(result.report.compare?.transitions.entries() ?? [])]).toEqual([
      ["review->fast_path", 2],
    ]);
    expect(result.expansions).toEqual({ calls: 2, unique: 1 });
    expect(
      result.report.compare?.changedCommands.map((row) => row.command),
    ).toEqual(["pnpm test"]);
    expect(result.markdown).toBe(renderRatchetMarkdown(result.report));
    expect(result.ok).toBe(true);
  });

  it("flags hard fixture regressions when a hard block is widened to fast path", async () => {
    const result = await verifyAfterWrite(
      corpus([]),
      corpus([
        entry({
          command: "rm -rf tmp",
          source: "corpus",
          sources: ["corpus"],
          expectedLabel: "hard_block",
        }),
      ]),
      {},
      { active: [rule("allow-rm", "allow", "rm")] },
      { bashParser: parser, clock: fixedClock },
    );

    expect(result.fixtureChecked).toBe(1);
    expect(result.fixtureRegressions).toEqual([
      {
        command: "rm -rf tmp",
        expected: "hard_block",
        actual: "fast_path",
        severity: "hard",
        reason:
          "fixture expected hard_block but replay widened it to fast_path",
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it("flags tightening fixture mismatches as soft and keeps verification ok", async () => {
    const result = await verifyAfterWrite(
      corpus([]),
      corpus([
        entry({
          command: "git status",
          source: "corpus",
          sources: ["corpus"],
          expectedLabel: "fast_path",
        }),
        entry({
          command: "node --version",
          source: "corpus",
          sources: ["corpus"],
        }),
      ]),
      {},
      {},
      { bashParser: parser, clock: fixedClock },
    );

    expect(result.fixtureChecked).toBe(1);
    expect(result.fixtureRegressions).toEqual([
      {
        command: "git status",
        expected: "fast_path",
        actual: "review",
        severity: "soft",
        reason: "fixture expected fast_path but replay returned review",
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("reports review-expected mismatches as soft from verifyFixtures", async () => {
    await expect(
      verifyFixtures(
        corpus([
          entry({
            command: "pnpm test",
            source: "corpus",
            sources: ["corpus"],
            expectedLabel: "review",
          }),
        ]),
        { active: [rule("allow-pnpm", "allow", "pnpm")] },
        { bashParser: parser },
      ),
    ).resolves.toEqual([
      {
        command: "pnpm test",
        expected: "review",
        actual: "fast_path",
        severity: "soft",
        reason: "fixture expected review but replay returned fast_path",
      },
    ]);
  });

  it("keeps the verification module pure and free of execution APIs", () => {
    const modulePath = fileURLToPath(
      new URL("../../src/skill/clearance-tune/verify.ts", import.meta.url),
    );
    const source = readFileSync(modulePath, "utf8");

    expect(source).not.toMatch(/from\s+["'](?:node:)?child_process/u);
    expect(source).not.toMatch(
      /\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(/u,
    );
  });
});
