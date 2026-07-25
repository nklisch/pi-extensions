import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import type {
  ReplayDelta,
  ReplayDeltaStatus,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  PROPOSAL_SCHEMA_VERSION,
  ProposalSchemaError,
  proposalJsonRoundTrip,
  REPLAY_DELTA_REGRESSION_TRANSITIONS,
  REPLAY_DELTA_SCHEMA_VERSION,
  REPLAY_DELTA_STATUSES,
  REPLAY_DELTA_TRANSITIONS,
  ReplayDeltaSchema,
  validateStructuredProposal,
} from "../../src/replay/proposal-schema.ts";

const CREATED_AT = "2026-06-27T00:00:00.000Z";

describe("replay delta schema", () => {
  it("exports the replay-delta schema version and literal arrays", () => {
    expect(REPLAY_DELTA_SCHEMA_VERSION).toBe(1);
    expect(REPLAY_DELTA_STATUSES).toEqual(["not-run", "passed", "regression"]);
    expect(REPLAY_DELTA_REGRESSION_TRANSITIONS).toEqual([
      "hard_block->fast_path",
      "hard_block->review",
      "fast_path->review",
      "fast_path->hard_block",
    ]);
    expect(REPLAY_DELTA_TRANSITIONS).toContain("review->fast_path");
  });

  it("round-trips a valid replayDelta object through proposalJsonRoundTrip", () => {
    const proposal = proposalWithReplayDelta(validReplayDelta("passed"));

    expect(validateStructuredProposal(proposal)).toMatchObject({ ok: true });
    expect(Value.Check(ReplayDeltaSchema, proposal.evidence.replayDelta)).toBe(
      true,
    );
    expect(proposalJsonRoundTrip(proposal)).toEqual(proposal);
  });

  it("keeps replayDelta optional for existing proposal evidence", () => {
    const proposal = proposalWithReplayDelta(undefined);

    expect(validateStructuredProposal(proposal)).toMatchObject({ ok: true });
    expect(proposalJsonRoundTrip(proposal)).toEqual(proposal);
  });

  it.each(
    REPLAY_DELTA_STATUSES,
  )("validates replay-delta status %s", (status) => {
    const replayDelta = validReplayDelta(status);
    const proposal = proposalWithReplayDelta(replayDelta);

    expect(Value.Check(ReplayDeltaSchema, replayDelta)).toBe(true);
    expect(validateStructuredProposal(proposal)).toMatchObject({ ok: true });
    expect(proposalJsonRoundTrip(proposal).evidence.replayDelta?.status).toBe(
      status,
    );
  });

  it("rejects Map values in replayDelta", () => {
    const proposal = invalidProposalWithReplayDelta({
      ...validReplayDelta("passed"),
      transitions: new Map([["review->fast_path", 2]]),
    });

    expect(validateStructuredProposal(proposal).ok).toBe(false);
    expect(() => proposalJsonRoundTrip(proposal)).toThrow(ProposalSchemaError);
  });

  it("rejects function-valued fields in replayDelta", () => {
    const replayDelta = mutableReplayDelta();
    const changedRecords = replayDelta.changedRecords as Record<
      string,
      unknown
    >[];
    const firstRecord = changedRecords[0];
    if (firstRecord !== undefined) {
      firstRecord.candidateReason = () => "not JSON";
    }

    const proposal = invalidProposalWithReplayDelta(replayDelta);

    expect(validateStructuredProposal(proposal).ok).toBe(false);
    expect(() => proposalJsonRoundTrip(proposal)).toThrow(ProposalSchemaError);
  });

  it("rejects malformed transition labels in replayDelta", () => {
    const replayDelta = mutableReplayDelta();
    const transitions = replayDelta.transitions as Record<string, unknown>[];
    const firstTransition = transitions[0];
    if (firstTransition !== undefined) {
      firstTransition.transition = "review=>fast_path";
    }

    const proposal = invalidProposalWithReplayDelta(replayDelta);

    expect(validateStructuredProposal(proposal).ok).toBe(false);
    expect(() => proposalJsonRoundTrip(proposal)).toThrow(ProposalSchemaError);
  });

  it("rejects legacy ReplayCompare-shaped replayDelta payloads", () => {
    const proposal = invalidProposalWithReplayDelta({
      changedUnique: 1,
      changedCalls: 2,
      transitions: new Map([["review->fast_path", 2]]),
      expansions: { calls: 2, unique: 1 },
      beforeSummary: { reviewCalls: 2 },
      afterSummary: { fastPathCalls: 2 },
      changedCommands: [],
    });

    expect(validateStructuredProposal(proposal).ok).toBe(false);
    expect(() => proposalJsonRoundTrip(proposal)).toThrow(ProposalSchemaError);
  });
});

function proposalWithReplayDelta(
  replayDelta: ReplayDelta | undefined,
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-replay-delta-1",
    kind: "data-pack-policy",
    title: "Allow git status",
    summary: "Structural allow for read-only git status.",
    reason: "Captured history shows repeated review with no denials.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-global",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-global-config",
      path: "~/.config/pi-clearance/config.json",
    },
    change: {
      kind: "policy-pack",
      packId: "user-global-bash",
      ruleId: "allow-git-status",
      effect: "allow",
      reason: "read-only git status",
      match: { toolName: "bash", executable: "git", args: ["status"] },
      rawPackPatch: [
        {
          op: "add",
          path: "/packs/0/rules/-",
          value: { id: "allow-git-status", effect: "allow" },
        },
      ],
    },
    evidence: {
      corpusSummary: {
        totalRecords: 4,
        totalUniqueCommands: 2,
        modelReviewLoad: { calls: 2, uniqueCommands: 1 },
        redactedCalls: 1,
        lowFidelityCalls: 1,
      },
      familyIds: ["bash/git/status"],
      recordIds: ["rec-1", "rec-2"],
      calls: 4,
      uniqueCommands: 2,
      reviewCalls: 2,
      hardBlockCalls: 1,
      modelReviewCalls: 2,
      capturedDenialCalls: 0,
      replayStatusCounts: [
        { label: "review", calls: 2, uniqueCommands: 1 },
        { label: "hard_block", calls: 1, uniqueCommands: 1 },
      ],
      capturedOutcomeCounts: [{ label: "model-review", calls: 2 }],
      sampleCommands: ["git status"],
      ...(replayDelta === undefined ? {} : { replayDelta }),
    },
    examples: [
      {
        command: "git status",
        matches: true,
        capturedOutcome: "model-review",
        note: "candidate policy would allow this read-only command",
      },
    ],
    fixtureSuggestions: [
      {
        command: "git status",
        expected: "fast_path",
        reason: "read-only git status",
        provenance: "ratchet",
      },
    ],
    validation: {
      schema: {
        status: "pass",
        code: "schema-ok",
        message: "proposal conforms to structured schema",
      },
    },
    trustNotes: [],
    warnings: [],
  };
}

function invalidProposalWithReplayDelta(
  replayDelta: unknown,
): StructuredRatchetProposal {
  const proposal = proposalWithReplayDelta(validReplayDelta("passed"));
  return {
    ...proposal,
    evidence: { ...proposal.evidence, replayDelta },
  } as unknown as StructuredRatchetProposal;
}

function validReplayDelta(status: ReplayDeltaStatus = "passed"): ReplayDelta {
  return {
    version: REPLAY_DELTA_SCHEMA_VERSION,
    status,
    baseline: {
      totalRecords: 4,
      totalUniqueCommands: 2,
      replayStatusCounts: [
        { label: "review", calls: 2, uniqueCommands: 1 },
        { label: "hard_block", calls: 1, uniqueCommands: 1 },
        { label: "fast_path", calls: 1, uniqueCommands: 1 },
      ],
      capturedOutcomeCounts: [{ label: "model-review", calls: 2 }],
      sourceCounts: [{ label: "session", calls: 4, uniqueCommands: 2 }],
      modelReviewLoad: { calls: 2, uniqueCommands: 1 },
      lowFidelityCalls: 1,
      redactedCalls: 1,
      unmatchedAuditEntries: 0,
    },
    candidate: {
      totalRecords: 4,
      totalUniqueCommands: 2,
      replayStatusCounts: [
        { label: "fast_path", calls: 3, uniqueCommands: 2 },
        { label: "hard_block", calls: 1, uniqueCommands: 1 },
      ],
      capturedOutcomeCounts: [{ label: "model-review", calls: 2 }],
      sourceCounts: [{ label: "session", calls: 4, uniqueCommands: 2 }],
      modelReviewLoad: { calls: 2, uniqueCommands: 1 },
      lowFidelityCalls: 1,
      redactedCalls: 1,
      unmatchedAuditEntries: 0,
    },
    changedCalls: 2,
    changedUniqueCommands: 1,
    transitions: [
      {
        transition: "review->fast_path",
        calls: 2,
        uniqueCommands: 1,
      },
    ],
    improvement: {
      reviewToAllowCalls: 2,
      reviewToAllowUniqueCommands: 1,
      reviewReductionPercent: 100,
      remainingReviewCalls: 0,
      unchangedReviewCalls: 0,
    },
    blocked: {
      unknownToolCalls: 0,
      unknownPathCalls: null,
      sealedFloorBlockCalls: 1,
      activeDenyBlockCalls: 0,
      lowFidelityCalls: 1,
      redactedCalls: 1,
    },
    regressions:
      status === "regression"
        ? [
            {
              transition: "fast_path->hard_block",
              kind: "allow-to-deny",
              calls: 1,
              uniqueCommands: 1,
              message: "candidate hard-blocks a previously allowed command",
            },
          ]
        : [],
    changedFamilies: [
      {
        familyId: "bash/git/status",
        toolName: "bash",
        executable: "git",
        calls: 2,
        uniqueCommands: 1,
        baselineStatusCounts: [
          { label: "review", calls: 2, uniqueCommands: 1 },
        ],
        candidateStatusCounts: [
          { label: "fast_path", calls: 2, uniqueCommands: 1 },
        ],
        transitions: [
          {
            transition: "review->fast_path",
            calls: 2,
            uniqueCommands: 1,
          },
        ],
        reviewToAllowCalls: 2,
        regressions:
          status === "regression"
            ? [
                {
                  transition: "fast_path->hard_block",
                  kind: "allow-to-deny",
                  calls: 1,
                  uniqueCommands: 1,
                  message: "candidate hard-blocks a previously allowed command",
                },
              ]
            : [],
        unchangedReviewCalls: 0,
        sealedFloorBlockCalls: 0,
        unknownToolCalls: 0,
        unknownPathCalls: null,
        sampleRecordIds: ["rec-1", "rec-2"],
        sampleCommands: ["git status"],
      },
    ],
    changedRecords: [
      {
        recordId: "rec-1",
        command: "git status",
        toolName: "bash",
        familyId: "bash/git/status",
        baselineStatus: "review",
        candidateStatus: "fast_path",
        transition: "review->fast_path",
        baselineReason: "default review",
        candidateRuleId: "allow-git-status",
        candidateReason: "read-only git status",
        fidelity: "high",
      },
    ],
    warnings:
      status === "not-run"
        ? ["deterministic replay was not run for this proposal"]
        : [],
  };
}

function mutableReplayDelta(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validReplayDelta("passed"))) as Record<
    string,
    unknown
  >;
}
