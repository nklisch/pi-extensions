import { createHash } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  PROPOSAL_PROVENANCE_SOURCES,
  PROPOSAL_SCHEMA_VERSION,
  ProposalChangeSchema,
  ProposalExampleSchema,
  ProposalFixtureSuggestionSchema,
  ProposalTargetSchema,
  type ProposalValidation,
  type StructuredRatchetProposal,
  StructuredRatchetProposalSchema,
  validateStructuredProposal,
} from "./proposal-schema.ts";

const STRICT = { additionalProperties: false } as const;
const ProposalKindSchema = Type.Union([
  Type.Literal("data-pack-policy"),
  Type.Literal("reviewer-config"),
  Type.Literal("project-scope-config"),
  Type.Literal("package-pack-enablement"),
  Type.Literal("pack-file-authoring"),
]);
const ProvenanceSchema = Type.Union(
  PROPOSAL_PROVENANCE_SOURCES.map((source) => Type.Literal(source)),
);

/**
 * Agent-authored proposal input. It deliberately contains only JSON data: the
 * upgrade boundary must not accept compiled matchers, writer plans, or UI
 * callbacks from the model.
 */
export const ProposalDraftSchema = Type.Object(
  {
    kind: ProposalKindSchema,
    target: ProposalTargetSchema,
    change: ProposalChangeSchema,
    title: Type.String({ minLength: 1 }),
    summary: Type.String(),
    reason: Type.String({ minLength: 1 }),
    examples: Type.Array(ProposalExampleSchema),
    intendedProvenance: ProvenanceSchema,
    fixtureSuggestions: Type.Optional(
      Type.Array(ProposalFixtureSuggestionSchema),
    ),
  },
  STRICT,
);

export type ProposalDraft = Static<typeof ProposalDraftSchema>;

export interface ProposalDraftValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly draft?: ProposalDraft;
}

export class ProposalDraftError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`proposal draft failed validation:\n${errors.join("\n")}`);
    this.name = "ProposalDraftError";
    this.errors = errors;
  }
}

export interface DraftUpgradeOptions {
  readonly createdAt?: string;
}

export function validateProposalDraft(
  input: unknown,
): ProposalDraftValidationResult {
  const errors = [...Value.Errors(ProposalDraftSchema, input)].map((error) => {
    const path = error.path.length > 0 ? error.path : "(root)";
    return `${path}: ${error.message}`;
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], draft: input as ProposalDraft };
}

/**
 * Upgrade one draft into the canonical proposal transport. IDs are content
 * addressed and include the caller's stable sequence so duplicate drafts stay
 * distinguishable while regeneration produces the same handles.
 */
export function draftToStructuredProposal(
  input: unknown,
  sequence = 0,
  options: DraftUpgradeOptions = {},
): StructuredRatchetProposal {
  const validation = validateProposalDraft(input);
  if (!validation.ok || validation.draft === undefined) {
    throw new ProposalDraftError(validation.errors);
  }

  const draft = validation.draft;
  const applicationMode =
    draft.kind === "pack-file-authoring" || draft.target.kind === "design-input"
      ? "design-input-only"
      : "writable-after-approval";
  const proposal = {
    version: PROPOSAL_SCHEMA_VERSION,
    id: draftId(draft, sequence),
    kind: draft.kind,
    title: draft.title,
    summary: draft.summary,
    reason: draft.reason,
    createdAt: options.createdAt ?? new Date(0).toISOString(),
    provenance: { source: "generated" as const },
    intendedProvenance: draft.intendedProvenance,
    applicationMode,
    target: draft.target,
    change: draft.change,
    evidence: emptyEvidence(),
    examples: draft.examples,
    fixtureSuggestions: draft.fixtureSuggestions ?? [],
    validation: pendingValidation(),
    trustNotes: [],
    warnings: [],
  };

  // The upgrade is schema-valid, but every validation slot remains pending
  // until the read-only analysis/presentation pipeline measures it. In
  // particular, structural validity is not evidence of matcher or floor safety.
  if (!Value.Check(StructuredRatchetProposalSchema, proposal)) {
    throw new ProposalDraftError([
      "upgraded draft did not conform to the structured proposal schema",
    ]);
  }
  const structured = validateStructuredProposal(proposal);
  if (!structured.ok) {
    throw new ProposalDraftError(structured.errors);
  }
  return structured.proposal;
}

function draftId(draft: ProposalDraft, sequence: number): string {
  const digest = createHash("sha256")
    .update(stableJson(draft))
    .digest("hex")
    .slice(0, 16);
  return `draft:${digest}:${Math.max(0, Math.floor(sequence))}`;
}

function pendingValidation(): ProposalValidation {
  const pending = (code: string, message: string) => ({
    status: "pending" as const,
    code,
    message,
  });
  return {
    schema: pending(
      "proposal-schema-pending",
      "proposal schema validation pending",
    ),
    matcherCompile: pending(
      "matcher-compile-pending",
      "matcher compilation pending",
    ),
    floorOverlap: pending(
      "floor-overlap-pending",
      "sealed-floor overlap validation pending",
    ),
    configSchema: pending(
      "config-schema-pending",
      "target config validation pending",
    ),
    promptOverride: pending(
      "prompt-override-pending",
      "prompt override validation pending",
    ),
    packageAvailability: pending(
      "package-availability-pending",
      "package availability validation pending",
    ),
    trust: pending("trust-pending", "trust-boundary validation pending"),
    replay: pending("replay-pending", "replay evidence pending"),
    adversarial: pending("adversarial-pending", "adversarial evidence pending"),
  };
}

function emptyEvidence(): StructuredRatchetProposal["evidence"] {
  return {
    familyIds: [],
    recordIds: [],
    calls: 0,
    uniqueCommands: 0,
    reviewCalls: 0,
    hardBlockCalls: 0,
    modelReviewCalls: 0,
    capturedDenialCalls: 0,
    replayStatusCounts: [],
    capturedOutcomeCounts: [],
    sampleCommands: [],
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
