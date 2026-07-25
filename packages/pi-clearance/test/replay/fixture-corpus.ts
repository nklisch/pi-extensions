import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_CORPUS_DIR = fileURLToPath(
  new URL("../fixtures/corpus/", import.meta.url),
);

export function fixtureCorpusPaths(): readonly string[] {
  return readdirSync(FIXTURE_CORPUS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(FIXTURE_CORPUS_DIR, entry.name))
    .sort((left, right) => left.localeCompare(right));
}
