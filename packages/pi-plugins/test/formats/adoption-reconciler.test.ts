import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reconcileAdoptionDeclarations } from "../../src/domain/adoption.js";
import { readClaudeKnownMarketplacesJson } from "../../src/formats/claude/state-reader.js";
import { readCodexUserConfigToml } from "../../src/formats/codex/state-reader.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

describe("adoption reconciliation", () => {
  it("merges equivalent cross-host declarations and sorts candidates by id", () => {
    const claude = readClaudeKnownMarketplacesJson(JSON.stringify({
      shared: { source: { source: "git", url: "HTTPS://Example.COM:443/catalog.git", ref: "main" } },
    }), { path: "/home/user/.claude/plugins/known_marketplaces.json" });
    const codex = readCodexUserConfigToml([
      "[marketplaces.shared]",
      'source_type = "git"',
      'source = "https://example.com/catalog.git"',
      'ref = "main"',
    ].join("\n"), { path: "/home/user/.codex/config.toml" });
    const result = reconcileAdoptionDeclarations([...claude.items, ...codex.items], sha256);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.nativeHosts).toEqual(["claude", "codex"]);
    expect(result.items[0]!.source.provenance.map((claim) => claim.location.host)).toEqual(["claude", "codex"]);
    expect(result.items[0]!.suggestedMarketplaces).toHaveLength(1);
  });

  it("does not treat equal aliases in different foreign hosts as conflicts", () => {
    const claude = readClaudeKnownMarketplacesJson(JSON.stringify({
      same: { source: { source: "github", repo: "owner/one" } },
    }), { path: "/home/user/.claude/plugins/known_marketplaces.json" });
    const codex = readCodexUserConfigToml([
      "[marketplaces.same]",
      'source_type = "git"',
      'source = "https://example.com/two.git"',
    ].join("\n"), { path: "/home/user/.codex/config.toml" });
    const result = reconcileAdoptionDeclarations([...claude.items, ...codex.items], sha256);
    expect(result.items).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
  });
});
