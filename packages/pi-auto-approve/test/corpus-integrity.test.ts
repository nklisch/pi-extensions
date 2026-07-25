import { describe, expect, it } from "vitest";

import type { FixtureRow } from "./fixtures/load.ts";
import { EXPECTED_LABELS, loadAllCorpus } from "./fixtures/load.ts";

const CATALOG_FILE = "catalog.local.json";
const CATALOG_MINIMUM_ROWS = 12;

const corpusEntries = loadAllCorpus();
const fixtureCases = corpusEntries.flatMap((entry) =>
  entry.rows.map((row, index) => ({ file: entry.file, index, row })),
);

describe("corpus integrity", () => {
  it("matches pinned corpus counts and the catalog floor", () => {
    for (const entry of corpusEntries) {
      if (entry.expectedCount !== null) {
        expect(entry.rows.length, entry.file).toBe(entry.expectedCount);
      }
    }

    const catalog = corpusEntries.find((entry) => entry.file === CATALOG_FILE);
    expect(catalog, CATALOG_FILE).toBeDefined();
    expect(catalog?.rows.length, CATALOG_FILE).toBeGreaterThanOrEqual(
      CATALOG_MINIMUM_ROWS,
    );
  });

  it.each(fixtureCases)("$file[$index] has a legal label and required text", ({
    row,
  }: {
    row: FixtureRow;
  }) => {
    expect(EXPECTED_LABELS).toContain(row.expected);
    expect(typeof row.command).toBe("string");
    expect(row.command.length).toBeGreaterThan(0);
    expect(typeof row.reason).toBe("string");
    expect(row.reason.length).toBeGreaterThan(0);
  });

  it("contains at least one row for every expected label", () => {
    const observedLabels = new Set(fixtureCases.map(({ row }) => row.expected));

    for (const label of EXPECTED_LABELS) {
      expect(observedLabels.has(label), label).toBe(true);
    }
  });
});
