import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexUserConfigToml } from "../../../src/formats/codex/state-reader.js";

const fixture = readFileSync(resolve("test/fixtures/adoption/codex-config.toml"), "utf8");

describe("Codex foreign-state reader", () => {
  it("reads git and local marketplace tables while ignoring known operational fields", () => {
    const result = readCodexUserConfigToml(fixture, { path: "/home/user/.codex/config.toml" });
    expect(result.items.map((item) => item.suggestedMarketplace.value)).toEqual(["github-main", "local-catalog"]);
    expect(result.items[0]!.source.value).toEqual({ kind: "git", url: "https://example.com/catalog.git", ref: "v1" });
    expect(result.items[1]!.source.value).toEqual({ kind: "local-git", path: "/home/user/catalog" });
    expect(result.items[0]!.source.provenance[0]).toMatchObject({
      location: { host: "codex", documentKind: "foreign-state", pointer: "/marketplaces/github-main/source" },
      declaration: { source_type: "git", source: "https://example.com/catalog.git", ref: "v1" },
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "UNSUPPORTED_DECLARATION", location: { pointer: "/marketplaces/sparse-catalog/sparse_paths" } });
    expect(JSON.stringify(result)).not.toContain("last_revision");
  });

  it("rejects unsafe or unsupported source semantics entry-locally", () => {
    const result = readCodexUserConfigToml([
      "[marketplaces.good]",
      'source_type = "git"',
      'source = "https://example.com/good.git"',
      "[marketplaces.bad]",
      'source_type = "git"',
      'source = "http://example.com/bad.git"',
      "[marketplaces.unknown]",
      'source_type = "hg"',
      'source = "https://example.com/unknown"',
      "[marketplaces.extra]",
      'source_type = "git"',
      'source = "https://example.com/extra.git"',
      'headers = "secret"',
    ].join("\n"), { path: "/tmp/config.toml" });
    expect(result.items.map((item) => item.suggestedMarketplace.value)).toEqual(["good"]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SOURCE_INVALID",
      "UNSUPPORTED_DECLARATION",
      "UNSUPPORTED_DECLARATION",
    ]);
  });

  it("reports malformed TOML as a document-local root diagnostic", () => {
    const result = readCodexUserConfigToml("[marketplaces.foo\nsource =", { path: "/tmp/config.toml" });
    expect(result.items).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ code: "FOREIGN_STATE_ROOT_INVALID", location: { pointer: "" } });
  });
});
