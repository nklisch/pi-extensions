import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { compilePack } from "../../../src/policy/core.ts";
import {
  AdversarialValidationReportSchema,
  validateStructuredProposalBatch,
} from "../../../src/replay/proposal-schema.ts";
import {
  type AdversarialCasesEngines,
  type AutoReviewerAdversarialCasesDetails,
  createAutoReviewerAdversarialCasesTool,
} from "../../../src/runtime/ratchet-tools/adversarial.ts";
import {
  adversarialReport,
  batchWithProposals,
  cacheWithBatch,
  dependencies,
  fakeContext,
  proposal,
  resolvedPolicy,
  TEST_CWD,
} from "./fixtures.ts";

const ADVERSARIAL_CASE = {
  id: "adv-path-scope-1",
  command: "pnpm test ../outside",
  category: "path-scope",
  expectation: "not-fast-path",
  rationale: "outside path should not inherit a narrow test allow",
  source: "sample-mutation",
  derivedFrom: "pnpm test",
} as const;

const ADVERSARIAL_RESULT = {
  caseId: ADVERSARIAL_CASE.id,
  command: ADVERSARIAL_CASE.command,
  category: ADVERSARIAL_CASE.category,
  expectation: ADVERSARIAL_CASE.expectation,
  outcome: "passed",
  actualStatus: "review",
  actualReason: "default review",
  diagnostics: ["decision: review"],
} as const;

describe("clearance_adversarial_cases", () => {
  it("returns an adversarial report, updates proposal validation, and leaves the cached batch valid", async () => {
    const target = proposal("data-pack-policy");
    const batch = batchWithProposals([target], { warnings: ["batch warning"] });
    const { cache, batchId } = cacheWithBatch(batch);
    const report = adversarialReport(target.id, {
      status: "passed",
      generatedCaseCount: 1,
      evaluatedCaseCount: 1,
      cases: [ADVERSARIAL_CASE],
      results: [ADVERSARIAL_RESULT],
    });
    let adversarialCalls = 0;
    const engines: AdversarialCasesEngines = {
      validateStructuredProposalAdversarial: async (input) => {
        adversarialCalls += 1;
        expect(input.proposal.id).toBe(target.id);
        expect(input.baselinePolicy).toEqual({ rules: [] });
        expect(input.maxCases).toBe(7);
        expect(input.pathFacts).toMatchObject({ cwd: TEST_CWD });
        return report;
      },
    };
    const tool = createAutoReviewerAdversarialCasesTool(
      dependencies(),
      cache,
      engines,
    );

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id, maxCases: 7 },
      undefined,
      undefined,
      fakeContext(),
    );

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected adversarial text result");
    }
    const details = result.details as AutoReviewerAdversarialCasesDetails;
    expect(details).toMatchObject({
      found: true,
      batchId,
      proposalId: target.id,
      report: { status: "passed", generatedCaseCount: 1 },
      updated: true,
      validationCheck: {
        status: "pass",
        code: "adversarial-validation-passed",
      },
      warnings: ["batch warning"],
    });
    if (!details.found) {
      throw new Error("expected adversarial details to be found");
    }
    expect(adversarialCalls).toBe(1);
    expect(Value.Check(AdversarialValidationReportSchema, details.report)).toBe(
      true,
    );
    expect(details.updatedProposal.evidence.adversarial).toEqual(report);
    expect(details.updatedProposal.validation.adversarial).toMatchObject({
      status: "pass",
    });

    const cached = cache.get(batchId);
    expect(cached?.proposals[0]?.evidence.adversarial).toEqual(report);
    expect(cached?.proposals[0]?.validation.adversarial).toMatchObject({
      status: "pass",
    });
    expect(validateStructuredProposalBatch(cached)).toMatchObject({ ok: true });
    expect(content.text).toContain("Status: passed");
    expect(content.text).toContain(
      "Cases: generated 1; evaluated 1; failed 0; skipped 0",
    );
    expect(content.text).toContain("Updated cache: true");
  });

  it("resolves package candidates before adversarial validation", async () => {
    const target = proposal("package-pack-enablement");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const candidatePack = compiledTestPack("pack:demo");
    const report = adversarialReport(target.id, { status: "passed" });
    let adversarialCalls = 0;
    const tool = createAutoReviewerAdversarialCasesTool(
      dependencies(resolvedPolicyWithPackagePacks([candidatePack])),
      cache,
      {
        validateStructuredProposalAdversarial: async (input) => {
          adversarialCalls += 1;
          expect(input.candidatePack).toBe(candidatePack);
          return report;
        },
      },
    );

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    const details = result.details as AutoReviewerAdversarialCasesDetails;
    expect(adversarialCalls).toBe(1);
    expect(details).toMatchObject({
      found: true,
      report: { status: "passed" },
      updatedProposal: {
        validation: {
          packageAvailability: { status: "pass" },
          adversarial: { status: "pass" },
        },
      },
    });
  });

  it("attaches structured pending package not-run adversarial evidence when the package registry is unavailable", async () => {
    const target = proposal("package-pack-enablement");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    let adversarialCalls = 0;
    const tool = createAutoReviewerAdversarialCasesTool(
      dependencies(resolvedPolicyWithPackagePacks([], null)),
      cache,
      {
        validateStructuredProposalAdversarial: async () => {
          adversarialCalls += 1;
          throw new Error("adversarial engine should not run");
        },
      },
    );

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    const details = result.details as AutoReviewerAdversarialCasesDetails;
    if (!details.found) {
      throw new Error("expected adversarial details to be found");
    }
    expect(adversarialCalls).toBe(0);
    expect(details.report).toMatchObject({
      status: "not-run",
      notRun: { code: "package-registry-unavailable" },
    });
    expect(details.validationCheck).toMatchObject({ status: "pending" });
    expect(
      details.updatedProposal.validation.packageAvailability,
    ).toMatchObject({
      status: "pending",
      code: "package-registry-unavailable",
    });
  });

  it("attaches a not-run report for proposal kinds that do not support adversarial validation", async () => {
    const target = proposal("reviewer-config");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const tool = createAutoReviewerAdversarialCasesTool(dependencies(), cache);

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    const details = result.details as AutoReviewerAdversarialCasesDetails;
    expect(details).toMatchObject({
      found: true,
      batchId,
      proposalId: target.id,
      report: { status: "not-run" },
      updated: true,
    });
    if (!details.found) {
      throw new Error("expected adversarial details to be found");
    }
    expect(details.validationCheck.status).not.toBe("fail");
    expect(details.warnings.join("\n")).toContain(
      "reviewer-config proposals do not directly define allow rules",
    );
    expect(cache.get(batchId)?.proposals[0]?.evidence.adversarial).toEqual(
      details.report,
    );
    expect(
      cache.get(batchId)?.proposals[0]?.validation.adversarial?.status,
    ).not.toBe("fail");
  });

  it("returns structured not-found details for missing batches and proposals", async () => {
    const emptyCache = cacheWithBatch(batchWithProposals([])).cache;
    const missingBatchTool = createAutoReviewerAdversarialCasesTool(
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
      report: null,
      updatedProposal: null,
      validationCheck: null,
      updated: false,
    });

    const existing = proposal("data-pack-policy");
    const { cache, batchId } = cacheWithBatch(batchWithProposals([existing]));
    const missingProposalTool = createAutoReviewerAdversarialCasesTool(
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
      report: null,
      updated: false,
    });
  });
});

function compiledTestPack(packId: string) {
  const result = compilePack({
    version: 1,
    id: packId,
    rules: [
      {
        id: "allow-pnpm-test",
        effect: "allow",
        match: { program: "pnpm" },
        reason: "allow package pnpm workflows",
        provenance: { source: "package" },
      },
    ],
  });
  if (result.pack === null) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.pack;
}

function resolvedPolicyWithPackagePacks(
  packs: readonly ReturnType<typeof compiledTestPack>[],
  requestId: string | null = "request-1",
) {
  const policy = resolvedPolicy();
  return {
    ...policy,
    packageRegistration: {
      requestId,
      packs: packs.map((pack, index) => ({
        pack,
        source: {
          kind: "package" as const,
          packageName: `pkg-${index}`,
          packageVersion: "1.0.0",
        },
      })),
      issues: [],
    },
  };
}
