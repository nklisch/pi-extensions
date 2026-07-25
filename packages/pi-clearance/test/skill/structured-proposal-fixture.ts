import type { StructuredRatchetProposal } from "../../src/replay/proposal-schema.ts";
import { PROPOSAL_SCHEMA_VERSION } from "../../src/replay/proposal-schema.ts";

export function structuredProposal(
  overrides: Partial<StructuredRatchetProposal> = {},
): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "structured-prop:allow-git-custom-safe",
    kind: "data-pack-policy",
    title: "Allow git custom-safe",
    summary: "Allow a repeated project-local git helper command.",
    reason: "Repeated review friction with no captured denials.",
    createdAt: "2026-06-27T00:00:00.000Z",
    provenance: { source: "generated" },
    intendedProvenance: "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-project-overlay",
      path: "/tmp/pi-auto-approve/project-overlay.json",
      projectKey: "pi-auto-approve",
      projectRoot: "/tmp/pi-auto-approve/repo",
    },
    change: {
      kind: "policy-pack",
      packId: "ratchet.generated",
      ruleId: "allow-git-custom-safe",
      effect: "allow",
      reason: "Allow repeated project-local git custom-safe command.",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["custom-safe"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      rawPackPatch: [
        {
          op: "add",
          path: "/packs/0/rules/-",
          value: {
            id: "allow-git-custom-safe",
            effect: "allow",
          },
        },
      ],
    },
    evidence: {
      familyIds: ["bash:git:custom-safe"],
      recordIds: ["rec-structured-1"],
      calls: 3,
      uniqueCommands: 1,
      reviewCalls: 3,
      hardBlockCalls: 0,
      modelReviewCalls: 1,
      capturedDenialCalls: 0,
      replayStatusCounts: [{ label: "review", calls: 3, uniqueCommands: 1 }],
      capturedOutcomeCounts: [{ label: "model-review", calls: 1 }],
      sampleCommands: ["git custom-safe", "echo `tick`"],
    },
    examples: [
      {
        command: "git custom-safe",
        matches: true,
        note: "corpus command verified against proposed matcher",
      },
    ],
    fixtureSuggestions: [
      {
        command: "git custom-safe",
        expected: "fast_path",
        reason: "positive structured proposal fixture",
        provenance: "structured-presentation-test",
      },
    ],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "schema ok" },
      replay: {
        status: "pending",
        code: "replay-not-attached",
        message: "replay not attached in display seam fixture",
      },
      adversarial: {
        status: "skipped",
        code: "adversarial-not-attached",
        message: "adversarial not attached in display seam fixture",
      },
    },
    trustNotes: [
      {
        kind: "project-overlay",
        severity: "warning",
        message: "project overlay writes still require user approval",
      },
    ],
    warnings: ["structured display seam warning"],
    ...overrides,
  };
}
