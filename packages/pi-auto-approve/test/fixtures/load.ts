import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EXPECTED_LABELS = ["fast_path", "review", "hard_block"] as const;
export type ExpectedLabel = (typeof EXPECTED_LABELS)[number];

export interface FixtureRow {
  readonly command: string;
  readonly expected: ExpectedLabel;
  readonly reason: string;
}

export interface CorpusFileSpec {
  readonly file: string;
  readonly expectedCount: number | null;
}

export interface CorpusEntry extends CorpusFileSpec {
  readonly rows: readonly FixtureRow[];
}

export const CORPUS_FILES = [
  { file: "pi-config-classifier.json", expectedCount: 110 },
  { file: "fork-derived.json", expectedCount: 29 },
  { file: "catalog.local.json", expectedCount: null },
] as const satisfies readonly CorpusFileSpec[];

const CORPUS_DIR = fileURLToPath(new URL("./corpus", import.meta.url));
const EXPECTED_LABEL_SET: ReadonlySet<string> = new Set(EXPECTED_LABELS);

/** Read + JSON.parse + validate one corpus file; throw on the first invalid row. */
export function readCorpusFile(file: string): readonly FixtureRow[] {
  const displayFile = basename(file);
  const parsed: unknown = JSON.parse(
    readFileSync(`${CORPUS_DIR}/${displayFile}`, "utf8"),
  );

  if (!Array.isArray(parsed)) {
    throw new Error(`${displayFile}[0]: expected top-level array`);
  }

  return parsed.map((row, index) =>
    validateFixtureRow(displayFile, index, row),
  );
}

/** Map CORPUS_FILES → CorpusEntry[] (read every corpus once). */
export function loadAllCorpus(): readonly CorpusEntry[] {
  return CORPUS_FILES.map((spec) => ({
    ...spec,
    rows: readCorpusFile(spec.file),
  }));
}

function validateFixtureRow(
  file: string,
  index: number,
  row: unknown,
): FixtureRow {
  if (!isRecord(row)) {
    throw new Error(`${file}[${index}]: expected object row`);
  }

  const command = row.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`${file}[${index}]: command must be a non-empty string`);
  }

  const expected = row.expected;
  if (!isExpectedLabel(expected)) {
    throw new Error(`${file}[${index}]: expected must be a known label`);
  }

  const reason = row.reason;
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error(`${file}[${index}]: reason must be a non-empty string`);
  }

  return { command, expected, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpectedLabel(value: unknown): value is ExpectedLabel {
  return typeof value === "string" && EXPECTED_LABEL_SET.has(value);
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
