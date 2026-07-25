import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AdoptionImportResultSchema,
  AdoptionSelectionRequestSchema,
  ForeignStateFileObservationSchema,
  MarketplaceRegistrationRequestSchema,
  type AdoptionSelectionRequest,
  type ForeignStateFileObservation,
} from "../../src/application/adoption-contract.js";
import { AdoptionCandidateIdSchema } from "../../src/domain/adoption.js";

describe("adoption application contracts", () => {
  it("defaults selection to user scope and rejects duplicate IDs", () => {
    const id = AdoptionCandidateIdSchema.parse(`adoption-v1:sha256:${"a".repeat(64)}`);
    expect(AdoptionSelectionRequestSchema.parse({ candidateIds: [id] })).toEqual({
      candidateIds: [id],
      scope: { kind: "user" },
    });
    expect(AdoptionSelectionRequestSchema.safeParse({ candidateIds: [id, id] }).success).toBe(false);
  });

  it("keeps filesystem observations and registrar requests narrow", () => {
    const observation: ForeignStateFileObservation = {
      kind: "present",
      document: "claude-known-marketplaces",
      host: "claude",
      path: "/home/user/.claude/plugins/known_marketplaces.json",
      source: "{}",
    };
    expect(ForeignStateFileObservationSchema.parse(observation)).toEqual(observation);
    expect(MarketplaceRegistrationRequestSchema.safeParse({
      source: { kind: "github", repository: "owner/catalog" },
      scope: { kind: "user" },
      origin: "adoption",
      alias: "foreign-name",
    }).success).toBe(false);
    expectTypeOf<AdoptionSelectionRequest>().toMatchTypeOf<{ candidateIds: readonly unknown[] }>();
  });

  it("validates import outcomes as one result boundary", () => {
    const id = AdoptionCandidateIdSchema.parse(`adoption-v1:sha256:${"b".repeat(64)}`);
    expect(AdoptionImportResultSchema.parse({
      outcomes: [{ candidateId: id, outcome: { kind: "candidate-unavailable" } }],
      diagnostics: [],
    }).outcomes).toHaveLength(1);
  });
});
