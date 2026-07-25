import { describe, expect, it } from "vitest";
import type {
  DecisionEffect,
  EffectivePolicy,
  PolicyRule,
} from "../../src/policy/core.ts";
import { inspectable, program } from "../../src/policy/core.ts";
import type {
  CapturedOutcomeLabel,
  CorpusRecord,
  CountByLabel,
  ReplayStatus,
} from "../../src/replay/corpus-model.ts";
import { CAPTURED_OUTCOME_LABELS } from "../../src/replay/corpus-model.ts";
import type { CorpusQueryModel } from "../../src/replay/corpus-query.ts";
import { buildCorpusQueryModel } from "../../src/replay/corpus-query.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import {
  type FrictionFamily,
  type PerCommandRow,
  replayHistory,
  type UnknownToolTally,
} from "../../src/replay/ratchet.ts";

// ---------------------------------------------------------------------------
// Outcome label sets (mirror the report/model internals for independent derivation)
// ---------------------------------------------------------------------------

const MODEL_LABELS = new Set<CapturedOutcomeLabel>([
  "model-allow",
  "model-deny",
  "model-review",
]);

const DENIAL_LABELS = new Set<CapturedOutcomeLabel>([
  "deterministic-deny",
  "model-deny",
  "human-deny",
  "block-and-log",
  "fixture-hard-block",
]);

const CORPUS_SOURCES: readonly CorpusSource[] = ["session", "audit", "corpus"];

// ---------------------------------------------------------------------------
// Policy + corpus fixtures
// ---------------------------------------------------------------------------

function rule(
  id: string,
  effect: DecisionEffect,
  executable: string,
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(program(executable)),
    reason: `${effect} ${executable}`,
    provenance: { source: "generated", packId: "test-pack", ruleId: id },
  };
}

function policy(opts: {
  readonly floor?: readonly PolicyRule[];
  readonly active?: readonly PolicyRule[];
}): EffectivePolicy {
  return {
    ...(opts.floor === undefined ? {} : { floor: opts.floor }),
    ...(opts.active === undefined ? {} : { active: opts.active }),
  };
}

// Baseline: allow git, floor-deny rm. Proposed: drop allow-git, add review-git,
// allow-pnpm, allow-cat, and a floor deny-curl — producing fast_path->review,
// review->fast_path, and review->hard_block transitions.
const BASELINE_POLICY = policy({
  floor: [rule("deny-rm", "deny", "rm")],
  active: [rule("allow-git", "allow", "git")],
});

const PROPOSED_POLICY = policy({
  floor: [rule("deny-rm", "deny", "rm"), rule("deny-curl", "deny", "curl")],
  active: [
    rule("review-git-status", "review", "git"),
    rule("allow-pnpm", "allow", "pnpm"),
    rule("allow-cat", "allow", "cat"),
  ],
});

function entry(overrides: Partial<CorpusEntry>): CorpusEntry {
  const source = overrides.source ?? "session";
  return {
    command: "git status",
    toolName: "bash",
    source,
    sources: overrides.sources ?? [source],
    provenance: overrides.provenance ?? "test",
    fidelity: overrides.fidelity ?? "high",
    ...overrides,
  };
}

function richEntries(): readonly CorpusEntry[] {
  return [
    entry({
      command: "git status",
      deterministicOutcome: "allow",
      toolCallId: "c1",
    }),
    entry({ command: "git status", toolCallId: "c2" }),
    entry({
      command: "pnpm test",
      reviewerOutcome: { mode: "model", finalEffect: "allow" },
      toolCallId: "c3",
    }),
    entry({
      command: "rm -rf tmp",
      deterministicOutcome: "deny",
      toolCallId: "c4",
    }),
    entry({ command: "echo $(whoami)", toolCallId: "c5" }),
    entry({
      command: "legacy_edit /a",
      toolName: "legacy_edit",
      reviewerOutcome: { mode: "model", finalEffect: "review" },
      toolCallId: "c6",
    }),
    entry({
      command: "curl https://example.invalid",
      source: "audit",
      sources: ["audit"],
      deterministicOutcome: "review",
      fidelity: "redacted",
      toolCallId: "c7",
    }),
    entry({
      command: "cat README.md",
      source: "corpus",
      sources: ["corpus"],
      expectedLabel: "fast_path",
    }),
  ];
}

function corpus(
  entries: readonly CorpusEntry[],
  opts: {
    readonly unmatched?: number;
    readonly warnings?: readonly string[];
  } = {},
): ReplayCorpus {
  return {
    entries,
    sourceSummary: sourceSummary(entries),
    unmatchedAuditEntries: opts.unmatched ?? 0,
    warnings: opts.warnings ?? [],
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

const FIXED_CLOCK = () => new Date("2026-06-25T12:00:00.000Z");
const RICH_CORPUS = corpus(richEntries(), { unmatched: 2 });

// ---------------------------------------------------------------------------
// Independent model-derived expectations (deliberately not sharing the bridge code)
// ---------------------------------------------------------------------------

interface RecordGroup {
  readonly command: string;
  readonly records: readonly CorpusRecord[];
}

function groupByCommand(records: readonly CorpusRecord[]): RecordGroup[] {
  const order: string[] = [];
  const groups = new Map<string, CorpusRecord[]>();
  for (const record of records) {
    let group = groups.get(record.command);
    if (group === undefined) {
      group = [];
      groups.set(record.command, group);
      order.push(record.command);
    }
    group.push(record);
  }
  return order.map((command) => ({
    command,
    records: groups.get(command) as CorpusRecord[],
  }));
}

function representative(group: RecordGroup): CorpusRecord {
  const bash = group.records.find((record) => record.toolName === "bash");
  if (bash !== undefined) {
    return bash;
  }
  const first = group.records[0];
  if (first === undefined) {
    throw new Error("representative requires a non-empty record group");
  }
  return first;
}

function tallyCaptured(
  records: readonly CorpusRecord[],
): Map<CapturedOutcomeLabel, number> {
  const tally = new Map<CapturedOutcomeLabel, number>();
  for (const record of records) {
    const label = record.captured.label;
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  // Order by canonical labels, drop zeros — mirroring the report's sorted map.
  const sorted = new Map<CapturedOutcomeLabel, number>();
  for (const label of CAPTURED_OUTCOME_LABELS) {
    const count = tally.get(label);
    if (count !== undefined && count > 0) {
      sorted.set(label, count);
    }
  }
  return sorted;
}

function expectedPerCommand(records: readonly CorpusRecord[]): PerCommandRow[] {
  return groupByCommand(records).map((group) => {
    const rep = representative(group);
    const executable = rep.parsed.summary.primaryExecutable;
    const ruleId = rep.replayed.ruleId;
    return {
      command: group.command,
      count: group.records.length,
      toolName: group.records[0]?.toolName ?? "unknown",
      ...(executable === undefined ? {} : { executable }),
      status: rep.replayed.status,
      reason: rep.replayed.decision.reason,
      ...(ruleId === undefined ? {} : { ruleId }),
      provenance: rep.replayed.provenance,
      capturedOutcomes: tallyCaptured(group.records),
      fidelity: group.records.some((r) => r.source.fidelity === "redacted")
        ? "redacted"
        : "high",
      sources: CORPUS_SOURCES.filter((source) =>
        group.records.some((r) => r.source.sources.includes(source)),
      ),
    };
  });
}

function countByStatus(records: readonly CorpusRecord[]): {
  readonly fastPath: number;
  readonly review: number;
  readonly hardBlock: number;
} {
  let fastPath = 0;
  let review = 0;
  let hardBlock = 0;
  for (const record of records) {
    if (record.replayed.status === "fast_path") fastPath++;
    else if (record.replayed.status === "review") review++;
    else hardBlock++;
  }
  return { fastPath, review, hardBlock };
}

function expectedOutcomeTally(
  records: readonly CorpusRecord[],
): Map<
  CapturedOutcomeLabel,
  { readonly calls: number; readonly unique: number }
> {
  const calls = new Map<CapturedOutcomeLabel, number>();
  const unique = new Map<CapturedOutcomeLabel, Set<string>>();
  for (const record of records) {
    const label = record.captured.label;
    calls.set(label, (calls.get(label) ?? 0) + 1);
    const commands = unique.get(label) ?? new Set<string>();
    commands.add(record.command);
    unique.set(label, commands);
  }
  const sorted = new Map<
    CapturedOutcomeLabel,
    { readonly calls: number; readonly unique: number }
  >();
  for (const label of CAPTURED_OUTCOME_LABELS) {
    const callCount = calls.get(label);
    if (callCount !== undefined && callCount > 0) {
      sorted.set(label, {
        calls: callCount,
        unique: (unique.get(label) ?? new Set()).size,
      });
    }
  }
  return sorted;
}

function expectedModelReviewLoad(records: readonly CorpusRecord[]): {
  readonly calls: number;
  readonly unique: number;
} {
  let calls = 0;
  const commands = new Set<string>();
  for (const record of records) {
    if (MODEL_LABELS.has(record.captured.label)) {
      calls++;
      commands.add(record.command);
    }
  }
  return { calls, unique: commands.size };
}

function expectedUnknownTools(
  records: readonly CorpusRecord[],
): UnknownToolTally[] {
  const tallies = new Map<
    string,
    {
      toolName: string;
      calls: number;
      reviewCalls: number;
      hardBlockCalls: number;
      fastPathCalls: number;
      modelReviewCalls: number;
      capturedDenialCalls: number;
      capturedOutcomes: Map<CapturedOutcomeLabel, number>;
    }
  >();
  for (const record of records) {
    if (record.toolName === "bash") continue;
    const existing = tallies.get(record.toolName);
    const tally = existing ?? {
      toolName: record.toolName,
      calls: 0,
      reviewCalls: 0,
      hardBlockCalls: 0,
      fastPathCalls: 0,
      modelReviewCalls: 0,
      capturedDenialCalls: 0,
      capturedOutcomes: new Map<CapturedOutcomeLabel, number>(),
    };
    tally.calls += 1;
    if (record.replayed.status === "review") tally.reviewCalls += 1;
    else if (record.replayed.status === "hard_block") tally.hardBlockCalls += 1;
    else tally.fastPathCalls += 1;
    const label = record.captured.label;
    tally.capturedOutcomes.set(
      label,
      (tally.capturedOutcomes.get(label) ?? 0) + 1,
    );
    if (MODEL_LABELS.has(label)) tally.modelReviewCalls += 1;
    if (DENIAL_LABELS.has(label)) tally.capturedDenialCalls += 1;
    tallies.set(record.toolName, tally);
  }
  return [...tallies.values()]
    .map((t) => ({
      ...t,
      capturedOutcomes: tallyCaptured(
        records.filter((r) => r.toolName === t.toolName),
      ),
    }))
    .sort(
      (a, b) =>
        b.modelReviewCalls +
          b.capturedDenialCalls +
          b.reviewCalls -
          (a.modelReviewCalls + a.capturedDenialCalls + a.reviewCalls) ||
        b.calls - a.calls ||
        a.toolName.localeCompare(b.toolName),
    )
    .slice(0, 20);
}

function expectedContentiousFamilies(
  records: readonly CorpusRecord[],
): FrictionFamily[] {
  const byExecutable = new Map<
    string,
    {
      executable: string;
      calls: number;
      unique: Set<string>;
      reviewCalls: number;
      hardBlockCalls: number;
      modelReviewCalls: number;
      capturedDenialCalls: number;
      sampleCommands: string[];
      seen: Set<string>;
    }
  >();
  for (const record of records) {
    const executable = record.parsed.summary.primaryExecutable;
    if (executable === undefined) continue;
    const family = byExecutable.get(executable) ?? {
      executable,
      calls: 0,
      unique: new Set<string>(),
      reviewCalls: 0,
      hardBlockCalls: 0,
      modelReviewCalls: 0,
      capturedDenialCalls: 0,
      sampleCommands: [],
      seen: new Set<string>(),
    };
    family.calls += 1;
    family.unique.add(record.command);
    if (record.replayed.status === "review") family.reviewCalls += 1;
    else if (record.replayed.status === "hard_block")
      family.hardBlockCalls += 1;
    if (MODEL_LABELS.has(record.captured.label)) family.modelReviewCalls += 1;
    if (DENIAL_LABELS.has(record.captured.label))
      family.capturedDenialCalls += 1;
    if (family.sampleCommands.length < 5 && !family.seen.has(record.command)) {
      family.seen.add(record.command);
      family.sampleCommands.push(record.command);
    }
    byExecutable.set(executable, family);
  }
  return [...byExecutable.values()]
    .filter((f) => f.reviewCalls + f.hardBlockCalls + f.capturedDenialCalls > 0)
    .map((f) => ({
      executable: f.executable,
      calls: f.calls,
      unique: f.unique.size,
      reviewCalls: f.reviewCalls,
      hardBlockCalls: f.hardBlockCalls,
      modelReviewCalls: f.modelReviewCalls,
      capturedDenialCalls: f.capturedDenialCalls,
      sampleCommands: f.sampleCommands,
    }))
    .sort(
      (a, b) =>
        b.reviewCalls +
          b.hardBlockCalls +
          b.capturedDenialCalls -
          (a.reviewCalls + a.hardBlockCalls + a.capturedDenialCalls) ||
        b.calls - a.calls ||
        b.unique - a.unique ||
        a.executable.localeCompare(b.executable),
    )
    .slice(0, 20);
}

function expectedCompareTransitions(
  baseline: readonly CorpusRecord[],
  proposed: readonly CorpusRecord[],
): {
  readonly transitions: Map<string, number>;
  readonly changedUnique: number;
  readonly changedCalls: number;
  readonly expansions: { readonly calls: number; readonly unique: number };
  readonly changedCommands: {
    readonly command: string;
    readonly status: ReplayStatus;
    readonly count: number;
  }[];
} {
  const beforeByCommand = new Map(
    groupByCommand(baseline).map((g) => [g.command, g] as const),
  );
  const afterByCommand = new Map(
    groupByCommand(proposed).map((g) => [g.command, g] as const),
  );
  const transitions = new Map<string, number>();
  const changedCommands: {
    readonly command: string;
    readonly status: ReplayStatus;
    readonly count: number;
  }[] = [];
  let changedUnique = 0;
  let changedCalls = 0;
  let expansionCalls = 0;
  let expansionUnique = 0;

  for (const [command, beforeGroup] of beforeByCommand) {
    const afterGroup = afterByCommand.get(command);
    if (afterGroup === undefined) continue;
    const beforeStatus = representative(beforeGroup).replayed.status;
    const afterStatus = representative(afterGroup).replayed.status;
    if (beforeStatus === afterStatus) continue;
    const transition = `${beforeStatus}->${afterStatus}`;
    changedUnique += 1;
    changedCalls += afterGroup.records.length;
    transitions.set(
      transition,
      (transitions.get(transition) ?? 0) + afterGroup.records.length,
    );
    if (transition === "review->fast_path") {
      expansionCalls += afterGroup.records.length;
      expansionUnique += 1;
    }
    changedCommands.push({
      command,
      status: afterStatus,
      count: afterGroup.records.length,
    });
  }

  const sortedTransitions = new Map(
    [...transitions.entries()].sort(
      ([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount || leftKey.localeCompare(rightKey),
    ),
  );
  const sortedChanged = changedCommands.sort(
    (a, b) => b.count - a.count || a.command.localeCompare(b.command),
  );

  return {
    transitions: sortedTransitions,
    changedUnique,
    changedCalls,
    expansions: { calls: expansionCalls, unique: expansionUnique },
    changedCommands: sortedChanged,
  };
}

function countsToMap<TLabel extends string>(
  counts: readonly CountByLabel<TLabel>[],
  order: readonly TLabel[],
): Map<TLabel, number> {
  const map = new Map<TLabel, number>();
  for (const label of order) {
    map.set(label, 0);
  }
  for (const entry of counts) {
    map.set(entry.label, entry.calls);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe("corpus query model -> ratchet report bridge parity", () => {
  // Build the report (via the bridge) and the models (independently) once.
  let report: Awaited<ReturnType<typeof replayHistory>>;
  let baselineModel: CorpusQueryModel;
  let proposedModel: CorpusQueryModel;

  async function buildFixtures(): Promise<void> {
    report = await replayHistory(RICH_CORPUS, BASELINE_POLICY, {
      clock: FIXED_CLOCK,
      proposedPolicy: PROPOSED_POLICY,
    });
    baselineModel = await buildCorpusQueryModel(RICH_CORPUS, BASELINE_POLICY);
    proposedModel = await buildCorpusQueryModel(RICH_CORPUS, PROPOSED_POLICY);
  }

  async function ensureBuilt(): Promise<void> {
    if (report === undefined) {
      await buildFixtures();
    }
  }

  it("perCommand rows are a faithful projection of baseline model records", async () => {
    await ensureBuilt();
    const expected = expectedPerCommand(baselineModel.records);
    expect(report.perCommand).toEqual(expected);
  });

  it("corpus totals, sources, and warnings agree with the baseline model", async () => {
    await ensureBuilt();
    expect(report.corpus.totalCalls).toBe(baselineModel.records.length);
    expect(report.corpus.totalUnique).toBe(
      new Set(baselineModel.records.map((r) => r.command)).size,
    );
    expect(report.corpus.unmatchedAuditEntries).toBe(
      baselineModel.summary.unmatchedAuditEntries,
    );
    expect(report.corpus.warnings).toEqual(baselineModel.warnings);
    expect(report.corpus.sources).toEqual(
      countsToMap(baselineModel.summary.sourceCounts, CORPUS_SOURCES),
    );
  });

  it("replay-status call counts agree with baseline model records", async () => {
    await ensureBuilt();
    const counts = countByStatus(baselineModel.records);
    expect(report.summary.fastPathCalls).toBe(counts.fastPath);
    expect(report.summary.reviewCalls).toBe(counts.review);
    expect(report.summary.hardBlockCalls).toBe(counts.hardBlock);
    // Unique counts: distinct commands per status.
    const uniqueByStatus = new Map<ReplayStatus, Set<string>>();
    for (const record of baselineModel.records) {
      const set =
        uniqueByStatus.get(record.replayed.status) ?? new Set<string>();
      set.add(record.command);
      uniqueByStatus.set(record.replayed.status, set);
    }
    expect(report.summary.fastPathUnique).toBe(
      (uniqueByStatus.get("fast_path") ?? new Set()).size,
    );
    expect(report.summary.reviewUnique).toBe(
      (uniqueByStatus.get("review") ?? new Set()).size,
    );
    expect(report.summary.hardBlockUnique).toBe(
      (uniqueByStatus.get("hard_block") ?? new Set()).size,
    );
  });

  it("captured outcome counts (calls + unique) agree with baseline model records", async () => {
    await ensureBuilt();
    const expected = expectedOutcomeTally(baselineModel.records);
    expect(report.summary.byCapturedOutcome.size).toBe(expected.size);
    for (const [label, tally] of expected) {
      expect(report.summary.byCapturedOutcome.get(label)).toEqual(tally);
    }
  });

  it("redacted calls and model-review load agree with baseline model records", async () => {
    await ensureBuilt();
    expect(report.summary.redactedCalls).toBe(
      baselineModel.records.filter((r) => r.source.redacted).length,
    );
    expect(report.summary.modelReviewLoad).toEqual(
      expectedModelReviewLoad(baselineModel.records),
    );
  });

  it("unknown-tool tallies agree with non-bash baseline model records", async () => {
    await ensureBuilt();
    expect(report.topUnknownTools).toEqual(
      expectedUnknownTools(baselineModel.records),
    );
  });

  it("reviewed families and top reviewed executables/commands agree with the model", async () => {
    await ensureBuilt();
    expect(report.topContentiousFamilies).toEqual(
      expectedContentiousFamilies(baselineModel.records),
    );

    // Top reviewed executables: executables with review load, sorted by review calls.
    const families = expectedContentiousFamilies(baselineModel.records);
    const expectedReviewedExecutables = families
      .filter((f) => f.reviewCalls > 0)
      .map((f) => ({
        executable: f.executable,
        calls: f.calls,
        unique: f.unique,
        fastPathCalls: 0,
        reviewCalls: f.reviewCalls,
        hardBlockCalls: f.hardBlockCalls,
        modelReviewCalls: f.modelReviewCalls,
        capturedDenialCalls: f.capturedDenialCalls,
      }));
    expect(report.topReviewedExecutables).toEqual(expectedReviewedExecutables);

    // Top reviewed commands: review rows sorted by friction (count desc, command asc).
    const expectedReviewedCommands = expectedPerCommand(baselineModel.records)
      .filter((row) => row.status === "review")
      .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command))
      .slice(0, 20);
    expect(report.topReviewedCommands).toEqual(expectedReviewedCommands);
  });

  it("compare transitions, expansions, and changed rows agree with baseline vs proposed model records", async () => {
    await ensureBuilt();
    expect(report.compare).toBeDefined();
    const expected = expectedCompareTransitions(
      baselineModel.records,
      proposedModel.records,
    );

    expect([...(report.compare?.transitions.entries() ?? [])]).toEqual([
      ...expected.transitions.entries(),
    ]);
    expect(report.compare?.changedUnique).toBe(expected.changedUnique);
    expect(report.compare?.changedCalls).toBe(expected.changedCalls);
    expect(report.compare?.expansions).toEqual(expected.expansions);
    expect(
      report.compare?.changedCommands.map((row) => ({
        command: row.command,
        status: row.status,
        count: row.count,
      })),
    ).toEqual(expected.changedCommands);
  });

  it("compare before/after summaries agree with the two model builds", async () => {
    await ensureBuilt();
    // beforeSummary is the baseline summary; afterSummary is the proposed summary.
    const beforeCounts = countByStatus(baselineModel.records);
    const afterCounts = countByStatus(proposedModel.records);
    expect(report.compare?.beforeSummary.totalCalls).toBe(
      baselineModel.records.length,
    );
    expect(report.compare?.afterSummary.totalCalls).toBe(
      proposedModel.records.length,
    );
    expect(report.compare?.afterSummary.fastPathCalls).toBe(
      afterCounts.fastPath,
    );
    expect(report.compare?.afterSummary.reviewCalls).toBe(afterCounts.review);
    expect(report.compare?.afterSummary.hardBlockCalls).toBe(
      afterCounts.hardBlock,
    );
    expect(report.compare?.beforeSummary.fastPathCalls).toBe(
      beforeCounts.fastPath,
    );
    expect(report.compare?.beforeSummary.reviewCalls).toBe(beforeCounts.review);
    expect(report.compare?.beforeSummary.hardBlockCalls).toBe(
      beforeCounts.hardBlock,
    );
  });

  it("compare is absent without a proposed policy", async () => {
    const single = await replayHistory(RICH_CORPUS, BASELINE_POLICY, {
      clock: FIXED_CLOCK,
    });
    expect(single.compare).toBeUndefined();
  });
});
