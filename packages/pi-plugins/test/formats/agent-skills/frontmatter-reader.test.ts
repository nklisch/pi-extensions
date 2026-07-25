import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRONTMATTER_LIMITS,
  readBoundedFrontmatter,
  readBoundedYaml,
} from "../../../src/formats/agent-skills/frontmatter-reader.js";
import { type Provenance } from "../../../src/domain/provenance.js";

const provenance: Provenance = {
  location: {
    host: "codex",
    documentKind: "skill",
    path: "skills/demo/SKILL.md",
    pointer: "",
  },
};
const fixture = (name: string): string => readFileSync(
  new URL(`../../fixtures/plugins/adversarial-skills/${name}`, import.meta.url),
).toString("utf8");

function hash(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

void hash;

describe("bounded YAML frontmatter", () => {
  it("extracts folded Agent Skills YAML and leaves the body untouched", () => {
    const result = readBoundedFrontmatter(
      "---\nname: demo\ndescription: >\n  folded\n  description\n---\n# body\n",
      provenance,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        attributes: { name: "demo", description: "folded description\n" },
        body: "# body\n",
      },
      diagnostics: [],
    });
  });

  it("does not treat quoted or block-scalar brackets as YAML collection depth", () => {
    const brackets = "[".repeat(32);
    const result = readBoundedFrontmatter(
      `---\nname: demo\nquoted: "${brackets}"\ndescription: |\n  ${brackets}\n---\n# body\n`,
      provenance,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects unsafe YAML constructs without returning partial attributes", () => {
    for (const name of ["anchors.md", "tags.md", "merge.md", "duplicate.md", "prototype-key.md", "multidocument.md", "unterminated.md"]) {
      const result = readBoundedFrontmatter(fixture(name), provenance);
      expect(result.ok, name).toBe(false);
      expect(result).not.toHaveProperty("value");
    }
  });

  it("rejects non-string mapping keys", () => {
    const result = readBoundedFrontmatter("---\n1: unsafe\nname: demo\ndescription: demo\n---\n", provenance);
    expect(result.ok).toBe(false);
  });

  it("rejects lone surrogates as invalid UTF-8", () => {
    const result = readBoundedFrontmatter("---\nname: bad\ndescription: \ud800\n---\n", provenance);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ diagnostics: [{ code: "SCHEMA_INVALID" }] });
  });

  it("enforces document, frontmatter, line, depth, node, and scalar limits", () => {
    const cases: Array<[string, Partial<typeof DEFAULT_FRONTMATTER_LIMITS>]> = [
      ["---\nname: demo\ndescription: text\n---\n", { maxDocumentBytes: 10 }],
      ["---\nname: demo\ndescription: text\n---\n", { maxFrontmatterBytes: 3 }],
      ["---\na: 1\nb: 2\n---\n", { maxFrontmatterLines: 1 }],
      ["---\na:\n  b:\n    c:\n      d:\n        e:\n          f:\n            g:\n              h: i\n---\n", { maxDepth: 4 }],
      ["---\na: 1\nb: 2\nc: 3\n---\n", { maxNodes: 2 }],
      ["---\na: 12345\n---\n", { maxScalarBytes: 3 }],
    ];
    for (const [markdown, limits] of cases) {
      expect(readBoundedFrontmatter(markdown, provenance, limits).ok).toBe(false);
    }
  });

  it("rejects duplicate YAML documents in the generic bounded parser", () => {
    const result = readBoundedYaml("---\na: 1\n---\nb: 2\n", provenance);
    expect(result.ok).toBe(false);
  });

  it("rejects adversarial nesting in a child process without stack exhaustion", () => {
    const child = spawnSync(process.execPath, [
      new URL("../../fixtures/agent-skills/deep-frontmatter-child.mjs", import.meta.url).pathname,
    ], {
      cwd: new URL("../../../", import.meta.url),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child, child.stderr).toMatchObject({ status: 0, signal: null });
    expect(child.stdout).toContain('"code":"SCHEMA_INVALID"');
    expect(`${child.stdout}${child.stderr}`).not.toMatch(/(?:call stack|stack overflow|RangeError)/i);
  });
});
