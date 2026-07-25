import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { baselinePacks } from "../../src/packs/baseline.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import type { EffectivePolicy } from "../../src/policy/core.ts";
import {
  createNativePolicyHandle,
  decideNativePolicy,
  decideNativePolicyBatch,
} from "../../src/policy/core.ts";
import { buildCorpusQueryModel } from "../../src/replay/corpus-query.ts";
import type { CorpusEntry, ReplayCorpus } from "../../src/replay/history.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORK_ITEM_PATH = join(
  REPO_ROOT,
  ".work/active/epic-rust-clearance-core-migration.md",
);
const CORPUS_ROOT = join(REPO_ROOT, "test/fixtures/corpus");
const PARSE_ROUNDS = 3;
const REPLAY_ROUNDS = 3;
const DECISION_ITERATIONS = 5_000;
const BATCH_ROUNDS = 20;

interface Measurement {
  readonly elapsedMs: number;
  readonly operations: number;
  readonly operationsPerSecond: number;
}

interface PackageSize {
  readonly packedBytes: number;
  readonly unpackedBytes: number;
  readonly fileCount: number;
}

async function main(): Promise<void> {
  const commands = await loadCommands();
  const corpus = buildCorpus(commands);
  const policy: EffectivePolicy = {
    floor: sealedFloor.rules,
    active: baselinePacks.flatMap((pack) => pack.rules),
  };

  const coldLoad = await measureColdLoad(commands[0] ?? "git status --short");
  const parseThroughput = await measureParseThroughput(commands);
  const warmDecision = await measureWarmDecision(commands[0] ?? "git status");
  const batchDecision = await measureBatchDecision(policy, commands);
  const replayThroughput = await measureReplayThroughput(corpus, policy);
  const packageSize = measurePackageSize();
  const report = formatReport({
    commands,
    corpus,
    coldLoad,
    parseThroughput,
    warmDecision,
    batchDecision,
    replayThroughput,
    packageSize,
  });

  await updateWorkItem(report);
  process.stdout.write(`${report}\n`);
}

async function loadCommands(): Promise<readonly string[]> {
  const files = readdirSync(CORPUS_ROOT)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const commands: string[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(
      await readFile(join(CORPUS_ROOT, file), "utf8"),
    );
    if (!Array.isArray(parsed)) continue;
    for (const row of parsed) {
      if (isRecord(row) && typeof row.command === "string") {
        commands.push(row.command);
      }
    }
  }
  return [...new Set(commands)];
}

function buildCorpus(commands: readonly string[]): ReplayCorpus {
  const entries: readonly CorpusEntry[] = commands.map((command, index) => ({
    command,
    toolName: "bash",
    source: "corpus",
    sources: ["corpus"],
    provenance: `s8-final-${index + 1}`,
    fidelity: "high",
  }));
  return {
    entries,
    sourceSummary: new Map([["corpus", entries.length]]),
    unmatchedAuditEntries: 0,
    warnings: [],
  };
}

async function measureColdLoad(command: string): Promise<Measurement> {
  const started = performance.now();
  await analyzeBashCommand(command);
  return measurement(performance.now() - started, 1);
}

async function measureParseThroughput(
  commands: readonly string[],
): Promise<Measurement> {
  const started = performance.now();
  let operations = 0;
  for (let round = 0; round < PARSE_ROUNDS; round += 1) {
    for (const command of commands) {
      await analyzeBashCommand(command);
      operations += 1;
    }
  }
  return measurement(performance.now() - started, operations);
}

async function measureWarmDecision(command: string): Promise<Measurement> {
  const shape = await analyzeBashCommand(command);
  const policy: EffectivePolicy = {
    floor: sealedFloor.rules,
    active: baselinePacks.flatMap((pack) => pack.rules),
  };
  const handle = createNativePolicyHandle(policy);
  for (let index = 0; index < 100; index += 1) {
    decideNativePolicy(handle, shape);
  }
  const started = performance.now();
  for (let index = 0; index < DECISION_ITERATIONS; index += 1) {
    decideNativePolicy(handle, shape);
  }
  handle.free();
  return measurement(performance.now() - started, DECISION_ITERATIONS);
}

async function measureBatchDecision(
  policy: EffectivePolicy,
  commands: readonly string[],
): Promise<Measurement> {
  const shapes = await Promise.all(
    commands.map((command) => analyzeBashCommand(command)),
  );
  const handle = createNativePolicyHandle(policy);
  const started = performance.now();
  let operations = 0;
  for (let round = 0; round < BATCH_ROUNDS; round += 1) {
    const decisions = decideNativePolicyBatch(handle, shapes);
    if (decisions.length !== shapes.length) {
      throw new Error("native batch decision returned an incomplete result");
    }
    operations += decisions.length;
  }
  handle.free();
  return measurement(performance.now() - started, operations);
}

async function measureReplayThroughput(
  corpus: ReplayCorpus,
  policy: EffectivePolicy,
): Promise<Measurement> {
  const started = performance.now();
  let operations = 0;
  let model: Awaited<ReturnType<typeof buildCorpusQueryModel>> | undefined;
  for (let round = 0; round < REPLAY_ROUNDS; round += 1) {
    model = await buildCorpusQueryModel(corpus, policy);
    operations += model.records.length;
  }
  if (model === undefined || model.records.length !== corpus.entries.length) {
    throw new Error("S8 replay benchmark built an incomplete corpus model");
  }
  return measurement(performance.now() - started, operations);
}

function measurePackageSize(): PackageSize {
  const destination = mkdtempSync(join(tmpdir(), "pi-clearance-s8-pack-"));
  try {
    const output = execFileSync(
      "pnpm",
      ["pack", "--dry-run", "--json", "--silent"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const parsed: unknown = JSON.parse(output);
    const pack = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!isRecord(pack) || !Array.isArray(pack.files)) {
      throw new Error("pnpm pack returned no package metadata");
    }
    const files = pack.files.filter(
      (file): file is Record<string, unknown> =>
        isRecord(file) && typeof file.path === "string",
    );
    const pathsFile = join(destination, "files.txt");
    const archive = join(destination, "pi-clearance-s8.tgz");
    const paths = files.map((file) => file.path as string);
    writeFileSync(pathsFile, `${paths.join("\n")}\n`, "utf8");
    execFileSync(
      "tar",
      ["-czf", archive, "-C", REPO_ROOT, "--files-from", pathsFile],
      { encoding: "utf8" },
    );
    return {
      packedBytes: statSync(archive).size,
      unpackedBytes: files.reduce(
        (total, file) =>
          total + statSync(join(REPO_ROOT, file.path as string)).size,
        0,
      ),
      fileCount: files.length,
    };
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function formatReport(input: {
  readonly commands: readonly string[];
  readonly corpus: ReplayCorpus;
  readonly coldLoad: Measurement;
  readonly parseThroughput: Measurement;
  readonly warmDecision: Measurement;
  readonly batchDecision: Measurement;
  readonly replayThroughput: Measurement;
  readonly packageSize: PackageSize;
}): string {
  const measuredAt = new Date().toISOString();
  return [
    "## S8 final benchmark report",
    "",
    `Measured: ${measuredAt} on ${process.platform}/${process.arch}, Node ${process.version}.`,
    "Implementation: native parser, Rust matcher IR, native replay kernels, and optional-package prebuild loader.",
    `Corpus: ${input.corpus.entries.length} recorded rows, ${input.commands.length} unique commands from test/fixtures/corpus/*.json; ${REPLAY_ROUNDS} replay builds and ${PARSE_ROUNDS} parse rounds.`,
    "",
    "| Metric | S0 TypeScript baseline | S8 native |",
    "| --- | ---: | ---: |",
    `| Cold load + first parse | 12.90 ms | ${formatMs(input.coldLoad.elapsedMs)} |`,
    `| Warm decision latency (${input.warmDecision.operations.toLocaleString()} decisions) | 21.64 µs/op | ${formatUs(input.warmDecision.elapsedMs, input.warmDecision.operations)} |`,
    `| Batched decision latency (${input.batchDecision.operations.toLocaleString()} decisions, ${input.commands.length} per crossing) | n/a | ${formatUs(input.batchDecision.elapsedMs, input.batchDecision.operations)} |`,
    `| Parse throughput (${input.parseThroughput.operations.toLocaleString()} parses) | 22,634 ops/s | ${formatRate(input.parseThroughput)} |`,
    `| Replay throughput (${input.replayThroughput.operations.toLocaleString()} modeled rows) | 8,900 ops/s | ${formatRate(input.replayThroughput)} |`,
    `| Root package size (packed / unpacked, ${input.packageSize.fileCount} files) | 494.0 KiB / 2.14 MiB | ${formatBytes(input.packageSize.packedBytes)} / ${formatBytes(input.packageSize.unpackedBytes)} |`,
    "| Platform package shape | source TypeScript only | linux-x64-gnu + darwin-arm64 optional packages; release preparation fails if either artifact is absent |",
    "",
    "The S7 residual was measured as native matcher evaluation plus the synchronous JSON shape/decision boundary. S8 compiles common matcher fields and regular expressions into Rust-owned IR and adds a batch decision seam that amortizes that boundary for grouped callers. Native replay already stays inside Rust, so its crossing is amortized over the entire corpus.",
  ].join("\n");
}

async function updateWorkItem(report: string): Promise<void> {
  const current = await readFile(WORK_ITEM_PATH, "utf8");
  const marker = "\n## S8 final benchmark report";
  const base = current.includes(marker)
    ? current.slice(0, current.indexOf(marker)).trimEnd()
    : current.trimEnd();
  await writeFile(WORK_ITEM_PATH, `${base}\n\n${report}\n`);
}

function measurement(elapsedMs: number, operations: number): Measurement {
  return {
    elapsedMs,
    operations,
    operationsPerSecond:
      elapsedMs === 0
        ? Number.POSITIVE_INFINITY
        : (operations * 1000) / elapsedMs,
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatUs(value: number, operations: number): string {
  return `${((value * 1000) / operations).toFixed(2)} µs/op`;
}

function formatRate(value: Measurement): string {
  return `${Math.round(value.operationsPerSecond).toLocaleString()} ops/s (${formatMs(value.elapsedMs)})`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
