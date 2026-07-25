import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
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
} from "../../src/policy/core.ts";
import {
  buildCorpusQueryModel,
  type CorpusQueryModel,
} from "../../src/replay/corpus-query.ts";
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

interface Measurement {
  readonly elapsedMs: number;
  readonly operations: number;
  readonly operationsPerSecond: number;
}

interface PackSize {
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
  const replayThroughput = await measureReplayThroughput(corpus, policy);
  const packageSize = measurePackageSize();
  const report = formatReport({
    commands,
    corpus,
    coldLoad,
    parseThroughput,
    warmDecision,
    replayThroughput,
    packageSize,
  });

  await updateWorkItem(report);
  process.stdout.write(`${report}\n`);
}

async function loadCommands(): Promise<readonly string[]> {
  const files = (await readdir(CORPUS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
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
    provenance: `s0-baseline-${index + 1}`,
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

async function measureReplayThroughput(
  corpus: ReplayCorpus,
  policy: EffectivePolicy,
): Promise<Measurement> {
  const started = performance.now();
  let operations = 0;
  let model: CorpusQueryModel | undefined;
  for (let round = 0; round < REPLAY_ROUNDS; round += 1) {
    model = await buildCorpusQueryModel(corpus, policy);
    operations += model.records.length;
  }
  // Keep the value observable so an optimizing runtime cannot discard the work.
  if (model === undefined || model.records.length !== corpus.entries.length) {
    throw new Error("S0 replay benchmark built an incomplete corpus model");
  }
  return measurement(performance.now() - started, operations);
}

function measurePackageSize(): PackSize {
  const destination = mkdtempSync(join(tmpdir(), "pi-clearance-s0-pack-"));
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
    // S0 must preserve the pre-cutover TS package baseline. The native binary
    // is a spine artifact, not a migrated decision implementation, so exclude
    // it from this baseline while retaining native files in the real package.
    const files = pack.files.filter(
      (file): file is Record<string, unknown> =>
        isRecord(file) &&
        typeof file.path === "string" &&
        !file.path.startsWith("native/"),
    );
    const pathsFile = join(destination, "files.txt");
    const archive = join(destination, "pi-clearance-ts-baseline.tgz");
    const paths = files.map((file) => file.path as string);
    writeFileSync(pathsFile, `${paths.join("\n")}\n`, "utf8");
    execFileSync(
      "tar",
      ["-czf", archive, "-C", REPO_ROOT, "--files-from", pathsFile],
      { encoding: "utf8" },
    );
    const unpackedBytes = files.reduce(
      (total, file) =>
        total + statSync(join(REPO_ROOT, file.path as string)).size,
      0,
    );

    return {
      packedBytes: statSync(archive).size,
      unpackedBytes,
      fileCount: files.length,
    };
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
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

function formatReport(input: {
  readonly commands: readonly string[];
  readonly corpus: ReplayCorpus;
  readonly coldLoad: Measurement;
  readonly parseThroughput: Measurement;
  readonly warmDecision: Measurement;
  readonly replayThroughput: Measurement;
  readonly packageSize: PackSize;
}): string {
  const measuredAt = new Date().toISOString();
  return [
    "## S7 native replay benchmark",
    "",
    `Measured: ${measuredAt} on ${process.platform}/${process.arch}, Node ${process.version}.`,
    "Implementation: native replay kernels with native parser/enrichment and compiled-policy handles.",
    `Corpus: ${input.corpus.entries.length} recorded rows, ${input.commands.length} unique commands from test/fixtures/corpus/*.json; ${REPLAY_ROUNDS} replay builds and ${PARSE_ROUNDS} parse rounds.`,
    "",
    "| Metric | Measurement |",
    "| --- | ---: |",
    `| Native cold parser load + first parse | ${formatMs(input.coldLoad.elapsedMs)} |`,
    `| Native warm decision latency (${input.warmDecision.operations.toLocaleString()} decisions) | ${formatUs(input.warmDecision.elapsedMs, input.warmDecision.operations)} (aggregate ${formatMs(input.warmDecision.elapsedMs)}) |`,
    `| Native parse throughput (${input.parseThroughput.operations.toLocaleString()} parses) | ${formatRate(input.parseThroughput)} |`,
    `| Native replay throughput (${input.replayThroughput.operations.toLocaleString()} modeled rows) | ${formatRate(input.replayThroughput)} |`,
    `| npm package size (native artifact excluded; packed / unpacked, ${input.packageSize.fileCount} files) | ${formatBytes(input.packageSize.packedBytes)} / ${formatBytes(input.packageSize.unpackedBytes)} |`,
    "",
    "This is an S7 observation, not a performance gate. Native-vs-TS replay throughput is recorded against the S0 reference below; final end-to-end measurements remain an S8 gate.",
  ].join("\n");
}

async function updateWorkItem(report: string): Promise<void> {
  const current = await readFile(WORK_ITEM_PATH, "utf8");
  const marker = "\n## S7 native replay benchmark";
  const base = current.includes(marker)
    ? current.slice(0, current.indexOf(marker)).trimEnd()
    : current.trimEnd();
  await writeFile(WORK_ITEM_PATH, `${base}\n\n${report}\n`, "utf8");
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatUs(measurementValue: number, operations: number): string {
  return `${((measurementValue * 1000) / operations).toFixed(2)} µs/op`;
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
