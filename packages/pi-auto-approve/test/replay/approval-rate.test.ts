import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createArrayAuditSink,
  createAuditLogger,
} from "../../src/audit/log.ts";
import type {
  ResolvedConfig,
  ResolvedProjectScope,
} from "../../src/config/loader.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import { createDefaultAnalyzerRegistry } from "../../src/parse/registry.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import { composeEffectivePolicy } from "../../src/policy/composer.ts";
import type { DecisionEffect, EffectivePolicy } from "../../src/policy/core.ts";
import { decide } from "../../src/policy/core.ts";
import type {
  CorpusExpectedLabel,
  CorpusFixtureRow,
} from "../../src/replay/history.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedReviewer,
} from "../fixtures/resolved-config.ts";

const APPROVAL_RATE_DIR = fileURLToPath(
  new URL("../fixtures/corpus/approval-rate/", import.meta.url),
);
const POSTURE_CORPUS_PATH = fileURLToPath(
  new URL("../fixtures/packs/posture-default-corpus.json", import.meta.url),
);
const PROJECT_CWD = "/repo";
const PROJECT_SCOPE: ResolvedProjectScope = {
  roots: [PROJECT_CWD],
  writableDirectories: [PROJECT_CWD],
  tempDirectories: ["/tmp"],
  deniedDirectories: [],
  safeHomeDirectories: [],
  agentSupportDirectories: [
    "/home/nathan/.pi/agent/skills",
    "/home/nathan/.pi/agent/plugins",
    "/home/nathan/.pi/agent/extensions",
    "/home/nathan/.pi/agent/docs",
    "/home/nathan/.pi/agent/rules",
    "/home/nathan/.pi/agent/npm/node_modules",
    "/home/nathan/.pi/agent/plugin-host/stores",
  ],
  unknownPathBehavior: "review",
    sensitivePathBehavior: "review",
    homePathBehavior: "allow",
};

// The home-read baseline adds six ordinary-session rows: 48/60 = 80.0%.
// Raise this ratchet as later approval-rate stories remove evidenced friction.
const APPROVAL_RATE_THRESHOLD = 0.8;

interface ApprovalRateRow extends CorpusFixtureRow {
  readonly tool?: string;
}

interface SourcedRow {
  readonly file: string;
  readonly index: number;
  readonly row: ApprovalRateRow;
}

interface PostureRow {
  readonly command: string;
  readonly expected: "allow" | "review" | "deny";
  readonly reason: string;
  readonly file: string;
  readonly index: number;
}

interface ReplayedRow extends SourcedRow {
  readonly actual: DecisionEffect;
  readonly decisionReason: string;
}

interface ReplayResult {
  readonly rows: readonly ReplayedRow[];
  readonly approvalRows: readonly ReplayedRow[];
  readonly postureRows: readonly ReplayedRow[];
}

interface RateMetric {
  readonly allowed: number;
  readonly total: number;
  readonly rate: number;
}

const EXPECTED_EFFECTS: Readonly<Record<CorpusExpectedLabel, DecisionEffect>> =
  {
    fast_path: "allow",
    review: "review",
    hard_block: "deny",
  };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readApprovalRows(): readonly SourcedRow[] {
  const files = readdirSync(APPROVAL_RATE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return files.flatMap((file) => {
    const json = readJson(join(APPROVAL_RATE_DIR, file));
    if (!Array.isArray(json)) {
      throw new Error(`${file}: expected a top-level array`);
    }

    return json.map((value, index) => {
      const row = parseApprovalRow(value, file, index);
      return { file, index, row };
    });
  });
}

function parseApprovalRow(
  value: unknown,
  file: string,
  index: number,
): ApprovalRateRow {
  if (!isRecord(value)) {
    throw new Error(`${file}[${index}]: expected an object row`);
  }

  if (typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error(`${file}[${index}]: command must be non-empty`);
  }
  if (
    value.expected !== "fast_path" &&
    value.expected !== "review" &&
    value.expected !== "hard_block"
  ) {
    throw new Error(`${file}[${index}]: invalid expected effect`);
  }
  if (typeof value.reason !== "string" || value.reason.trim().length === 0) {
    throw new Error(`${file}[${index}]: reason must be non-empty`);
  }
  if (value.tool !== undefined && typeof value.tool !== "string") {
    throw new Error(`${file}[${index}]: tool must be a string when present`);
  }

  return {
    command: value.command,
    expected: value.expected,
    reason: value.reason,
    provenance: file,
    ...(value.tool === undefined ? {} : { tool: value.tool }),
  };
}

function readPostureRows(): readonly PostureRow[] {
  const json = readJson(POSTURE_CORPUS_PATH);
  if (!Array.isArray(json)) {
    throw new Error("posture-default-corpus.json: expected a top-level array");
  }

  return json.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`posture-default-corpus.json[${index}]: expected object`);
    }
    if (
      typeof value.command !== "string" ||
      value.command.trim().length === 0
    ) {
      throw new Error(
        `posture-default-corpus.json[${index}]: command must be non-empty`,
      );
    }
    if (
      value.expected !== "allow" &&
      value.expected !== "review" &&
      value.expected !== "deny"
    ) {
      throw new Error(
        `posture-default-corpus.json[${index}]: invalid expected effect`,
      );
    }
    if (typeof value.reason !== "string" || value.reason.trim().length === 0) {
      throw new Error(
        `posture-default-corpus.json[${index}]: reason must be non-empty`,
      );
    }

    return {
      command: value.command,
      expected: value.expected,
      reason: value.reason,
      file: "posture-default-corpus.json",
      index,
    };
  });
}

function resolvedConfig(): ResolvedConfig {
  return {
    version: 1,
    cwd: PROJECT_CWD,
    homeDirectory: "/home/nathan",
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: PROJECT_SCOPE,
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

async function shippedBaselinePolicy(
  rows: readonly SourcedRow[],
): Promise<EffectivePolicy> {
  const registeredToolNames = [
    ...new Set(
      rows
        .map(({ row }) => row.tool)
        .filter((tool): tool is string => tool !== undefined),
    ),
  ];
  const audit = createAuditLogger({ sink: createArrayAuditSink() });
  const result = await composeEffectivePolicy(resolvedConfig(), {
    audit,
    registeredToolNames,
  });

  if (!result.ok) {
    throw new Error(`default policy composition failed: ${result.reason}`);
  }
  return result.effectivePolicy;
}

async function analyzeRow(
  source: SourcedRow,
  registry: ReturnType<typeof createDefaultAnalyzerRegistry>,
): Promise<ToolShape> {
  const tool = source.row.tool ?? "bash";
  // Mirror runtime's parse -> path-fact enrichment -> decide seam so scoped
  // constructive commands and sensitive-path guards are measured faithfully.
  if (tool === "bash") {
    const shape = await analyzeBashCommand(source.row.command);
    return enrichToolShapeWithPathFacts(shape, {
      cwd: PROJECT_CWD,
      homeDirectory: "/home/nathan",
      projectScope: PROJECT_SCOPE,
    });
  }

  let input: unknown;
  try {
    input = JSON.parse(source.row.command);
  } catch (error) {
    throw new Error(
      `${source.file}[${source.index}] typed ${tool} command is not JSON: ${String(error)}`,
    );
  }

  const shape = await registry.analyze(tool, input);
  return enrichToolShapeWithPathFacts(shape, {
    cwd: PROJECT_CWD,
    homeDirectory: "/home/nathan",
    projectScope: PROJECT_SCOPE,
  });
}

async function replayRows(
  approvalRows: readonly SourcedRow[],
  postureRows: readonly PostureRow[],
  policy: EffectivePolicy,
): Promise<ReplayResult> {
  const registry = createDefaultAnalyzerRegistry();
  const rows: ReplayedRow[] = [];

  for (const source of approvalRows) {
    const shape = await analyzeRow(source, registry);
    const decision = decide(shape, policy);
    rows.push({
      ...source,
      actual: decision.effect,
      decisionReason: decision.reason,
    });
  }

  for (const posture of postureRows) {
    const source: SourcedRow = {
      file: posture.file,
      index: posture.index,
      row: {
        command: posture.command,
        expected:
          posture.expected === "allow"
            ? "fast_path"
            : posture.expected === "deny"
              ? "hard_block"
              : "review",
        reason: posture.reason,
        provenance: posture.file,
      },
    };
    const shape = await analyzeRow(source, registry);
    const decision = decide(shape, policy);
    rows.push({
      ...source,
      actual: decision.effect,
      decisionReason: decision.reason,
    });
  }

  return {
    rows,
    approvalRows: rows.slice(0, approvalRows.length),
    postureRows: rows.slice(approvalRows.length),
  };
}

function metric(rows: readonly ReplayedRow[]): RateMetric {
  const allowed = rows.filter((row) => row.actual === "allow").length;
  const total = rows.length;
  return { allowed, total, rate: total === 0 ? 0 : allowed / total };
}

function expectedEffect(row: SourcedRow): DecisionEffect {
  return EXPECTED_EFFECTS[row.row.expected];
}

function mismatches(rows: readonly ReplayedRow[]): readonly ReplayedRow[] {
  return rows.filter((row) => row.actual !== expectedEffect(row));
}

function formatRate(rate: RateMetric): string {
  return `${rate.allowed}/${rate.total} (${(rate.rate * 100).toFixed(1)}%)`;
}

function formatRates(rows: readonly ReplayedRow[]): string {
  const byFile = new Map<string, ReplayedRow[]>();
  for (const row of rows) {
    const fileRows = byFile.get(row.file) ?? [];
    fileRows.push(row);
    byFile.set(row.file, fileRows);
  }

  return [...byFile.entries()]
    .map(([file, fileRows]) => `${file}: ${formatRate(metric(fileRows))}`)
    .join("; ");
}

function formatMismatches(rows: readonly ReplayedRow[]): string {
  return rows
    .map(
      (row) =>
        `${row.file}[${row.index}] ${row.row.tool ?? "bash"} ${JSON.stringify(row.row.command)} expected ${expectedEffect(row)} but got ${row.actual}: ${row.decisionReason}`,
    )
    .join("\n");
}

describe("approval-rate corpus replay", () => {
  it("matches every ordinary-session row and maintains the measured allow-rate ratchet", async () => {
    const approvalRows = readApprovalRows();
    const postureRows = readPostureRows();
    const policy = await shippedBaselinePolicy(approvalRows);
    const result = await replayRows(approvalRows, postureRows, policy);
    const approvalRate = metric(result.approvalRows);
    const failures = mismatches(result.approvalRows);
    const report = `Measured deterministic approval rate: ${formatRate(approvalRate)}; session rates: ${formatRates(result.approvalRows)}`;

    expect(approvalRows.length).toBeGreaterThanOrEqual(30);
    expect(approvalRows.length).toBeLessThanOrEqual(60);
    expect(failures, `${report}\n${formatMismatches(failures)}`).toEqual([]);
    expect(
      approvalRate.rate,
      `${report}; threshold: ${(APPROVAL_RATE_THRESHOLD * 100).toFixed(1)}%`,
    ).toBeGreaterThanOrEqual(APPROVAL_RATE_THRESHOLD);
  });

  it("enforces the posture-default corpus against the same shipped policy", async () => {
    const approvalRows = readApprovalRows();
    const postureRows = readPostureRows();
    const policy = await shippedBaselinePolicy(approvalRows);
    const result = await replayRows(approvalRows, postureRows, policy);
    const failures = mismatches(result.postureRows);
    const report = `Posture corpus deterministic approval rate: ${formatRate(metric(result.postureRows))}; session rates: ${formatRates(result.postureRows)}`;

    expect(failures, `${report}\n${formatMismatches(failures)}`).toEqual([]);
  });

  it("keeps the approval-rate fixture provenance and typed-tool rows explicit", () => {
    const rows = readApprovalRows();
    expect(new Set(rows.map((row) => basename(row.row.provenance)))).toEqual(
      new Set([
        "explore-codebase.json",
        "implement-feature.json",
        "fix-failing-test.json",
        "format-and-commit.json",
        "docs-and-config.json",
      ]),
    );
    expect(rows.some(({ row }) => row.tool === "read")).toBe(true);
    expect(rows.some(({ row }) => row.tool === "edit")).toBe(true);
    expect(rows.some(({ row }) => row.tool === "background")).toBe(true);
    expect(rows.some(({ row }) => row.expected === "review")).toBe(true);
    expect(rows.some(({ row }) => row.expected === "hard_block")).toBe(true);
  });
});
