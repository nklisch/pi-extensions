import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  type GlobalConfig,
  GlobalConfigSchema,
  normalizeConfig,
  type ProjectOverlayConfig,
  ProjectOverlaySchema,
  type RepositoryPolicyConfig,
  RepositoryPolicySchema,
} from "../../../src/config/schema.ts";
import { compilePack } from "../../../src/policy/core.ts";
import type { ProposalNotRunReasonCode } from "../../../src/replay/proposal-schema.ts";
import {
  ReplayDeltaSchema,
  validateStructuredProposalBatch,
} from "../../../src/replay/proposal-schema.ts";
import {
  type AutoReviewerReplayProposalDetails,
  createAutoReviewerReplayProposalTool,
  type ReplayProposalEngines,
} from "../../../src/runtime/ratchet-tools/replay.ts";
import {
  batchWithProposals,
  cacheWithBatch,
  corpus,
  dependencies,
  fakeContext,
  notRunReplayDelta,
  proposal,
  replayDelta,
  resolvedPolicy,
  TEST_CWD,
} from "./fixtures.ts";

describe("clearance_replay_proposal", () => {
  it("returns a schema-valid replay delta and updates the cached proposal", async () => {
    const target = proposal("data-pack-policy");
    const batch = batchWithProposals([target], { warnings: ["batch warning"] });
    const { cache, batchId } = cacheWithBatch(batch);
    const delta = replayDelta();
    let replayCalls = 0;
    const engines: ReplayProposalEngines = {
      readCorpus(ctx) {
        expect(ctx.cwd).toBe(TEST_CWD);
        return corpus();
      },
      async replayStructuredProposal(input) {
        replayCalls += 1;
        expect(input.proposal.id).toBe(target.id);
        expect(input.baselinePolicy).toEqual({ rules: [] });
        expect(input.unknownToolPosture).toBe("review");
        expect(input.sampleLimit).toBe(5);
        expect(input.changedRecordLimit).toBe(3);
        expect(input.includeFullShape).toBe(true);
        expect(input.pathFacts).toMatchObject({
          baseline: { cwd: TEST_CWD },
          candidate: { cwd: TEST_CWD },
        });
        return { ok: true, proposal: input.proposal, delta };
      },
    };
    const tool = createAutoReviewerReplayProposalTool(
      dependencies(),
      cache,
      engines,
    );

    const result = await tool.execute(
      "tool-call-1",
      {
        batchId,
        proposalId: target.id,
        includeFullShape: true,
        sampleLimit: 5,
        changedRecordLimit: 3,
      },
      undefined,
      undefined,
      fakeContext(),
    );

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected replay text result");
    }
    const details = result.details as AutoReviewerReplayProposalDetails;
    expect(details).toMatchObject({
      found: true,
      batchId,
      proposalId: target.id,
      replayOk: true,
      updated: true,
      validationCheck: { status: "pass", code: "replay-delta-passed" },
      warnings: ["batch warning"],
    });
    if (!details.found) {
      throw new Error("expected replay details to be found");
    }
    expect(replayCalls).toBe(1);
    expect(Value.Check(ReplayDeltaSchema, details.delta)).toBe(true);
    expect(details.delta).toEqual(delta);
    expect(details.updatedProposal.evidence.replayDelta).toEqual(delta);
    expect(details.updatedProposal.validation.replay).toMatchObject({
      status: "pass",
    });

    const cached = cache.get(batchId);
    expect(cached?.proposals[0]?.evidence.replayDelta).toEqual(delta);
    expect(cached?.proposals[0]?.validation.replay).toMatchObject({
      status: "pass",
    });
    expect(validateStructuredProposalBatch(cached)).toMatchObject({ ok: true });
    expect(content.text).toContain("Replay status: passed");
    expect(content.text).toContain("Changed calls: 2");
    expect(content.text).toContain("Review → fast-path calls: 2");
  });

  it("derives distinct candidate path facts for project-scope proposals", async () => {
    const target = proposal("project-scope-config");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const basePolicy = resolvedPolicyWithSourceSnapshots();
    const delta = replayDelta();
    const engines: ReplayProposalEngines = {
      readCorpus: () => corpus(),
      replayStructuredProposal: async (input) => {
        expect(
          input.pathFacts?.baseline?.projectScope.writableDirectories,
        ).toEqual([]);
        expect(
          input.pathFacts?.candidate?.projectScope.writableDirectories,
        ).toEqual([TEST_CWD, path.resolve(TEST_CWD, "src")]);
        return { ok: true, proposal: input.proposal, delta };
      },
    };
    const tool = createAutoReviewerReplayProposalTool(
      dependencies(basePolicy),
      cache,
      engines,
    );

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    expect(result.details).toMatchObject({
      found: true,
      replayOk: true,
      updated: true,
    });
  });

  it("attaches not-run replay evidence without throwing or failing validation", async () => {
    const target = proposal("reviewer-config");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const reason =
      "reviewer-config proposals cannot be deterministically replayed";
    const delta = notRunReplayDelta(reason);
    const tool = createAutoReviewerReplayProposalTool(dependencies(), cache, {
      readCorpus: () => corpus(),
      replayStructuredProposal: async (input) => ({
        ok: false,
        proposal: input.proposal,
        delta,
        reason,
      }),
    });

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected replay text result");
    }
    const details = result.details as AutoReviewerReplayProposalDetails;
    expect(details).toMatchObject({
      found: true,
      batchId,
      proposalId: target.id,
      replayOk: false,
      updated: true,
    });
    if (!details.found) {
      throw new Error("expected replay details to be found");
    }
    expect(details.delta.status).toBe("not-run");
    expect(details.validationCheck.status).not.toBe("fail");
    expect(["pending", "skipped"]).toContain(details.validationCheck.status);
    expect(details.validationCheck.details).toMatchObject({ reason });
    expect(details.warnings).toEqual([reason, `replay not run: ${reason}`]);
    expect(cache.get(batchId)?.proposals[0]?.evidence.replayDelta).toEqual(
      delta,
    );
    expect(
      cache.get(batchId)?.proposals[0]?.validation.replay?.status,
    ).not.toBe("fail");
    expect(content.text).toContain("Replay status: not-run");
  });

  it("resolves exactly one package candidate from live package registrations", async () => {
    const target = proposal("package-pack-enablement");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const candidatePack = compiledTestPack("pack:demo");
    const policy = resolvedPolicyWithPackagePacks([candidatePack]);
    const delta = replayDelta();
    let replayCalls = 0;
    const tool = createAutoReviewerReplayProposalTool(
      dependencies(policy),
      cache,
      {
        readCorpus: () => corpus(),
        replayStructuredProposal: async (input) => {
          replayCalls += 1;
          expect(input.candidatePack).toBe(candidatePack);
          return { ok: true, proposal: input.proposal, delta };
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

    const details = result.details as AutoReviewerReplayProposalDetails;
    expect(replayCalls).toBe(1);
    expect(details).toMatchObject({
      found: true,
      replayOk: true,
      validationCheck: { status: "pass" },
      updatedProposal: {
        validation: {
          packageAvailability: {
            status: "pass",
            code: "package-candidate-resolved",
          },
          replay: { status: "pass" },
        },
      },
    });
  });

  it.each([
    ["unavailable", [], null, "package-registry-unavailable"],
    ["missing", ["other-pack"], "request-1", "package-pack-missing"],
    [
      "ambiguous",
      ["pack:demo", "pack:demo"],
      "request-1",
      "package-pack-ambiguous",
    ],
  ] as const)("returns structured pending package not-run replay for %s registrations", async (_caseName, registeredPackIds, requestId, expectedCode) => {
    const target = proposal("package-pack-enablement");
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    let replayCalls = 0;
    const tool = createAutoReviewerReplayProposalTool(
      dependencies(
        resolvedPolicyWithPackagePacks(
          registeredPackIds.map(compiledTestPack),
          requestId,
        ),
      ),
      cache,
      {
        readCorpus: () => corpus(),
        replayStructuredProposal: async () => {
          replayCalls += 1;
          throw new Error(
            "replay engine should not run without a package candidate",
          );
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

    const details = result.details as AutoReviewerReplayProposalDetails;
    if (!details.found) {
      throw new Error("expected replay details to be found");
    }
    expect(replayCalls).toBe(0);
    expect(details.delta).toMatchObject({
      status: "not-run",
      notRun: { code: expectedCode },
    });
    expect(details.validationCheck).toMatchObject({
      status: "pending",
      code: "replay-delta-not-run-pending",
    });
    expect(
      details.updatedProposal.validation.packageAvailability,
    ).toMatchObject({
      status: "pending",
      code: expectedCode,
    });
    expect(cache.get(batchId)?.proposals[0]?.validation.replay).toMatchObject({
      status: "pending",
    });
  });

  it("maps legacy model-evaluation replay not-run text to skipped", async () => {
    const target = proposal("reviewer-config", { id: "prop:legacy-model" });
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const reason =
      "reviewer-config proposals cannot be deterministically replayed; reviewer prompt changes require model evaluation outside dry-run policy replay";
    const tool = createAutoReviewerReplayProposalTool(dependencies(), cache, {
      readCorpus: () => corpus(),
      replayStructuredProposal: async (input) => ({
        ok: false,
        proposal: input.proposal,
        delta: notRunReplayDelta(reason),
        reason,
      }),
    });

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    const details = result.details as AutoReviewerReplayProposalDetails;
    if (!details.found) {
      throw new Error("expected replay details to be found");
    }
    expect(details.delta.notRun).toBeUndefined();
    expect(details.validationCheck).toMatchObject({
      status: "skipped",
      code: "replay-delta-not-run-skipped",
    });
  });

  it.each([
    ["unsupported-kind", "skipped"],
    ["no-cases", "skipped"],
    ["model-evaluation-required", "skipped"],
    ["design-input-only", "skipped"],
    ["missing-candidate-pack", "pending"],
    ["compile-failed", "pending"],
    ["package-registry-unavailable", "pending"],
    ["package-pack-missing", "pending"],
    ["package-pack-ambiguous", "pending"],
    ["missing-path-facts", "pending"],
    ["replay-impact-not-run", "pending"],
  ] as const satisfies readonly (readonly [
    ProposalNotRunReasonCode,
    "pending" | "skipped",
  ])[])("maps structured replay not-run code %s to %s", async (code, expectedStatus) => {
    const target = proposal("reviewer-config", { id: `prop:${code}` });
    const batch = batchWithProposals([target]);
    const { cache, batchId } = cacheWithBatch(batch);
    const reason = `structured replay reason for ${code}`;
    const tool = createAutoReviewerReplayProposalTool(dependencies(), cache, {
      readCorpus: () => corpus(),
      replayStructuredProposal: async (input) => ({
        ok: false,
        proposal: input.proposal,
        delta: notRunReplayDelta(reason, code),
        reason,
      }),
    });

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    const details = result.details as AutoReviewerReplayProposalDetails;
    if (!details.found) {
      throw new Error("expected replay details to be found");
    }
    expect(details.delta.notRun).toMatchObject({ code, message: reason });
    expect(details.validationCheck).toMatchObject({
      status: expectedStatus,
      code: `replay-delta-not-run-${expectedStatus}`,
    });
    expect(details.validationCheck.message).toContain(reason);
  });
});

function normalizedGlobal(raw: unknown): GlobalConfig {
  const result = normalizeConfig(GlobalConfigSchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

function normalizedProject(raw: unknown): ProjectOverlayConfig {
  const result = normalizeConfig(ProjectOverlaySchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

function normalizedRepository(raw: unknown): RepositoryPolicyConfig {
  const result = normalizeConfig(RepositoryPolicySchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

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

function resolvedPolicyWithSourceSnapshots() {
  const policy = resolvedPolicy();
  return {
    ...policy,
    config: {
      ...policy.config,
      sourceSnapshots: {
        paths: {
          userConfigRoot: "/config",
          globalConfigFile: "/config/global.json",
          projectDir: "/config/projects/project-1",
          projectOverlayFile: "/config/project.json",
          repoPolicyFile: `${TEST_CWD}/.pi-clearance/policy.json`,
          projectKey: "project-1",
        },
        global: normalizedGlobal({ version: 1 }),
        project: normalizedProject({ version: 1 }),
        repository: normalizedRepository({ version: 1 }),
      },
    },
  };
}
