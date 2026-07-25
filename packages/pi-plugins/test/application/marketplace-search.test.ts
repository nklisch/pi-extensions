import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MarketplaceCandidateSummarySchema, MarketplaceCatalogError } from "../../src/application/marketplace-catalog-contract.js";
import {
  normalizeMarketplaceQuery,
  paginateMarketplaceCandidates,
  queryFingerprint,
  type SearchableMarketplaceCandidate,
} from "../../src/application/marketplace-search.js";
import type { Sha256 } from "../../src/domain/source.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = (character: string) => character.repeat(64);

function candidate(name: string, idHex: string, scope: "user" | "project" = "user"): SearchableMarketplaceCandidate {
  const summary = MarketplaceCandidateSummarySchema.parse({
    id: `marketplace-candidate-v1:sha256:${hex(idHex)}`,
    snapshot: `marketplace-snapshot-v1:sha256:${hex("a")}`,
    scope: scope === "user" ? { kind: "user" } : { kind: "project", projectKey: `project-v1:sha256:${hex("b")}` },
    registrationId: `marketplace-registration-v1:sha256:${hex("c")}`,
    plugin: `${name}@catalog`,
    marketplace: "catalog",
    name,
    available: { kind: "marketplace-snapshot", marketplaceRevision: hex("d").slice(0, 40), snapshot: `marketplace-snapshot-v1:sha256:${hex("a")}` },
    availability: "available",
    source: { kind: "marketplace-path", path: name },
    sourceIdentity: `sha256:${hex("e")}`,
    provenance: [{ host: "claude", documentKind: "marketplace", path: ".claude-plugin/marketplace.json", pointer: `/plugins/${name}` }],
    trust: "untrusted-not-inspected",
  });
  return { summary, safeSearchValues: [name, `Description ${name}`], sort: [scope, "catalog", name, "", summary.id] };
}

describe("marketplace search", () => {
  it("normalizes NFKC tokens and enforces scalar/token bounds", () => {
    expect(normalizeMarketplaceQuery("  ＤＥＭＯ\tPlugin ")).toEqual(["demo", "plugin"]);
    expect(() => normalizeMarketplaceQuery("x".repeat(257))).toThrowError(MarketplaceCatalogError);
    expect(() => normalizeMarketplaceQuery(Array.from({ length: 17 }, (_, index) => `t${index}`).join(" "))).toThrowError(MarketplaceCatalogError);
  });

  it("orders deterministically and binds cursors to query and snapshot fingerprints", () => {
    const candidates = [candidate("zeta", "2"), candidate("alpha", "1"), candidate("alpha", "3", "project")];
    const queryHash = queryFingerprint({ query: [] }, sha256);
    const snapshotHash = queryFingerprint({ snapshots: [1] }, sha256);
    const first = paginateMarketplaceCandidates({ candidates, tokens: [], limit: 2, queryHash, snapshotHash });
    expect(first.candidates.map((entry) => [entry.scope.kind, entry.name])).toEqual([["user", "alpha"], ["user", "zeta"]]);
    expect(first.nextCursor).toBeDefined();
    const second = paginateMarketplaceCandidates({ candidates, tokens: [], limit: 2, queryHash, snapshotHash, cursor: first.nextCursor });
    expect(second.candidates.map((entry) => entry.scope.kind)).toEqual(["project"]);
    expect(() => paginateMarketplaceCandidates({ candidates, tokens: [], limit: 2, queryHash, snapshotHash: queryFingerprint({ snapshots: [2] }, sha256), cursor: first.nextCursor }))
      .toThrowError(expect.objectContaining({ code: "CURSOR_STALE" }));
  });

  it("rejects malformed cursors without server-side cursor state", () => {
    expect(() => paginateMarketplaceCandidates({
      candidates: [candidate("alpha", "1")],
      tokens: [],
      limit: 1,
      queryHash: queryFingerprint({}, sha256),
      snapshotHash: queryFingerprint([], sha256),
      cursor: "marketplace-cursor-v1:not-json" as never,
    })).toThrowError(expect.objectContaining({ code: "CURSOR_INVALID" }));
  });
});
