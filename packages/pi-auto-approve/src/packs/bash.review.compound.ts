import { defineShippedPack } from "./define.ts";

const COMPOUND_SAFE_SCOPES = ["project", "writable-project", "temp"] as const;

const rawPack = {
  version: 1,
  id: "bash.review.compound",
  rules: [
    {
      id: "bash.review.compound:review-unsupported-body",
      effect: "review",
      match: { diagnosticCode: "bash:compound-body-unsupported" },
      reason:
        "compound body contains unsupported nested structure or unmodeled stages",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.compound:review-unsupported-iterator",
      effect: "review",
      match: { diagnosticCode: "bash:compound-iterator-unsupported" },
      reason:
        "compound loop iterator contains opaque expansion or unsupported iterator syntax",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.compound:review-unsupported-feature",
      effect: "review",
      match: { diagnosticCode: "bash:compound-feature-unsupported" },
      reason:
        "unsupported compound shell feature needs reviewer judgment before running",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.compound:review-for-non-read-only-body",
      effect: "review",
      match: {
        all: [
          { compoundForm: "for" },
          { not: { bodyStagesAllReadOnly: true } },
        ],
      },
      reason:
        "compound for-loop body is not proven read-only for every modeled command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.compound:review-for-iterator-out-of-scope",
      effect: "review",
      match: {
        all: [
          { compoundForm: "for" },
          {
            not: {
              iteratorScopesAllIn: { scopes: [...COMPOUND_SAFE_SCOPES] },
            },
          },
        ],
      },
      reason:
        "compound for-loop iterator is not proven to stay in configured project/temp scope",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.compound:review-brace-group",
      effect: "review",
      match: { compoundForm: "brace-group" },
      reason:
        "brace-group compound shell form is projected but not deterministically allowed",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.compound:review-conditional",
      effect: "review",
      match: { compoundForm: "if" },
      reason:
        "conditional compound shell form is projected but not deterministically allowed",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const bashReviewCompoundPack = defineShippedPack(rawPack);
