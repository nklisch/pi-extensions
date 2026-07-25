import { describe, expect, it } from "vitest";

import { evaluateProposalApprovalGate } from "../../src/replay/proposal-approval.ts";
import { proposal } from "../runtime/ratchet-tools/fixtures.ts";

const PASSING_VALIDATION = {
  schema: { status: "pass", code: "schema-ok", message: "ok" },
  matcherCompile: { status: "pass", code: "matcher-ok", message: "ok" },
  floorOverlap: { status: "pass", code: "floor-ok", message: "ok" },
  adversarial: { status: "pass", code: "adversarial-ok", message: "ok" },
} as const;

function pendingReplay(details?: unknown) {
  return {
    status: "pending" as const,
    code: "replay-delta-not-run-pending",
    message: "replay was not run",
    ...(details === undefined ? {} : { details }),
  };
}

const NO_CORPUS_DETAILS = {
  deltaStatus: "not-run",
  notRun: {
    code: "no-captured-corpus",
    message:
      "replay was not run because no captured corpus records are available",
    severity: "info",
  },
};

describe("no-corpus approval gate", () => {
  it("fails closed by default even with genuine no-corpus evidence", () => {
    const candidate = proposal("data-pack-policy", {
      validation: {
        ...PASSING_VALIDATION,
        replay: pendingReplay(NO_CORPUS_DETAILS),
      },
    });

    expect(
      evaluateProposalApprovalGate({ proposal: candidate, decision: "accept" }),
    ).toMatchObject({
      ok: false,
      route: "no-write",
    });
  });

  it("permits the explicit human override only for genuine no-corpus pending replay", () => {
    const candidate = proposal("data-pack-policy", {
      validation: {
        ...PASSING_VALIDATION,
        replay: pendingReplay(NO_CORPUS_DETAILS),
      },
    });

    expect(
      evaluateProposalApprovalGate({
        proposal: candidate,
        decision: "accept-without-replay",
      }),
    ).toMatchObject({
      ok: true,
      route: "writable",
      warnings: expect.arrayContaining([
        expect.stringContaining("without replay evidence"),
      ]),
    });
  });

  it("refuses the override when replay is pending for any other reason", () => {
    const otherReasons = [
      { notRun: { code: "compile-failed", message: "pack did not compile" } },
      { notRun: { code: "missing-path-facts", message: "no path facts" } },
      {
        notRun: {
          code: "replay-impact-not-run",
          message: "replay impact was not computed",
        },
      },
      undefined,
    ];

    for (const details of otherReasons) {
      const candidate = proposal("data-pack-policy", {
        validation: {
          ...PASSING_VALIDATION,
          replay: pendingReplay(details),
        },
      });

      expect(
        evaluateProposalApprovalGate({
          proposal: candidate,
          decision: "accept-without-replay",
        }),
        `pending replay with details ${JSON.stringify(details)} must not be waivable`,
      ).toMatchObject({
        ok: false,
        route: "no-write",
      });
    }
  });
});
