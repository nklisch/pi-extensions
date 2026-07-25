import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readClaudeKnownMarketplacesJson,
  readClaudeUserSettingsJson,
} from "../../../src/formats/claude/state-reader.js";

const fixture = (name: string) => readFileSync(resolve("test/fixtures/adoption", name), "utf8");

describe("Claude foreign-state readers", () => {
  it("reads only supported source declarations and retains exact provenance", () => {
    const result = readClaudeKnownMarketplacesJson(fixture("claude-known-marketplaces.json"), {
      path: "/home/user/.claude/plugins/known_marketplaces.json",
    });
    expect(result.items.map((item) => item.suggestedMarketplace.value)).toEqual([
      "git-catalog",
      "github-main",
      "local-catalog",
    ]);
    expect(result.items[1]!.source.value).toEqual({ kind: "github", repository: "owner/catalog", ref: "main" });
    expect(result.items[1]!.source.provenance[0]).toMatchObject({
      location: {
        host: "claude",
        documentKind: "foreign-state",
        path: "/home/user/.claude/plugins/known_marketplaces.json",
        pointer: "/github-main/source",
      },
      declaration: { source: "github", repo: "owner/catalog", ref: "main" },
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "UNSUPPORTED_DECLARATION", location: { pointer: "/unsupported-lfs/source/skipLfs" } });
    expect(JSON.stringify(result)).not.toContain("installLocation");
  });

  it("reads only extraKnownMarketplaces from settings", () => {
    const result = readClaudeUserSettingsJson(fixture("claude-settings.json"), {
      path: "/home/user/.claude/settings.json",
    });
    expect(result.items.map((item) => item.suggestedMarketplace.value)).toEqual(["github-main"]);
    expect(result.items[0]!.source.provenance[0]!.location.pointer).toBe("/github-main/source");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "UNSUPPORTED_DECLARATION", location: { pointer: "/unsupported-inline/settings" } });
  });

  it("reports malformed roots without throwing or exposing parser causes", () => {
    const result = readClaudeKnownMarketplacesJson("[]", { path: "/tmp/state.json" });
    expect(result.items).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ code: "FOREIGN_STATE_ROOT_INVALID", location: { pointer: "" } });
    expect(result.diagnostics[0]).not.toHaveProperty("cause");
  });
});
