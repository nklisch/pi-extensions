import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readClaudeMarketplaceJson } from "../../src/formats/claude/marketplace-reader.js";
import { readCodexMarketplaceJson } from "../../src/formats/codex/marketplace-reader.js";
import { mergeMarketplaces } from "../../src/formats/marketplace-merger.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/marketplaces");

function fixture(relativePath: string): string {
  return readFileSync(resolve(fixtureRoot, relativePath), "utf8");
}

describe("committed marketplace fixtures", () => {
  it("normalizes every Claude fixture with source and metadata provenance", () => {
    const valid = readClaudeMarketplaceJson(fixture("claude-valid.json"));
    expect(valid.diagnostics).toEqual([]);
    expect(valid.marketplace.name.value).toBe("nklisch-skills");
    expect(valid.marketplace.sourceDocuments[0]?.location).toMatchObject({
      host: "claude",
      path: ".claude-plugin/marketplace.json",
      pointer: "",
    });
    expect(valid.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "workflow",
      "krometrail",
    ]);
    const workflow = valid.marketplace.entries[0]!;
    expect(workflow.identity.provenance.map((claim) => claim.location.pointer)).toEqual([
      "/name",
      "/plugins/0/name",
    ]);
    expect(workflow.metadata.map((metadata) => metadata.key)).toEqual([
      "claude.category",
      "claude.tags",
    ]);
    expect(workflow.metadata.map((metadata) => metadata.claimed.value)).toEqual([
      "productivity",
      ["workflow"],
    ]);
    expect(workflow.metadata[0]?.claimed.provenance[0]?.location.pointer).toBe("/plugins/0/category");
    expect(workflow.metadata[1]?.claimed.provenance[0]?.location.pointer).toBe("/plugins/0/tags");
    expect(valid.marketplace.entries[1]?.source.value).toEqual({
      kind: "git-subdir",
      url: "https://github.com/nklisch/krometrail",
      path: "plugin",
    });
    expect(valid.marketplace.entries[1]?.source.provenance[0]?.declaration).toMatchObject({
      source: "git-subdir",
      path: "plugin",
    });
    expect(valid.marketplace.entries[1]?.rawDeclaration.provenance[0]?.location.pointer).toBe("/plugins/1");

    const partial = readClaudeMarketplaceJson(fixture("claude-partial.json"));
    expect(partial.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "good",
      "good-sibling",
    ]);
    expect(partial.diagnostics.map((diagnostic) => diagnostic.location?.pointer)).toEqual([
      "/plugins/1/source",
      "/plugins/2/hooks",
    ]);
  });

  it("normalizes every Codex fixture with policy, presentation, and diagnostics", () => {
    const valid = readCodexMarketplaceJson(fixture("codex-valid.json"));
    expect(valid.diagnostics).toEqual([]);
    expect(valid.marketplace.name.value).toBe("codex-catalog");
    expect(valid.marketplace.metadata[0]).toMatchObject({
      key: "codex.interface",
      claimed: { value: { displayName: "Codex Catalog" } },
    });
    expect(valid.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "local-plugin",
      "remote-plugin",
      "claude-compatible",
    ]);
    expect(valid.marketplace.entries[0]?.metadata.map((metadata) => metadata.key)).toEqual([
      "codex.category",
      "codex.interface",
    ]);
    expect(valid.marketplace.entries[0]?.policy?.availability.value).toBe("available");
    expect(valid.marketplace.entries[1]?.source.value).toMatchObject({
      kind: "git-subdir",
      path: "plugin",
    });
    expect(valid.marketplace.entries[1]?.declarations[0]?.declaration.value).toEqual(["./skills"]);

    const partial = readCodexMarketplaceJson(fixture("codex-partial.json"));
    expect(partial.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "good",
      "good-sibling",
    ]);
    expect(partial.diagnostics.map((diagnostic) => diagnostic.location?.pointer)).toEqual([
      "/plugins/1/policy",
      "/plugins/2/policy/installation",
      "/plugins/3/strict",
      "/plugins/4/hooks",
    ]);
  });

  it("executes both committed dual-catalog fixture pairs through the merger", () => {
    const equivalentClaude = readClaudeMarketplaceJson(fixture("dual-equivalent/claude.json"));
    const equivalentCodex = readCodexMarketplaceJson(fixture("dual-equivalent/codex.json"));
    const equivalent = mergeMarketplaces([
      { nativeHost: "codex", result: equivalentCodex },
      { nativeHost: "claude", result: equivalentClaude },
    ]);
    expect(equivalent.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "claude-only",
      "codex-only",
      "shared",
    ]);
    const shared = equivalent.marketplace.entries.find((entry) => entry.identity.value.marketplaceEntryName === "shared")!;
    expect(shared.source.value).toEqual({ kind: "marketplace-path", path: "./plugins/shared" });
    expect(shared.source.provenance.map((claim) => claim.location.host)).toEqual(["claude", "codex"]);
    expect(shared.declarations.map((declaration) => declaration.field)).toEqual(["skills", "dependencies"]);

    const conflictingClaude = readClaudeMarketplaceJson(fixture("dual-conflicting/claude.json"));
    const conflictingCodex = readCodexMarketplaceJson(fixture("dual-conflicting/codex.json"));
    const conflicting = mergeMarketplaces([
      { nativeHost: "claude", result: conflictingClaude },
      { nativeHost: "codex", result: conflictingCodex },
    ]);
    expect(conflicting.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "claude-only",
      "codex-only",
    ]);
    expect(conflicting.diagnostics).toHaveLength(1);
    expect(conflicting.diagnostics[0]).toMatchObject({
      code: "CLAIM_CONFLICT",
      plugin: "shared@shared-catalog",
      details: { field: "source" },
    });
  });
});
