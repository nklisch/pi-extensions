import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createFileCorpusFixtureSource,
  parseCorpusRows,
} from "../../src/replay/sources/corpus-fixtures.ts";

const CORPUS_DIR = fileURLToPath(
  new URL("../fixtures/corpus/", import.meta.url),
);
const SHIPPED_CORPUS_FILES = [
  "pi-config-classifier.json",
  "fork-derived.json",
  "catalog.local.json",
] as const;

function readJsonFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8"));
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-auto-approve-corpus-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("corpus fixture source", () => {
  it("parses shipped corpus fixtures cleanly with basename provenance", () => {
    let expectedTotal = 0;

    for (const file of SHIPPED_CORPUS_FILES) {
      const result = parseCorpusRows(readJsonFixture(file), file);

      expect(result.warnings).toEqual([]);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((row) => row.provenance === file)).toBe(true);
      expect(
        result.items.every(
          (row) =>
            row.expected === "fast_path" ||
            row.expected === "review" ||
            row.expected === "hard_block",
        ),
      ).toBe(true);
      expectedTotal += result.items.length;
    }

    const source = createFileCorpusFixtureSource({
      paths: SHIPPED_CORPUS_FILES.map((file) => join(CORPUS_DIR, file)),
    });
    const readResult = source.read();

    expect(readResult.warnings).toEqual([]);
    expect(readResult.items).toHaveLength(expectedTotal);
    expect(new Set(readResult.items.map((row) => row.provenance))).toEqual(
      new Set(SHIPPED_CORPUS_FILES),
    );
  });

  it("skips invalid rows with one warning per rejected row", () => {
    const result = parseCorpusRows(
      [
        {
          command: "git status --short",
          expected: "fast_path",
          reason: "read-only git",
        },
        null,
        { expected: "review", reason: "missing command" },
        { command: "", expected: "review", reason: "empty command" },
        { command: "pnpm test", expected: "allow", reason: "bad label" },
        { command: "pnpm test", expected: "review", reason: "" },
        {
          command: "pnpm test",
          expected: "review",
          reason: "extra metadata does not belong in corpus rows",
          provenance: "inline",
        },
      ],
      "/tmp/adversarial.json",
    );

    expect(result.items).toEqual([
      {
        command: "git status --short",
        expected: "fast_path",
        reason: "read-only git",
        provenance: "adversarial.json",
      },
    ]);
    expect(result.warnings).toEqual([
      "adversarial.json[1]: expected object row",
      "adversarial.json[2]: missing key(s): command",
      "adversarial.json[3]: command must be a non-empty string",
      "adversarial.json[4]: expected must be fast_path, review, or hard_block",
      "adversarial.json[5]: reason must be a non-empty string",
      "adversarial.json[6]: unexpected key(s): provenance",
    ]);
  });

  it("returns an empty result with a single warning for non-array top-level JSON", () => {
    const result = parseCorpusRows({ rows: [] }, "not-array.json");

    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([
      "not-array.json: expected top-level array",
    ]);
  });

  it("continues across unreadable or malformed files", async () => {
    await withTempDir(async (dir) => {
      const good = join(dir, "good.json");
      const malformed = join(dir, "malformed.json");
      const missing = join(dir, "missing.json");
      await writeFile(
        good,
        JSON.stringify([
          {
            command: "pnpm check",
            expected: "review",
            reason: "project-local verification command",
          },
        ]),
        "utf8",
      );
      await writeFile(malformed, "{not json", "utf8");

      const result = createFileCorpusFixtureSource({
        paths: [malformed, good, missing],
      }).read();

      expect(result.items).toEqual([
        {
          command: "pnpm check",
          expected: "review",
          reason: "project-local verification command",
          provenance: "good.json",
        },
      ]);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toContain(
        `could not read corpus file ${malformed}`,
      );
      expect(result.warnings[1]).toContain(
        `could not read corpus file ${missing}`,
      );
    });
  });
});
