import { describe, expect, it } from "vitest";

import type { ReplayDelta } from "../../../src/replay/proposal-schema.ts";
import {
  isPostWriteReplayApplicable,
  runPostWriteReplay,
} from "../../../src/runtime/ratchet-tools/post-write-replay.ts";
import {
  corpus,
  dependencies,
  fakeContext,
  notRunReplayDelta,
  proposal,
  replayDelta,
  resolvedPolicy,
} from "./fixtures.ts";

const deps = dependencies();
const ctx = fakeContext();
const beforePolicy = resolvedPolicy();
const afterPolicy = resolvedPolicy();

describe("runPostWriteReplay", () => {
  it("passes by comparing before and after policies across the captured corpus", async () => {
    const result = await runPostWriteReplay({
      proposal: proposal("data-pack-policy"),
      beforePolicy,
      afterPolicy,
      ctx,
      deps,
      engines: {
        readCorpus: () => corpus(),
        buildReplayDeltaForPolicies: async () =>
          replayDelta({ status: "passed" }),
      },
    });

    expect(result).toMatchObject({
      status: "passed",
      applicable: true,
      proposalId: "prop:data-pack-policy",
    });
    expect(result.delta?.status).toBe("passed");
  });

  it("surfaces replay regressions with the typed delta", async () => {
    const regression = regressionDelta();
    const result = await runPostWriteReplay({
      proposal: proposal("project-scope-config"),
      beforePolicy,
      afterPolicy,
      ctx,
      deps,
      engines: {
        readCorpus: () => corpus(),
        buildReplayDeltaForPolicies: async () => regression,
      },
    });

    expect(result).toMatchObject({
      status: "regression",
      applicable: true,
      delta: regression,
    });
    expect(result.reason).toContain("1 regression");
  });

  it("returns not-run when the replay engine could not produce a comparison", async () => {
    const delta = notRunReplayDelta("no corpus available");
    const result = await runPostWriteReplay({
      proposal: proposal("package-pack-enablement"),
      beforePolicy,
      afterPolicy,
      ctx,
      deps,
      engines: {
        readCorpus: () => corpus(),
        buildReplayDeltaForPolicies: async () => delta,
      },
    });

    expect(result).toMatchObject({
      status: "not-run",
      applicable: true,
      reason: "no corpus available",
      delta,
    });
  });

  it("returns failed when replay computation throws", async () => {
    const result = await runPostWriteReplay({
      proposal: proposal("data-pack-policy"),
      beforePolicy,
      afterPolicy,
      ctx,
      deps,
      engines: {
        readCorpus: () => corpus(),
        buildReplayDeltaForPolicies: async () => {
          throw new Error("boom");
        },
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      applicable: true,
      reason: "post-write replay failed: boom",
    });
  });

  it("is not applicable for reviewer config and design-input-only proposals", async () => {
    const reviewer = proposal("reviewer-config");
    const designInput = proposal("pack-file-authoring");

    expect(isPostWriteReplayApplicable(reviewer)).toBe(false);
    expect(isPostWriteReplayApplicable(designInput)).toBe(false);

    await expect(
      runPostWriteReplay({
        proposal: reviewer,
        beforePolicy,
        afterPolicy,
        ctx,
        deps,
      }),
    ).resolves.toMatchObject({
      status: "not-applicable",
      applicable: false,
    });
    await expect(
      runPostWriteReplay({
        proposal: designInput,
        beforePolicy,
        afterPolicy,
        ctx,
        deps,
      }),
    ).resolves.toMatchObject({
      status: "not-applicable",
      applicable: false,
    });
  });
});

function regressionDelta(): ReplayDelta {
  return replayDelta({
    status: "regression",
    changedCalls: 1,
    changedUniqueCommands: 1,
    transitions: [
      { transition: "fast_path->review", calls: 1, uniqueCommands: 1 },
    ],
    regressions: [
      {
        transition: "fast_path->review",
        kind: "allow-to-review",
        calls: 1,
        uniqueCommands: 1,
        message:
          "candidate policy would send an allowed command back to review",
      },
    ],
  });
}
