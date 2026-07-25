import { describe, expect, it } from "vitest";
import { validateStructuredProposalBatch } from "../../../src/replay/proposal-schema.ts";
import { PROPOSAL_VALIDATION_CHECKS } from "../../../src/replay/proposal-validation-display.ts";
import {
  type AutoReviewerValidatePackDetails,
  createAutoReviewerValidatePackTool,
  type ValidatePackEngines,
} from "../../../src/runtime/ratchet-tools/validation.ts";
import {
  adversarialReport,
  batchWithProposals,
  cacheWithBatch,
  corpus,
  dependencies,
  fakeContext,
  notRunReplayDelta,
  proposal,
  replayDelta,
  TEST_CWD,
} from "./fixtures.ts";

describe("clearance_validate_pack", () => {
  it("returns every validation slot in display order, including missing optional checks", async () => {
    const target = proposal("data-pack-policy");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const tool = createAutoReviewerValidatePackTool(dependencies(), cache);

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected validation text result");
    }
    const details = result.details as AutoReviewerValidatePackDetails;
    expect(details).toMatchObject({
      found: true,
      batchId,
      proposalId: target.id,
      updated: { replay: false, adversarial: false, cache: false },
      warnings: [],
    });
    if (!details.found) {
      throw new Error("expected validation details to be found");
    }
    expect(details.checks.map((check) => check.name)).toEqual(
      PROPOSAL_VALIDATION_CHECKS.map(([name]) => name),
    );
    expect(details.checks[0]).toMatchObject({
      name: "schema",
      present: true,
      status: "pass",
    });
    expect(details.checks.slice(1).every((check) => !check.present)).toBe(true);
    expect(
      details.checks.slice(1).every((check) => check.status === "pending"),
    ).toBe(true);
    expect(content.text).toContain("Checks: pass 1");
  });

  it("can trigger missing replay and adversarial checks and update the cache", async () => {
    const target = proposal("data-pack-policy");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const delta = replayDelta();
    const report = adversarialReport(target.id);
    const engines: ValidatePackEngines = {
      readCorpus: () => corpus(),
      replayStructuredProposal: async (input) => ({
        ok: true,
        proposal: input.proposal,
        delta,
      }),
      validateStructuredProposalAdversarial: async (input) => {
        expect(input.proposal.id).toBe(target.id);
        expect(input.baselinePolicy).toEqual({ rules: [] });
        expect(input.pathFacts).toMatchObject({ cwd: TEST_CWD });
        return report;
      },
    };
    const tool = createAutoReviewerValidatePackTool(
      dependencies(),
      cache,
      engines,
    );

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id, runReplay: true, runAdversarial: true },
      undefined,
      undefined,
      fakeContext(),
    );

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected validation text result");
    }
    const details = result.details as AutoReviewerValidatePackDetails;
    expect(details).toMatchObject({
      found: true,
      updated: { replay: true, adversarial: true, cache: true },
      replay: {
        replayOk: true,
        validationCheck: { status: "pass" },
      },
      adversarial: {
        report: { status: "passed" },
        validationCheck: { status: "pass" },
      },
    });
    if (!details.found) {
      throw new Error("expected validation details to be found");
    }
    const replaySlot = details.checks.find((check) => check.name === "replay");
    const adversarialSlot = details.checks.find(
      (check) => check.name === "adversarial",
    );
    expect(replaySlot).toMatchObject({ present: true, status: "pass" });
    expect(adversarialSlot).toMatchObject({ present: true, status: "pass" });

    const cached = cache.get(batchId);
    expect(cached?.proposals[0]?.evidence.replayDelta).toEqual(delta);
    expect(cached?.proposals[0]?.evidence.adversarial).toEqual(report);
    expect(cached?.proposals[0]?.validation.replay).toMatchObject({
      status: "pass",
    });
    expect(cached?.proposals[0]?.validation.adversarial).toMatchObject({
      status: "pass",
    });
    expect(validateStructuredProposalBatch(cached)).toMatchObject({ ok: true });
    expect(content.text).toContain("Updated cache: true");
  });

  it("treats triggered not-run replay and adversarial reports as structured non-fail checks", async () => {
    const target = proposal("reviewer-config");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const replayReason =
      "reviewer-config proposals cannot be deterministically replayed";
    const adversarialReason =
      "reviewer-config proposals do not directly define allow rules and require model-prompt evaluation outside local adversarial policy validation";
    const engines: ValidatePackEngines = {
      readCorpus: () => corpus(),
      replayStructuredProposal: async (input) => ({
        ok: false,
        proposal: input.proposal,
        delta: notRunReplayDelta(replayReason),
        reason: replayReason,
      }),
      validateStructuredProposalAdversarial: async (input) =>
        adversarialReport(input.proposal.id, {
          status: "not-run",
          warnings: [adversarialReason],
        }),
    };
    const tool = createAutoReviewerValidatePackTool(
      dependencies(),
      cache,
      engines,
    );

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id, runReplay: true, runAdversarial: true },
      undefined,
      undefined,
      fakeContext(),
    );

    const details = result.details as AutoReviewerValidatePackDetails;
    if (!details.found) {
      throw new Error("expected validation details to be found");
    }
    expect(details.replay?.delta.status).toBe("not-run");
    expect(details.replay?.validationCheck.status).not.toBe("fail");
    expect(details.adversarial?.report.status).toBe("not-run");
    expect(details.adversarial?.validationCheck.status).not.toBe("fail");
    expect(
      details.checks.find((check) => check.name === "replay"),
    ).toMatchObject({
      present: true,
      status: expect.not.stringMatching(/^fail$/),
    });
    expect(
      details.checks.find((check) => check.name === "adversarial"),
    ).toMatchObject({
      present: true,
      status: expect.not.stringMatching(/^fail$/),
    });
  });

  it("returns structured not-found details for missing batches and proposals", async () => {
    const emptyCache = cacheWithBatch(batchWithProposals([])).cache;
    const missingBatchTool = createAutoReviewerValidatePackTool(
      dependencies(),
      emptyCache,
    );

    const missingBatchResult = await missingBatchTool.execute(
      "tool-call-1",
      { batchId: "missing-batch", proposalId: "prop:missing" },
      undefined,
      undefined,
      fakeContext(),
    );
    expect(missingBatchResult.details).toMatchObject({
      found: false,
      reason: "batch-not-found",
      batchId: "missing-batch",
      proposalId: "prop:missing",
      checks: [],
      updated: { replay: false, adversarial: false, cache: false },
    });

    const existing = proposal("data-pack-policy");
    const { cache, batchId } = cacheWithBatch(batchWithProposals([existing]));
    const missingProposalTool = createAutoReviewerValidatePackTool(
      dependencies(),
      cache,
    );

    const missingProposalResult = await missingProposalTool.execute(
      "tool-call-2",
      { batchId, proposalId: "prop:nope" },
      undefined,
      undefined,
      fakeContext(),
    );
    expect(missingProposalResult.details).toMatchObject({
      found: false,
      reason: "proposal-not-found",
      batchId,
      proposalId: "prop:nope",
      knownProposalIds: [existing.id],
      checks: [],
    });
  });
});
