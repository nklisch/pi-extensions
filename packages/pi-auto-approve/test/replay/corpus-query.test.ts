import { describe, expect, it } from "vitest";
import { piExtensionInspectPack } from "../../src/packs/pi.extension.inspect.ts";
import { piInspectReadPack } from "../../src/packs/pi.inspect.read.ts";
import type {
  DecisionEffect,
  EffectivePolicy,
  PolicyRule,
} from "../../src/policy/core.ts";
import { inspectable, program } from "../../src/policy/core.ts";
import type { CorpusQueryModel } from "../../src/replay/corpus-query.ts";
import {
  buildCorpusQueryModel,
  getFamily,
  queryCorpus,
  summarizeCommandFamilies,
} from "../../src/replay/corpus-query.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";

// ---------------------------------------------------------------------------
// Test helpers
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

/** Build an EffectivePolicy without touching the config loader. */
function policy(
  opts: {
    readonly floor?: readonly PolicyRule[];
    readonly active?: readonly PolicyRule[];
  } = {},
): EffectivePolicy {
  return {
    ...(opts.floor === undefined ? {} : { floor: opts.floor }),
    ...(opts.active === undefined ? {} : { active: opts.active }),
  };
}

function entry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
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

function corpus(
  entries: readonly CorpusEntry[],
  opts: {
    readonly unmatched?: number;
    readonly warnings?: readonly string[];
  } = {},
): ReplayCorpus {
  return {
    entries,
    // sourceSummary is recomputed by the builder; an empty Map is fine here.
    sourceSummary: new Map<CorpusSource, number>(),
    unmatchedAuditEntries: opts.unmatched ?? 0,
    warnings: opts.warnings ?? [],
  };
}

const TS = (second: number) =>
  `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;

const PATH_FACTS = {
  cwd: "/repo",
  projectScope: {
    roots: ["/repo"],
    writableDirectories: ["/repo"],
    tempDirectories: ["/tmp"],
    deniedDirectories: [],
    safeHomeDirectories: [],
    unknownPathBehavior: "review" as const,
  },
};

/** A rich corpus exercising repeated commands, model/human outcomes, unknown tools,
 *  redacted audit rows, fixtures, substitution, and stdout redirect. */
function richEntries(): readonly CorpusEntry[] {
  return [
    entry({
      command: "git status",
      deterministicOutcome: "allow",
      toolCallId: "c1",
      sessionId: "s1",
      timestamp: TS(0),
    }),
    entry({
      command: "git status",
      toolCallId: "c2",
      sessionId: "s1",
      timestamp: TS(1),
    }),
    entry({
      command: "pnpm test",
      reviewerOutcome: { mode: "model", finalEffect: "allow" },
      toolCallId: "c3",
      timestamp: TS(2),
    }),
    entry({
      command: "rm -rf /tmp/foo",
      deterministicOutcome: "deny",
      toolCallId: "c4",
      timestamp: TS(3),
    }),
    entry({ command: "echo $(whoami)", toolCallId: "c5", timestamp: TS(4) }),
    entry({
      command: "git status > /tmp/out",
      toolCallId: "c6",
      timestamp: TS(5),
    }),
    entry({
      command: "legacy_edit /a/b",
      toolName: "legacy_edit",
      toolCallId: "c7",
      timestamp: TS(6),
    }),
    entry({
      command: "curl https://example.invalid",
      source: "audit",
      sources: ["audit"],
      deterministicOutcome: "review",
      fidelity: "redacted",
      timestamp: TS(7),
    }),
    entry({
      command: "cat README.md",
      source: "corpus",
      sources: ["corpus"],
      expectedLabel: "fast_path",
    }),
  ];
}

const RICH_POLICY = policy({
  active: [
    rule("allow-git", "allow", "git"),
    rule("allow-pnpm", "allow", "pnpm"),
  ],
  floor: [rule("deny-rm", "deny", "rm")],
});

async function buildRichModel(): Promise<CorpusQueryModel> {
  return buildCorpusQueryModel(
    corpus(richEntries(), { unmatched: 2 }),
    RICH_POLICY,
  );
}

// ---------------------------------------------------------------------------
// buildCorpusQueryModel — per-occurrence records
// ---------------------------------------------------------------------------

describe("buildCorpusQueryModel — records", () => {
  it("returns one record per corpus entry with stable unique ids", async () => {
    const entries = richEntries();
    const model = await buildRichModel();

    expect(model.records).toHaveLength(entries.length);
    const ids = model.records.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith("rec-")).toBe(true);
    }
  });

  it("preserves identity, source fidelity, captured outcome, parsed evidence, replayed decision, family, and provenance", async () => {
    const model = await buildRichModel();

    const gitStatus = model.records[0];
    if (gitStatus === undefined) {
      throw new Error("expected first record to be defined");
    }
    expect(gitStatus.identity.toolName).toBe("bash");
    expect(gitStatus.identity.command).toBe("git status");
    expect(gitStatus.identity.toolCallId).toBe("c1");
    expect(gitStatus.identity.sessionId).toBe("s1");
    expect(gitStatus.identity.timestamp).toBe(TS(0));
    expect(gitStatus.source.source).toBe("session");
    expect(gitStatus.source.redacted).toBe(false);
    expect(gitStatus.captured.label).toBe("deterministic-allow");
    expect(gitStatus.captured.deterministicEffect).toBe("allow");
    expect(gitStatus.parsed.summary.toolKind).toBe("bash");
    expect(gitStatus.parsed.summary.primaryExecutable).toBe("git");
    expect(gitStatus.replayed.status).toBe("fast_path");
    expect(gitStatus.replayed.decision.effect).toBe("allow");
    expect(gitStatus.family.id).toBe("bash:git:status:clean");
    expect(gitStatus.originalEntry.command).toBe("git status");
  });

  it("classifies captured outcomes across model/human/deny/fixture/no-outcome", async () => {
    const model = await buildRichModel();
    const labels = (index: number) => model.records[index]?.captured.label;

    expect(labels(0)).toBe("deterministic-allow"); // git status allow
    expect(labels(1)).toBe("no-captured-outcome"); // repeated git status, no outcome
    expect(labels(2)).toBe("model-allow"); // pnpm test model allow
    expect(labels(3)).toBe("deterministic-deny"); // rm deny
    expect(labels(7)).toBe("deterministic-review"); // curl redacted audit
    expect(labels(8)).toBe("fixture-fast-path"); // cat README.md fixture
  });

  it("replays bash via decide(): floor deny → hard_block, unmatched → review, allow → fast_path", async () => {
    const model = await buildRichModel();
    const statuses = (index: number) => model.records[index]?.replayed.status;

    expect(statuses(0)).toBe("fast_path"); // git status allow
    expect(statuses(2)).toBe("fast_path"); // pnpm test allow
    expect(statuses(3)).toBe("hard_block"); // rm floor deny
    expect(statuses(4)).toBe("review"); // echo, no matching rule
    expect(statuses(5)).toBe("fast_path"); // git status > out, allow git
    expect(statuses(7)).toBe("review"); // curl, no matching rule
    expect(statuses(8)).toBe("review"); // cat, no matching rule
  });

  it("repeated commands produce separate records with distinct ids but a shared family", async () => {
    const model = await buildRichModel();
    const gitStatusRecords = model.records.filter(
      (record) => record.command === "git status",
    );
    expect(gitStatusRecords).toHaveLength(2);
    expect(gitStatusRecords[0]?.id).not.toBe(gitStatusRecords[1]?.id);
    expect(gitStatusRecords[0]?.family.id).toBe("bash:git:status:clean");
    expect(gitStatusRecords[1]?.family.id).toBe("bash:git:status:clean");

    const family = getFamily(model, "bash:git:status:clean");
    expect(family?.calls).toBe(2);
    expect(family?.uniqueCommands).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Family summaries + getFamily
// ---------------------------------------------------------------------------

describe("command family summaries", () => {
  it("answers review load, model-review load, captured denials, and redacted/low-fidelity", async () => {
    const model = await buildRichModel();

    const rmFamily = getFamily(model, "bash:rm:arg:clean");
    expect(rmFamily).toBeDefined();
    expect(rmFamily?.calls).toBe(1);
    expect(rmFamily?.replayStatusCounts).toEqual([
      { label: "hard_block", calls: 1 },
    ]);
    expect(rmFamily?.capturedOutcomeCounts).toEqual([
      { label: "deterministic-deny", calls: 1 },
    ]);
    expect(rmFamily?.capturedDenialCalls).toBe(1);
    expect(rmFamily?.modelReviewCalls).toBe(0);

    const pnpmFamily = getFamily(model, "bash:pnpm:test:clean");
    expect(pnpmFamily?.modelReviewCalls).toBe(1);
    expect(pnpmFamily?.capturedOutcomeCounts).toEqual([
      { label: "model-allow", calls: 1 },
    ]);

    const curlFamily = model.families.find(
      (summary) => summary.family.id === "bash:curl:arg:clean",
    );
    expect(curlFamily?.redactedCalls).toBe(1);
    expect(curlFamily?.lowFidelityCalls).toBe(1);
    expect(curlFamily?.sources).toEqual(["audit"]);

    // Review-load family: echo has substitution and reviews.
    const echoFamily = getFamily(model, "bash:echo:arg:subst");
    expect(echoFamily?.replayStatusCounts).toEqual([
      { label: "review", calls: 1 },
    ]);
    expect(echoFamily?.family.hasSubstitution).toBe(true);
  });

  it("carries sample record ids and distinct sample commands capped by sampleLimit", async () => {
    // `git -C <path> status` groups with `git status` (global-option skipping),
    // so three distinct command strings form one bash:git:status:clean family.
    const entries: readonly CorpusEntry[] = [
      entry({ command: "git status" }),
      entry({ command: "git -C /repo status" }),
      entry({ command: "git -C /other status" }),
    ];
    const model = await buildCorpusQueryModel(
      corpus(entries),
      policy({
        active: [rule("allow-git", "allow", "git")],
      }),
    );

    const summaries = summarizeCommandFamilies(model.records, {
      sampleLimit: 2,
    });
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.family.id).toBe("bash:git:status:clean");
    expect(summary?.calls).toBe(3);
    expect(summary?.uniqueCommands).toBe(3);
    expect(summary?.sampleRecordIds).toHaveLength(2);
    expect(summary?.sampleCommands).toEqual([
      "git status",
      "git -C /repo status",
    ]);
  });

  it("getFamily returns undefined for an unknown family id", async () => {
    const model = await buildRichModel();
    expect(getFamily(model, "bash:nope:none:clean")).toBeUndefined();
  });

  it("summarizeCommandFamilies sorts by friction desc then calls then id", async () => {
    const model = await buildRichModel();
    // The rm family (hard_block + denial) has the highest friction and sorts first.
    expect(model.families[0]?.family.id).toBe("bash:rm:arg:clean");
    // Clean fast-path families sort below review/noisy ones.
    const gitStatusIndex = model.families.findIndex(
      (summary) => summary.family.id === "bash:git:status:clean",
    );
    const echoIndex = model.families.findIndex(
      (summary) => summary.family.id === "bash:echo:arg:subst",
    );
    expect(echoIndex).toBeLessThan(gitStatusIndex);
  });
});

// ---------------------------------------------------------------------------
// queryCorpus — filtering
// ---------------------------------------------------------------------------

describe("queryCorpus — filtering", () => {
  it("filters by toolNames", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { toolNames: ["legacy_edit"] });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.toolName).toBe("legacy_edit");
  });

  it("filters by familyIds", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { familyIds: ["bash:git:status:clean"] });
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.family.id).toBe("bash:git:status:clean");
    }
  });

  it("filters by replayStatuses", async () => {
    const model = await buildRichModel();
    const hardBlocks = queryCorpus(model, { replayStatuses: ["hard_block"] });
    expect(hardBlocks.records).toHaveLength(1);
    expect(hardBlocks.records[0]?.command).toBe("rm -rf /tmp/foo");

    const fastPaths = queryCorpus(model, { replayStatuses: ["fast_path"] });
    expect(fastPaths.records).toHaveLength(4);
  });

  it("filters by capturedOutcomeLabels", async () => {
    const model = await buildRichModel();
    const modelAllows = queryCorpus(model, {
      capturedOutcomeLabels: ["model-allow"],
    });
    expect(modelAllows.records).toHaveLength(1);
    expect(modelAllows.records[0]?.command).toBe("pnpm test");
  });

  it("filters by sources (primary source), fidelity, and redacted", async () => {
    const model = await buildRichModel();
    const audit = queryCorpus(model, { sources: ["audit"] });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.source.redacted).toBe(true);

    const redacted = queryCorpus(model, { redacted: true });
    expect(redacted.records).toHaveLength(1);
    expect(redacted.records[0]?.command).toBe("curl https://example.invalid");

    const notRedacted = queryCorpus(model, { redacted: false });
    expect(notRedacted.records).toHaveLength(model.records.length - 1);

    const redactedFidelity = queryCorpus(model, { fidelity: ["redacted"] });
    expect(redactedFidelity.records).toHaveLength(1);
  });

  it("filters by hasModelReview and hasCapturedDenial", async () => {
    const model = await buildRichModel();
    const reviews = queryCorpus(model, { hasModelReview: true });
    expect(reviews.records).toHaveLength(1);
    expect(reviews.records[0]?.command).toBe("pnpm test");

    const denials = queryCorpus(model, { hasCapturedDenial: true });
    expect(denials.records).toHaveLength(1);
    expect(denials.records[0]?.command).toBe("rm -rf /tmp/foo");
  });

  it("filters by hasSubstitution and hasStdoutRedirect", async () => {
    const model = await buildRichModel();
    const subst = queryCorpus(model, { hasSubstitution: true });
    expect(subst.records).toHaveLength(1);
    expect(subst.records[0]?.command).toBe("echo $(whoami)");

    const redirect = queryCorpus(model, { hasStdoutRedirect: true });
    expect(redirect.records).toHaveLength(1);
    expect(redirect.records[0]?.command).toBe("git status > /tmp/out");
  });

  it("combines multiple facets", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, {
      toolNames: ["bash"],
      replayStatuses: ["fast_path"],
      familyIds: ["bash:git:status:clean"],
    });
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.family.id).toBe("bash:git:status:clean");
    }
  });

  it("returns families and summary over the filtered set, pre-pagination", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { replayStatuses: ["hard_block"] });
    expect(result.records).toHaveLength(1);
    expect(result.families).toHaveLength(1);
    expect(result.families[0]?.family.id).toBe("bash:rm:arg:clean");
    expect(result.summary.totalRecords).toBe(1);
    expect(result.summary.replayStatusCounts).toEqual([
      { label: "hard_block", calls: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// queryCorpus — sort order, pagination, immutability
// ---------------------------------------------------------------------------

describe("queryCorpus — sort, pagination, immutability", () => {
  it("default orderBy preserves build order", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model);
    expect(result.records.map((record) => record.id)).toEqual(
      model.records.map((record) => record.id),
    );
  });

  it("orderBy friction puts hard_block first, reviews next, fast_path last", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { orderBy: "friction" });
    const statuses = result.records.map((record) => record.replayed.status);
    expect(statuses).toEqual([
      "hard_block",
      "review",
      "review",
      "review",
      "review",
      "fast_path",
      "fast_path",
      "fast_path",
      "fast_path",
    ]);
  });

  it("orderBy command sorts ascending with stable id tiebreak", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { orderBy: "command" });
    expect(result.records[0]?.command).toBe("cat README.md");
    expect(result.records.at(-1)?.command).toBe("rm -rf /tmp/foo");
    // Repeated "git status" keeps build order (id tiebreak).
    const gitStatus = result.records.filter((r) => r.command === "git status");
    expect(gitStatus).toHaveLength(2);
    expect(gitStatus[0]?.id).toBe(model.records[0]?.id);
  });

  it("orderBy timestamp sorts ascending with missing timestamps last", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { orderBy: "timestamp" });
    expect(result.records[0]?.command).toBe("git status");
    expect(result.records[0]?.identity.timestamp).toBe(TS(0));
    // The corpus fixture has no timestamp → sorts last.
    expect(result.records.at(-1)?.command).toBe("cat README.md");
  });

  it("orderBy family groups by family id ascending", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { orderBy: "family" });
    expect(result.records[0]?.family.id).toBe("bash:cat:arg:clean");
    expect(result.records.at(-1)?.family.id).toBe(
      "unknown-tool:legacy_edit:clean",
    );
  });

  it("paginates with limit and offset and reports total", async () => {
    const model = await buildRichModel();
    // orderBy command: cat(0), curl(1), echo(2), edit(3), git status(4,5), ...
    const result = queryCorpus(model, {
      orderBy: "command",
      limit: 2,
      offset: 1,
    });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.command).toBe("curl https://example.invalid");
    expect(result.records[1]?.command).toBe("echo $(whoami)");
    expect(result.page).toEqual({ offset: 1, limit: 2, total: 9 });
  });

  it("offset past the end returns an empty window but keeps total", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { offset: 100 });
    expect(result.records).toHaveLength(0);
    expect(result.page.total).toBe(9);
  });

  it("limit 0 returns an empty window", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, { limit: 0 });
    expect(result.records).toHaveLength(0);
    expect(result.page.limit).toBe(0);
    expect(result.page.total).toBe(9);
  });

  it("never mutates the model", async () => {
    const model = await buildRichModel();
    const beforeIds = model.records.map((record) => record.id);
    const beforeFirstFamily = model.families[0]?.family.id;

    queryCorpus(model, { replayStatuses: ["hard_block"], orderBy: "friction" });
    queryCorpus(model, { toolNames: ["legacy_edit"], limit: 1, offset: 0 });
    queryCorpus(model, { redacted: true });

    expect(model.records.map((record) => record.id)).toEqual(beforeIds);
    expect(model.families[0]?.family.id).toBe(beforeFirstFamily);
  });

  it("an empty query (undefined) returns all records", async () => {
    const model = await buildRichModel();
    const result = queryCorpus(model, undefined);
    expect(result.records).toHaveLength(model.records.length);
    expect(result.page.total).toBe(model.records.length);
  });
});

// ---------------------------------------------------------------------------
// Parser failures and unknown tools stay queryable
// ---------------------------------------------------------------------------

describe("parser failures and unknown tools", () => {
  it("analyzed Pi built-ins become Pi-tool families and replay through deterministic policy", async () => {
    const entries: readonly CorpusEntry[] = [
      entry({
        toolName: "read",
        command: JSON.stringify({ path: "README.md" }),
        toolInput: { path: "README.md" },
      }),
    ];
    const model = await buildCorpusQueryModel(
      corpus(entries),
      policy({ active: piInspectReadPack.rules }),
      { pathFacts: PATH_FACTS },
    );

    const read = model.records[0];
    expect(read?.family.kind).toBe("pi-tool");
    expect(read?.family.id).toBe("pi-tool:read:read-file:clean");
    expect(read?.parsed.summary.toolKind).toBe("pi-tool");
    expect(read?.parsed.summary.toolOperation).toBe("read-file");
    expect(read?.parsed.pathFacts?.hasUnknown).toBe(false);
    expect(read?.replayed.status).toBe("fast_path");

    const family = getFamily(model, "pi-tool:read:read-file:clean");
    expect(family?.calls).toBe(1);
    expect(family?.replayStatusCounts).toEqual([
      { label: "fast_path", calls: 1 },
    ]);
  });

  it("covered extension tools become Pi-tool families and replay through their packs", async () => {
    const entries: readonly CorpusEntry[] = [
      entry({
        toolName: "get_goal",
        command: JSON.stringify({}),
        toolInput: {},
      }),
    ];
    const model = await buildCorpusQueryModel(
      corpus(entries),
      policy({ active: piExtensionInspectPack.rules }),
    );

    const goal = model.records[0];
    expect(goal?.family.kind).toBe("pi-tool");
    expect(goal?.family.id).toBe("pi-tool:get_goal:state-read:clean");
    expect(goal?.parsed.summary.toolOperation).toBe("state-read");
    expect(goal?.replayed.status).toBe("fast_path");
  });

  it("unknown tools stay queryable under an unknown-tool family", async () => {
    const model = await buildRichModel();
    const edit = model.records.find(
      (record) => record.toolName === "legacy_edit",
    );
    expect(edit?.family.kind).toBe("unknown-tool");
    expect(edit?.family.id).toBe("unknown-tool:legacy_edit:clean");
    expect(edit?.replayed.status).toBe("review"); // default unknownToolPosture
    expect(edit?.parsed.summary.toolKind).toBe("unknown");

    const result = queryCorpus(model, { toolNames: ["legacy_edit"] });
    expect(result.records).toHaveLength(1);
  });

  it("unknownToolPosture option controls the non-bash replayed status", async () => {
    const entries: readonly CorpusEntry[] = [
      entry({ command: "legacy_edit /a", toolName: "legacy_edit" }),
    ];
    const allowUnknown = await buildCorpusQueryModel(
      corpus(entries),
      policy({}),
      {
        unknownToolPosture: "allow",
      },
    );
    expect(allowUnknown.records[0]?.replayed.status).toBe("fast_path");

    const denyUnknown = await buildCorpusQueryModel(
      corpus(entries),
      policy({}),
      {
        unknownToolPosture: "deny",
      },
    );
    expect(denyUnknown.records[0]?.replayed.status).toBe("hard_block");
  });
});

// ---------------------------------------------------------------------------
// includeFullShape
// ---------------------------------------------------------------------------

describe("includeFullShape", () => {
  it("omits the full shape and truncates args by default; retains both when requested", async () => {
    const many = Array.from({ length: 40 }, (_, index) => `a${index}`).join(
      " ",
    );
    const command = `echo ${many}`;
    const entries: readonly CorpusEntry[] = [entry({ command })];

    const lean = await buildCorpusQueryModel(corpus(entries), policy({}));
    expect(lean.records[0]?.parsed.shape).toBeUndefined();
    expect(lean.records[0]?.parsed.summary.arguments).toHaveLength(32);

    const full = await buildCorpusQueryModel(corpus(entries), policy({}), {
      includeFullShape: true,
    });
    expect(full.records[0]?.parsed.shape).toBeDefined();
    expect(full.records[0]?.parsed.shape?.kind).toBe("bash");
    expect(full.records[0]?.parsed.summary.arguments).toHaveLength(40);
  });
});

// ---------------------------------------------------------------------------
// JSON serializability
// ---------------------------------------------------------------------------

describe("JSON serializability", () => {
  it("JSON.stringify round-trips the model without custom Map handling", async () => {
    const model = await buildRichModel();
    const json = JSON.stringify(model);
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json) as CorpusQueryModel;

    expect(parsed.records).toHaveLength(model.records.length);
    expect(Array.isArray(parsed.families)).toBe(true);
    expect(Array.isArray(parsed.summary.replayStatusCounts)).toBe(true);
    expect(Array.isArray(parsed.summary.capturedOutcomeCounts)).toBe(true);
    expect(Array.isArray(parsed.summary.sourceCounts)).toBe(true);
    // Count arrays are plain { label, calls } entries, not Map entries.
    expect(parsed.summary.replayStatusCounts[0]).toEqual(
      expect.objectContaining({
        label: expect.any(String),
        calls: expect.any(Number),
      }),
    );
  });

  it("JSON.stringify succeeds with includeFullShape (full shape is plain data)", async () => {
    const entries: readonly CorpusEntry[] = [entry({ command: "git status" })];
    const model = await buildCorpusQueryModel(corpus(entries), policy({}), {
      includeFullShape: true,
    });
    expect(() => JSON.stringify(model)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Empty / malformed input
// ---------------------------------------------------------------------------

describe("empty and malformed input", () => {
  it("a completely malformed (non-record) corpus returns an empty model plus a warning", async () => {
    const model = await buildCorpusQueryModel(
      null as unknown as ReplayCorpus,
      policy({}),
    );
    expect(model.records).toEqual([]);
    expect(model.families).toEqual([]);
    expect(model.summary.totalRecords).toBe(0);
    expect(model.warnings).toEqual(["replay corpus was malformed; skipped"]);
  });

  it("an empty-object corpus is treated as empty-but-valid (no malformed warning)", async () => {
    const model = await buildCorpusQueryModel({} as ReplayCorpus, policy({}));
    expect(model.records).toEqual([]);
    expect(model.summary.totalRecords).toBe(0);
    expect(model.warnings).toEqual([]);
  });

  it("an empty corpus returns an empty model with no records and zeroed summary", async () => {
    const model = await buildCorpusQueryModel(corpus([]), policy({}));
    expect(model.records).toEqual([]);
    expect(model.families).toEqual([]);
    expect(model.summary).toMatchObject({
      totalRecords: 0,
      totalUniqueCommands: 0,
      modelReviewLoad: { calls: 0, uniqueCommands: 0 },
      lowFidelityCalls: 0,
      redactedCalls: 0,
      unmatchedAuditEntries: 0,
    });
    expect(model.warnings).toEqual([]);
  });

  it("skips malformed entries with a per-index warning and keeps valid ones", async () => {
    const entries = [
      entry({ command: "git status" }),
      { command: "git log" } as unknown as CorpusEntry, // missing toolName/source/fidelity
      entry({ command: "pnpm test" }),
    ];
    const model = await buildCorpusQueryModel(corpus(entries), policy({}));
    expect(model.records).toHaveLength(2);
    expect(model.records[0]?.command).toBe("git status");
    expect(model.records[1]?.command).toBe("pnpm test");
    expect(model.warnings).toEqual([
      "replay corpus entry at index 1 was malformed; skipped",
    ]);
  });

  it("skips malformed optional identity fields before timestamp sorting", async () => {
    const entries = [
      entry({ command: "git status", timestamp: TS(1) }),
      {
        ...entry({ command: "git log" }),
        timestamp: 123,
      } as unknown as CorpusEntry,
      {
        ...entry({ command: "pnpm test" }),
        toolCallId: false,
      } as unknown as CorpusEntry,
    ];
    const model = await buildCorpusQueryModel(corpus(entries), policy({}));

    expect(model.records).toHaveLength(1);
    expect(model.warnings).toEqual([
      "replay corpus entry at index 1 was malformed; skipped",
      "replay corpus entry at index 2 was malformed; skipped",
    ]);
    expect(() => queryCorpus(model, { orderBy: "timestamp" })).not.toThrow();
  });

  it("carries corpus warnings and unmatchedAuditEntries through to the summary", async () => {
    const entries: readonly CorpusEntry[] = [entry({ command: "git status" })];
    const model = await buildCorpusQueryModel(
      corpus(entries, { unmatched: 5, warnings: ["upstream warning"] }),
      policy({}),
    );
    expect(model.summary.unmatchedAuditEntries).toBe(5);
    expect(model.warnings).toContain("upstream warning");
  });
});

// ---------------------------------------------------------------------------
// Model summary
// ---------------------------------------------------------------------------

describe("CorpusQuerySummary", () => {
  it("aggregates totals, counts, and model-review load", async () => {
    const model = await buildRichModel();
    const summary = model.summary;

    expect(summary.totalRecords).toBe(9);
    expect(summary.totalUniqueCommands).toBe(8); // "git status" repeats
    expect(summary.unmatchedAuditEntries).toBe(2);

    expect(summary.replayStatusCounts).toEqual([
      { label: "fast_path", calls: 4 },
      { label: "review", calls: 4 },
      { label: "hard_block", calls: 1 },
    ]);
    // Order follows CAPTURED_OUTCOME_LABELS canonical order, zero-counts omitted.
    expect(summary.capturedOutcomeCounts).toEqual([
      { label: "deterministic-allow", calls: 1 },
      { label: "deterministic-deny", calls: 1 },
      { label: "deterministic-review", calls: 1 },
      { label: "model-allow", calls: 1 },
      { label: "fixture-fast-path", calls: 1 },
      { label: "no-captured-outcome", calls: 4 },
    ]);
    expect(summary.lowFidelityCalls).toBe(1);
    expect(summary.redactedCalls).toBe(1);
    expect(summary.sourceCounts).toEqual([
      { label: "session", calls: 7 },
      { label: "audit", calls: 1 },
      { label: "corpus", calls: 1 },
    ]);
    expect(summary.modelReviewLoad).toEqual({ calls: 1, uniqueCommands: 1 });
    expect(summary.lowFidelityCalls).toBe(1);
    expect(summary.redactedCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism helper used by sort assertions
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("rebuilds an identical model for identical input", async () => {
    const a = await buildRichModel();
    const b = await buildRichModel();
    expect(a.records.map((r) => r.id)).toEqual(b.records.map((r) => r.id));
    expect(a.families.map((f) => f.family.id)).toEqual(
      b.families.map((f) => f.family.id),
    );
    expect(a.summary).toEqual(b.summary);
  });
});
