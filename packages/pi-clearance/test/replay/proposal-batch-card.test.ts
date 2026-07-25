import { describe, expect, it } from "vitest";

import {
  proposalBatchCardView,
  renderBatchEvidenceStatusLine,
  renderBatchSummaryCardMarkdown,
} from "../../src/replay/batch-card.ts";
import {
  groupProposals,
  proposalGroupKey,
} from "../../src/replay/proposal-grouping.ts";
import {
  batchWithProposals,
  proposal,
} from "../runtime/ratchet-tools/fixtures.ts";

describe("proposal batch card", () => {
  it("renders a deterministic summary without raw matcher or replay tables", () => {
    const first = proposal("data-pack-policy", {
      summary: "Allow the local test family",
      evidence: {
        calls: 12,
        uniqueCommands: 3,
        reviewCalls: 12,
        hardBlockCalls: 0,
        modelReviewCalls: 0,
        capturedDenialCalls: 0,
        familyIds: [],
        recordIds: [],
        replayStatusCounts: [],
        capturedOutcomeCounts: [],
        sampleCommands: ["pnpm test"],
      },
    });
    const batch = batchWithProposals([first]);
    const view = proposalBatchCardView("batch-1", batch);
    const markdown = renderBatchSummaryCardMarkdown(view);

    expect(markdown).toContain("These 1 rules allow");
    expect(markdown).toContain("replay: pending");
    expect(markdown).toContain("Safety warnings");
    expect(markdown).not.toContain("Raw matcher JSON");
    expect(markdown).not.toContain("Replay impact");
    expect(renderBatchEvidenceStatusLine(batch)).toContain("adversarial:");
  });

  it("groups policy families deterministically", () => {
    const left = proposal("data-pack-policy", {
      id: "left",
      change: {
        kind: "policy-pack",
        packId: "pack-a",
        ruleId: "rule-a",
        effect: "allow",
        reason: "same family",
        match: { program: "pnpm" },
        rawPackPatch: [],
      },
    });
    const right = proposal("data-pack-policy", {
      id: "right",
      change: {
        kind: "policy-pack",
        packId: "pack-a",
        ruleId: "rule-b",
        effect: "allow",
        reason: "same family",
        match: { program: "pnpm" },
        rawPackPatch: [],
      },
    });
    expect(proposalGroupKey(left)).toBe(proposalGroupKey(right));
    expect(
      groupProposals(batchWithProposals([right, left]))[0]?.proposals.map(
        (item) => item.id,
      ),
    ).toEqual(["left", "right"]);
  });
});
