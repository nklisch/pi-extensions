import { describe, expect, it } from "vitest";

import {
  draftToStructuredProposal,
  validateProposalDraft,
} from "../../src/replay/proposal-draft.ts";

const draft = {
  kind: "data-pack-policy" as const,
  target: { kind: "user-global-config" as const, path: "/tmp/config.json" },
  change: {
    kind: "policy-pack" as const,
    packId: "user-tests",
    ruleId: "allow-pnpm-test",
    effect: "allow" as const,
    reason: "local tests are read-only",
    match: { all: [{ program: "pnpm" }, { arg0In: ["test"] }] },
    rawPackPatch: [],
  },
  title: "Allow local tests",
  summary: "Allow pnpm test runs",
  reason: "The project runs this command repeatedly.",
  examples: [{ command: "pnpm test", matches: true }],
  intendedProvenance: "user-global" as const,
};

describe("ProposalDraft", () => {
  it("upgrades valid drafts with deterministic generated provenance and pending evidence", () => {
    const first = draftToStructuredProposal(draft, 0, {
      createdAt: "2026-07-23T00:00:00.000Z",
    });
    const second = draftToStructuredProposal(draft, 0, {
      createdAt: "2026-07-23T00:00:00.000Z",
    });

    expect(first.id).toBe(second.id);
    expect(first.provenance).toEqual({ source: "generated" });
    expect(first.validation.schema.status).toBe("pending");
    expect(first.validation.replay?.status).toBe("pending");
    expect(first.validation.adversarial?.status).toBe("pending");
    expect(first.evidence.calls).toBe(0);
  });

  it("returns structured errors for malformed drafts", () => {
    const result = validateProposalDraft({ kind: "data-pack-policy" });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
