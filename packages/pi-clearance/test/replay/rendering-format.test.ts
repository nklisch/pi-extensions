import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  findCount,
  formatCount,
  formatPercent,
  markdownCodeBlock,
  markdownInlineCode,
  renderJsonPatchSummary,
  stableJson,
} from "../../src/replay/rendering-format.ts";

describe("rendering format helpers", () => {
  it("escapes markdown inline code with backticks and edge padding", () => {
    expect(markdownInlineCode("git status")).toBe("`git status`");
    expect(markdownInlineCode("`literal`")).toBe("`` `literal` ``");
    expect(markdownInlineCode("echo `nested` value")).toBe(
      "``echo `nested` value``",
    );
    expect(markdownInlineCode("``two``")).toBe("``` ``two`` ```");
    expect(markdownInlineCode("")).toBe("``");
  });

  it("renders fenced code blocks with a safe fence", () => {
    expect(markdownCodeBlock("const x = 1;", "ts")).toBe(
      "```ts\nconst x = 1;\n```",
    );
    expect(markdownCodeBlock("line 1\n```\nline 2", "json")).toBe(
      "````json\nline 1\n```\nline 2\n````",
    );
  });

  it("formats counts and percentages consistently", () => {
    expect(formatCount(1, "call")).toBe("1 call");
    expect(formatCount(2, "call")).toBe("2 calls");
    expect(formatCount(1, "unique command")).toBe("1 unique command");
    expect(formatCount(2, "unique command")).toBe("2 unique commands");
    expect(formatPercent(1, 4)).toBe("25.0%");
    expect(formatPercent(1, 0)).toBe("0.0%");
    expect(formatPercent(1, -1)).toBe("0.0%");
  });

  it("finds counts by label", () => {
    expect(
      findCount(
        [
          { label: "review", calls: 3, uniqueCommands: 2 },
          { label: "fast_path", calls: 5 },
        ],
        "review",
      ),
    ).toBe(3);
    expect(findCount([{ label: "review", calls: 3 }], "fast_path")).toBe(0);
  });

  it("renders deterministic JSON with sorted object keys", () => {
    expect(
      stableJson({
        b: 2,
        a: { d: 4, c: 3 },
        list: [{ z: true, y: false }],
      }),
    ).toBe(`{
  "a": {
    "c": 3,
    "d": 4
  },
  "b": 2,
  "list": [
    {
      "y": false,
      "z": true
    }
  ]
}`);
  });

  it("summarizes JSON patches with escaped pointer paths", () => {
    expect(
      renderJsonPatchSummary([
        { op: "add", path: "/packs/0/rules/-" },
        { op: "replace", path: "/literal`key" },
      ]),
    ).toEqual(["ADD `/packs/0/rules/-`", "REPLACE ``/literal`key``"]);
  });

  it("keeps low-level formatting helpers pure presentation source", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../src/replay/rendering-format.ts", import.meta.url),
      ),
      "utf8",
    );

    const forbidden: readonly [string, RegExp][] = [
      ["filesystem imports", /from\s+["'](?:node:)?fs(?:\/promises)?["']/u],
      ["Pi runtime imports", /@earendil-works\/pi|ExtensionAPI|\bpi\./u],
      [
        "config/runtime/model imports",
        /config\/|runtime\/|model-adapter|ModelAdapter/u,
      ],
      [
        "shell execution APIs",
        /(?:node:)?child_process|\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(|shell\s*:\s*true/u,
      ],
      [
        "policy interpreter",
        /policy\/interpreter|from\s+["'][^"']*interpreter/u,
      ],
    ];

    for (const [label, pattern] of forbidden) {
      expect(
        source,
        `rendering-format must not import/use ${label}`,
      ).not.toMatch(pattern);
    }
  });
});
