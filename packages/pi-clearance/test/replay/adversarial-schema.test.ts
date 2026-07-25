import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import type { AdversarialValidationReport } from "../../src/replay/proposal-schema.ts";
import {
  ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
  AdversarialValidationReportSchema,
} from "../../src/replay/proposal-schema.ts";

function notRunReport(): AdversarialValidationReport {
  return {
    version: ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
    proposalId: "prop-not-run",
    status: "not-run",
    generatedCaseCount: 0,
    evaluatedCaseCount: 0,
    failedCaseCount: 0,
    skippedCaseCount: 0,
    cases: [],
    results: [],
    warnings: ["candidate policy was unavailable"],
  };
}

function passedReport(): AdversarialValidationReport {
  return {
    version: ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
    proposalId: "prop-passed",
    status: "passed",
    generatedCaseCount: 1,
    evaluatedCaseCount: 1,
    failedCaseCount: 0,
    skippedCaseCount: 0,
    cases: [
      {
        id: "adv-substitution-1",
        command: "git status $(touch /tmp/pwned)",
        category: "substitution",
        expectation: "not-fast-path",
        rationale: "command substitution should remain review-gated",
        source: "template",
        derivedFrom: "git status",
      },
    ],
    results: [
      {
        caseId: "adv-substitution-1",
        command: "git status $(touch /tmp/pwned)",
        category: "substitution",
        expectation: "not-fast-path",
        outcome: "passed",
        actualStatus: "review",
        actualReason: "substitution present",
        diagnostics: [],
      },
    ],
    warnings: [],
  };
}

describe("adversarial validation report schema", () => {
  it("accepts not-run and evaluated reports", () => {
    expect(Value.Check(AdversarialValidationReportSchema, notRunReport())).toBe(
      true,
    );
    expect(Value.Check(AdversarialValidationReportSchema, passedReport())).toBe(
      true,
    );
  });

  it.each([
    ["wrong version", { ...passedReport(), version: 2 }],
    ["unknown status", { ...passedReport(), status: "ok" }],
    ["negative count", { ...passedReport(), evaluatedCaseCount: -1 }],
    [
      "unknown category",
      {
        ...passedReport(),
        cases: [{ ...passedReport().cases[0], category: "network" }],
      },
    ],
    [
      "unknown expectation",
      {
        ...passedReport(),
        cases: [{ ...passedReport().cases[0], expectation: "allow" }],
      },
    ],
    [
      "unknown result outcome",
      {
        ...passedReport(),
        results: [{ ...passedReport().results[0], outcome: "maybe" }],
      },
    ],
    [
      "function command",
      {
        ...passedReport(),
        cases: [{ ...passedReport().cases[0], command: () => "git status" }],
      },
    ],
    ["map transport", new Map([["status", "passed"]])],
  ])("rejects malformed reports: %s", (_label, report) => {
    expect(Value.Check(AdversarialValidationReportSchema, report)).toBe(false);
  });
});
