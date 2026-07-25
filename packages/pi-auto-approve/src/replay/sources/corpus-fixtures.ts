import { readFileSync } from "node:fs";

import type {
  CorpusExpectedLabel,
  CorpusFixtureRow,
  CorpusFixtureSource,
  SourceReadResult,
} from "../history.ts";

const EXPECTED_LABELS: readonly CorpusExpectedLabel[] = [
  "fast_path",
  "review",
  "hard_block",
];
const EXPECTED_LABEL_SET: ReadonlySet<string> = new Set(EXPECTED_LABELS);
const REQUIRED_ROW_KEYS = ["command", "expected", "reason"] as const;
const REQUIRED_ROW_KEY_SET: ReadonlySet<string> = new Set(REQUIRED_ROW_KEYS);

export interface CorpusFileSourceOptions {
  /** One or more saved corpus JSON files using the REFERENCE_PATTERNS vocabulary. */
  readonly paths: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpectedLabel(value: unknown): value is CorpusExpectedLabel {
  return typeof value === "string" && EXPECTED_LABEL_SET.has(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

function warningMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function validateRowKeys(row: Record<string, unknown>): string | undefined {
  const keys = Object.keys(row);
  const extraKeys = keys.filter((key) => !REQUIRED_ROW_KEY_SET.has(key));
  if (extraKeys.length > 0) {
    return `unexpected key(s): ${extraKeys.join(", ")}`;
  }

  const missingKeys = REQUIRED_ROW_KEYS.filter((key) => !(key in row));
  if (missingKeys.length > 0) {
    return `missing key(s): ${missingKeys.join(", ")}`;
  }

  return undefined;
}

function validateCorpusRow(
  row: unknown,
  provenance: string,
): CorpusFixtureRow | string {
  if (!isRecord(row)) {
    return "expected object row";
  }

  const keyError = validateRowKeys(row);
  if (keyError !== undefined) {
    return keyError;
  }

  if (!isNonEmptyString(row.command)) {
    return "command must be a non-empty string";
  }

  if (!isExpectedLabel(row.expected)) {
    return "expected must be fast_path, review, or hard_block";
  }

  if (!isNonEmptyString(row.reason)) {
    return "reason must be a non-empty string";
  }

  return {
    command: row.command,
    expected: row.expected,
    reason: row.reason,
    provenance,
  };
}

/** Parse and validate one saved corpus file's rows, skipping bad rows with warnings. */
export function parseCorpusRows(
  json: unknown,
  provenance: string,
): SourceReadResult<CorpusFixtureRow> {
  const file = basename(provenance);
  if (!Array.isArray(json)) {
    return {
      items: [],
      warnings: [`${file}: expected top-level array`],
    };
  }

  const items: CorpusFixtureRow[] = [];
  const warnings: string[] = [];

  for (const [index, row] of json.entries()) {
    const result = validateCorpusRow(row, file);
    if (typeof result === "string") {
      warnings.push(`${file}[${index}]: ${result}`);
      continue;
    }

    items.push(result);
  }

  return { items, warnings };
}

export function createFileCorpusFixtureSource(
  options: CorpusFileSourceOptions,
): CorpusFixtureSource {
  const paths = [...options.paths];

  return {
    path: paths.join(","),
    read(): SourceReadResult<CorpusFixtureRow> {
      const items: CorpusFixtureRow[] = [];
      const warnings: string[] = [];

      if (paths.length === 0) {
        return {
          items,
          warnings: ["no corpus fixture paths provided"],
        };
      }

      for (const path of paths) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
          warnings.push(
            `could not read corpus file ${path}: ${warningMessage(error)}`,
          );
          continue;
        }

        const result = parseCorpusRows(parsed, basename(path));
        items.push(...result.items);
        warnings.push(...result.warnings);
      }

      return { items, warnings };
    },
  };
}
