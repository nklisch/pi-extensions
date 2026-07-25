import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AdoptionCandidateIdSchema,
  AdoptionCandidateSchema,
  AdoptionDeclarationSchema,
  deriveAdoptionCandidateId,
  reconcileAdoptionDeclarations,
} from "../../src/domain/adoption.js";
import { serializeMarketplaceSource, type Sha256 } from "../../src/domain/source.js";
import { readClaudeKnownMarketplacesJson } from "../../src/formats/claude/state-reader.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const context = { path: "/home/test/.claude/plugins/known_marketplaces.json" };

describe("adoption domain contracts", () => {
  it("derives a versioned id from canonical source bytes", () => {
    const source = { kind: "github", repository: "owner/catalog", ref: "main" } as const;
    const id = deriveAdoptionCandidateId(source, sha256);
    expect(AdoptionCandidateIdSchema.safeParse(id).success).toBe(true);
    expect(id).toBe(`adoption-v1:sha256:${createHash("sha256").update(serializeMarketplaceSource(source)).digest("hex")}`);
  });

  it("requires source-located declarations and candidates", () => {
    expect(AdoptionDeclarationSchema.safeParse({}).success).toBe(false);
    expect(AdoptionCandidateSchema.safeParse({}).success).toBe(false);
  });

  it("merges equivalent sources deterministically and preserves all host claims", () => {
    const known = readClaudeKnownMarketplacesJson(JSON.stringify({
      catalog: { source: { source: "github", repo: "owner/catalog", ref: "main" } },
    }), context);
    const settings = readClaudeKnownMarketplacesJson(JSON.stringify({
      catalog: { source: { source: "github", repo: "owner/catalog", ref: "main" } },
    }), { path: "/home/test/.claude/settings.json" });
    expect(known.items).toHaveLength(1);
    expect(settings.items).toHaveLength(1);
    const result = reconcileAdoptionDeclarations([
      settings.items[0]!,
      known.items[0]!,
    ], sha256);
    expect(result.diagnostics).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.source.provenance).toHaveLength(2);
    expect(result.items[0]!.nativeHosts).toEqual(["claude"]);
    expect(result.items[0]!.suggestedMarketplaces[0]!.value).toBe("catalog");
    expect(reconcileAdoptionDeclarations([
      known.items[0]!,
      settings.items[0]!,
    ], sha256)).toEqual(result);
  });

  it("drops every declaration at a contradictory source location", () => {
    const left = readClaudeKnownMarketplacesJson(JSON.stringify({
      catalog: { source: { source: "github", repo: "owner/one" } },
    }), context);
    const right = readClaudeKnownMarketplacesJson(JSON.stringify({
      catalog: { source: { source: "github", repo: "owner/two" } },
    }), context);
    const result = reconcileAdoptionDeclarations([left.items[0]!, right.items[0]!], sha256);
    expect(result.items).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ code: "CLAIM_CONFLICT", location: { pointer: "/catalog/source" } });
  });
});
