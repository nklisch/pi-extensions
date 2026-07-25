/**
 * Structured ratchet proposal schema — the central, JSON-compatible transport
 * contract shared by ratchet-mode generators, replay validation, Pi
 * proposal-card rendering, and approval-gated writers.
 *
 * This module owns TRANSPORT SHAPE + RUNTIME VALIDATION only. Proposal
 * generation heuristics, adapter conversion, batch construction/merge, and
 * filesystem writes live in sibling modules (see the parent feature's unit
 * breakdown). Keeping the boundary here prevents the schema from becoming a
 * dumping ground for generator behavior.
 *
 * Design contract (see `.work/active/features/epic-structured-ratchet-engine-proposal-schema.md`):
 *
 * - Public objects are raw JSON: no `Map`, no functions, no compiled matcher
 *   predicates, no `PolicyRule` objects, no markdown blobs as authoritative
 *   state. Replay-delta and adversarial-validation payloads are strict typed
 *   transport contracts here; other opaque payloads (`match`, `before`, `after`,
 *   patch `value`, `rawRule`, `details`) are kept as TypeBox `Unknown` so the
 *   owning schema validates them later — the proposal schema never compiles or
 *   interprets them.
 * - Every directly-writable proposal still represents a PENDING change.
 *   `applicationMode` distinguishes `writable-after-approval` from
 *   `design-input-only`; neither path applies changes during generation.
 * - Validation status is STAGED, not a single boolean: schema, matcher compile,
 *   floor-overlap, replay, adversarial, config-schema, prompt-override, package
 *   availability, and trust checks each carry an explicit
 *   `pass | fail | skipped | pending` value. Downstream replay-delta and
 *   adversarial-validation features fill their checks later; `pending`/`skipped`
 *   must never be read as `pass`.
 *
 * The exported TypeScript types derive from the TypeBox schemas via `Static` +
 * `DeepReadonly`, so runtime validation and the public type surface cannot drift
 * apart (acceptance criterion: no hand-maintained duplicate public contract).
 *
 * No imports of markdown renderers, filesystem writers, Pi runtime APIs, or
 * model adapters — intentionally. The only dependencies are TypeBox and the
 * canonical corpus label enumerations (so the schema's replay/captured-outcome
 * literals cannot drift from `corpus-model.ts`).
 */
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { CAPTURED_OUTCOME_LABELS, REPLAY_STATUSES } from "./corpus-model.ts";

// ---------------------------------------------------------------------------
// Schema version + enum tuples (single source for literals + helper arrays)
// ---------------------------------------------------------------------------

export const PROPOSAL_SCHEMA_VERSION = 1 as const;
export const PROPOSAL_BATCH_SCHEMA_VERSION = 1 as const;
export const REPLAY_DELTA_SCHEMA_VERSION = 1 as const;
export const ADVERSARIAL_VALIDATION_SCHEMA_VERSION = 1 as const;

/**
 * Every proposal kind the structured contract can represent. Exported as a
 * helper array so downstream tests and renderers do not re-enumerate strings.
 * The TypeBox kind literal is built FROM this tuple, so the array and the
 * schema-derived union share one source.
 */
export const STRUCTURED_PROPOSAL_KINDS = [
  "data-pack-policy",
  "reviewer-config",
  "project-scope-config",
  "package-pack-enablement",
  "pack-file-authoring",
] as const;

export const PROPOSAL_APPLICATION_MODES = [
  "writable-after-approval",
  "design-input-only",
] as const;

export const PROPOSAL_VALIDATION_STATUSES = [
  "pass",
  "fail",
  "skipped",
  "pending",
] as const;

export const REPLAY_DELTA_STATUSES = [
  "not-run",
  "passed",
  "regression",
] as const;

export const REPLAY_DELTA_TRANSITIONS = [
  "fast_path->fast_path",
  "fast_path->review",
  "fast_path->hard_block",
  "review->fast_path",
  "review->review",
  "review->hard_block",
  "hard_block->fast_path",
  "hard_block->review",
  "hard_block->hard_block",
] as const;

export const REPLAY_DELTA_REGRESSION_TRANSITIONS = [
  "hard_block->fast_path",
  "hard_block->review",
  "fast_path->review",
  "fast_path->hard_block",
] as const;

export const REPLAY_DELTA_REGRESSION_KINDS = [
  "deny-to-allow",
  "deny-to-review",
  "allow-to-review",
  "allow-to-deny",
] as const;

export const ADVERSARIAL_VALIDATION_STATUSES = [
  "not-run",
  "passed",
  "failed",
] as const;

export const ADVERSARIAL_CASE_CATEGORIES = [
  "path-scope",
  "quoting",
  "substitution",
  "redirect",
  "operator",
  "pipeline",
  "cwd-prefix",
  "program-specific",
  "parser-footgun",
] as const;

export const ADVERSARIAL_CASE_EXPECTATIONS = [
  "not-fast-path",
  "hard_block",
  "review",
] as const;

export const ADVERSARIAL_CASE_SOURCES = [
  "template",
  "sample-mutation",
  "program-catalog",
] as const;

export const ADVERSARIAL_CASE_RESULT_OUTCOMES = [
  "passed",
  "failed",
  "skipped",
  "errored",
] as const;

export const PROPOSAL_NOT_RUN_REASON_CODES = [
  "unsupported-kind",
  "missing-candidate-pack",
  "compile-failed",
  "no-cases",
  "package-registry-unavailable",
  "package-pack-missing",
  "package-pack-ambiguous",
  "missing-path-facts",
  "replay-impact-not-run",
  "no-captured-corpus",
  "model-evaluation-required",
  "design-input-only",
] as const;

export const PROPOSAL_NOT_RUN_REASON_SEVERITIES = [
  "info",
  "warning",
  "error",
] as const;

/** Discriminator on each `ProposalChange` variant (distinct from top-level kind). */
export const PROPOSAL_CHANGE_KINDS = [
  "policy-pack",
  "reviewer-config",
  "project-scope-config",
  "package-pack-enablement",
  "pack-file-authoring",
] as const;

export const PROPOSAL_TARGET_KINDS = [
  "user-global-config",
  "user-project-overlay",
  "package-pack-config",
  "design-input",
] as const;

export const DESIGN_INPUT_ROUTES = ["shipped-pack", "core-matcher"] as const;

export const PACK_FILE_AUTHORING_KINDS = [
  "core-matcher",
  "shipped-pack-source",
] as const;

export const FILE_WRITE_FORMATS = ["json", "typescript", "text"] as const;
export const FILE_WRITE_MODES = ["create", "replace", "patch"] as const;
export const JSON_PATCH_OPS = ["add", "replace", "remove"] as const;

export const PROPOSAL_TRUST_SEVERITIES = ["info", "warning", "danger"] as const;

/**
 * Provenance source values a proposal may declare as its *intended* landing
 * provenance. Mirrors `DecisionSource` from `policy/decision.ts`; kept as a
 * local literal (not an import of the policy type) to match the
 * `config/schema.ts` precedent and keep the transport contract self-contained.
 *
 * Exported so adapters can narrow `DecisionSource` (which adds `"package"`)
 * down to the schema's subset without re-declaring the literal — the array,
 * the TypeBox literal, and the derived type stay in lockstep.
 */
export const PROPOSAL_PROVENANCE_SOURCES = [
  "shipped",
  "user-global",
  "user-project",
  "trusted-repo",
  "generated",
  "default",
] as const;

const DECISION_EFFECTS = ["allow", "deny", "review"] as const;

/**
 * Captured-fixture expected labels. Mirrors `CorpusExpectedLabel` from
 * `history.ts`; there is no exported canonical array, so it is declared here as
 * a stable local tuple. `corpus-model.ts` remains the classifier source of
 * truth.
 */
const CORPUS_EXPECTED_LABELS = ["fast_path", "review", "hard_block"] as const;
const CORPUS_SOURCE_LABELS = ["session", "audit", "corpus"] as const;

// ---------------------------------------------------------------------------
// TypeBox helpers
// ---------------------------------------------------------------------------

const STRICT = { additionalProperties: false } as const;

/**
 * Recursively readonly-ify a derived `Static` type, matching the `config/schema.ts`
 * convention so public proposal types are immutable views of validated data.
 * Defined locally (not imported) to avoid coupling this transport module to the
 * config schema module; the two copies are byte-for-byte identical.
 */
type DeepReadonly<T> = T extends (...args: readonly never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * Build a TypeBox literal-union schema from a readonly array of stable string
 * values. Each value becomes its own `Type.Literal`, and `Type.Union` infers
 * the return type from the resulting `TLiteral<T>[]`, so `Static<>` of the
 * union resolves to `T` (the precise element union) rather than widening to
 * `string`. Every proposal-schema enum is built through this helper so the
 * exported `as const` tuple, the runtime schema, and the derived type share one
 * source and cannot drift.
 *
 * The parameter is typed `readonly T[]` (a plain array, not a tuple
 * constraint): when passed an `as const` tuple, TS infers `T` as the union of
 * the tuple's elements, and `TLiteral<T>[]` is a valid `TSchema[]` for
 * `Type.Union`'s constraint. A tuple constraint on `T` would instead make the
 * mapped type non-homomorphic and widen `Static` to `unknown`.
 */
function literalUnion<T extends string>(values: readonly T[]) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

/** Build a strict `{ label, calls, uniqueCommands? }` count schema over a label union. */
function countByLabelSchema(labelSchema: TSchema) {
  return Type.Object(
    {
      label: labelSchema,
      calls: Type.Integer({ minimum: 0 }),
      uniqueCommands: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    STRICT,
  );
}

// ---------------------------------------------------------------------------
// Literal unions
// ---------------------------------------------------------------------------

const StructuredProposalKindLiteral = literalUnion(STRUCTURED_PROPOSAL_KINDS);
const ProposalApplicationModeLiteral = literalUnion(PROPOSAL_APPLICATION_MODES);
const ProposalValidationStatusLiteral = literalUnion(
  PROPOSAL_VALIDATION_STATUSES,
);
const DesignInputRouteLiteral = literalUnion(DESIGN_INPUT_ROUTES);
const PackFileAuthoringKindLiteral = literalUnion(PACK_FILE_AUTHORING_KINDS);
const FileWriteFormatLiteral = literalUnion(FILE_WRITE_FORMATS);
const FileWriteModeLiteral = literalUnion(FILE_WRITE_MODES);
const JsonPatchOpLiteral = literalUnion(JSON_PATCH_OPS);
const ProposalTrustSeverityLiteral = literalUnion(PROPOSAL_TRUST_SEVERITIES);
const ProvenanceSourceLiteral = literalUnion(PROPOSAL_PROVENANCE_SOURCES);
const DecisionEffectLiteral = literalUnion(DECISION_EFFECTS);
const PackEnablementActionLiteral = literalUnion([
  "enable",
  "disable",
] as const);
const PackEnablementScopeLiteral = literalUnion(["global", "project"] as const);
const PackEnablementSubjectLiteral = literalUnion([
  "package",
  "config-pack",
] as const);
const PackEnablementWarningLevelLiteral = literalUnion([
  "info",
  "warning",
  "danger",
] as const);
const PackEnablementWarningSourceLiteral = literalUnion([
  "availability",
  "validation",
  "metadata",
  "planner",
] as const);

// Corpus-derived label unions: built from the canonical corpus-model arrays so
// the proposal schema's evidence literals cannot drift from the query model.
const ReplayStatusLiteral = literalUnion(REPLAY_STATUSES);
const CapturedOutcomeLabelLiteral = literalUnion(CAPTURED_OUTCOME_LABELS);
const CorpusExpectedLabelLiteral = literalUnion(CORPUS_EXPECTED_LABELS);
const CorpusSourceLiteral = literalUnion(CORPUS_SOURCE_LABELS);
const ReplayDeltaStatusLiteral = literalUnion(REPLAY_DELTA_STATUSES);
const ReplayDeltaTransitionLiteral = literalUnion(REPLAY_DELTA_TRANSITIONS);
const ReplayDeltaRegressionTransitionLiteral = literalUnion(
  REPLAY_DELTA_REGRESSION_TRANSITIONS,
);
const ReplayDeltaRegressionKindLiteral = literalUnion(
  REPLAY_DELTA_REGRESSION_KINDS,
);
const AdversarialValidationStatusLiteral = literalUnion(
  ADVERSARIAL_VALIDATION_STATUSES,
);
const AdversarialCaseCategoryLiteral = literalUnion(
  ADVERSARIAL_CASE_CATEGORIES,
);
const AdversarialCaseExpectationLiteral = literalUnion(
  ADVERSARIAL_CASE_EXPECTATIONS,
);
const AdversarialCaseSourceLiteral = literalUnion(ADVERSARIAL_CASE_SOURCES);
const AdversarialCaseResultOutcomeLiteral = literalUnion(
  ADVERSARIAL_CASE_RESULT_OUTCOMES,
);
const ProposalNotRunReasonCodeLiteral = literalUnion(
  PROPOSAL_NOT_RUN_REASON_CODES,
);
const ProposalNotRunReasonSeverityLiteral = literalUnion(
  PROPOSAL_NOT_RUN_REASON_SEVERITIES,
);

// ---------------------------------------------------------------------------
// Patch + file-write descriptions
// ---------------------------------------------------------------------------

export const JsonPatchOperationSchema = Type.Object(
  {
    op: JsonPatchOpLiteral,
    path: Type.String({ minLength: 1 }),
    before: Type.Optional(Type.Unknown()),
    value: Type.Optional(Type.Unknown()),
  },
  STRICT,
);

export const FileWriteDescriptionSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    format: FileWriteFormatLiteral,
    mode: FileWriteModeLiteral,
    atomic: Type.Boolean(),
    backupRequired: Type.Boolean(),
    patch: Type.Optional(Type.Array(JsonPatchOperationSchema)),
    contents: Type.Optional(Type.String()),
  },
  STRICT,
);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const ProposalValidationCheckSchema = Type.Object(
  {
    status: ProposalValidationStatusLiteral,
    code: Type.String({ minLength: 1 }),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
  },
  STRICT,
);

/**
 * Staged validation status. Only `schema` is required (a structurally valid
 * proposal always has a schema-check result). Every other check is optional so
 * downstream replay-delta/adversarial/config stories can fill them in without
 * forcing generators to fabricate `pass` values for checks they have not run.
 */
export const ProposalValidationSchema = Type.Object(
  {
    schema: ProposalValidationCheckSchema,
    matcherCompile: Type.Optional(ProposalValidationCheckSchema),
    floorOverlap: Type.Optional(ProposalValidationCheckSchema),
    configSchema: Type.Optional(ProposalValidationCheckSchema),
    promptOverride: Type.Optional(ProposalValidationCheckSchema),
    packageAvailability: Type.Optional(ProposalValidationCheckSchema),
    trust: Type.Optional(ProposalValidationCheckSchema),
    replay: Type.Optional(ProposalValidationCheckSchema),
    adversarial: Type.Optional(ProposalValidationCheckSchema),
  },
  STRICT,
);

// ---------------------------------------------------------------------------
// Evidence (references corpus facts; never copies markdown or carries a Map)
// ---------------------------------------------------------------------------

export const ProposalNotRunReasonSchema = Type.Object(
  {
    code: ProposalNotRunReasonCodeLiteral,
    message: Type.String({ minLength: 1 }),
    severity: ProposalNotRunReasonSeverityLiteral,
    details: Type.Optional(Type.Unknown()),
  },
  STRICT,
);

const CorpusSummarySnapshotSchema = Type.Object(
  {
    totalRecords: Type.Integer({ minimum: 0 }),
    totalUniqueCommands: Type.Integer({ minimum: 0 }),
    modelReviewLoad: Type.Object(
      {
        calls: Type.Integer({ minimum: 0 }),
        uniqueCommands: Type.Integer({ minimum: 0 }),
      },
      STRICT,
    ),
    redactedCalls: Type.Integer({ minimum: 0 }),
    lowFidelityCalls: Type.Integer({ minimum: 0 }),
  },
  STRICT,
);

export const ReplayStatusCountSchema = countByLabelSchema(ReplayStatusLiteral);
export const CapturedOutcomeCountSchema = countByLabelSchema(
  CapturedOutcomeLabelLiteral,
);
export const CorpusSourceCountSchema = countByLabelSchema(CorpusSourceLiteral);

export const CorpusQuerySummarySnapshotSchema = Type.Object(
  {
    totalRecords: Type.Integer({ minimum: 0 }),
    totalUniqueCommands: Type.Integer({ minimum: 0 }),
    replayStatusCounts: Type.Array(ReplayStatusCountSchema),
    capturedOutcomeCounts: Type.Array(CapturedOutcomeCountSchema),
    sourceCounts: Type.Array(CorpusSourceCountSchema),
    modelReviewLoad: Type.Object(
      {
        calls: Type.Integer({ minimum: 0 }),
        uniqueCommands: Type.Integer({ minimum: 0 }),
      },
      STRICT,
    ),
    lowFidelityCalls: Type.Integer({ minimum: 0 }),
    redactedCalls: Type.Integer({ minimum: 0 }),
    unmatchedAuditEntries: Type.Integer({ minimum: 0 }),
  },
  STRICT,
);

export const ReplayDeltaTransitionCountSchema = Type.Object(
  {
    transition: ReplayDeltaTransitionLiteral,
    calls: Type.Integer({ minimum: 0 }),
    uniqueCommands: Type.Integer({ minimum: 0 }),
  },
  STRICT,
);

export const ReplayDeltaImprovementSchema = Type.Object(
  {
    reviewToAllowCalls: Type.Integer({ minimum: 0 }),
    reviewToAllowUniqueCommands: Type.Integer({ minimum: 0 }),
    reviewReductionPercent: Type.Union([
      Type.Number({ minimum: 0, maximum: 100 }),
      Type.Null(),
    ]),
    remainingReviewCalls: Type.Integer({ minimum: 0 }),
    unchangedReviewCalls: Type.Integer({ minimum: 0 }),
  },
  STRICT,
);

export const ReplayDeltaBlockedSummarySchema = Type.Object(
  {
    unknownToolCalls: Type.Integer({ minimum: 0 }),
    unknownPathCalls: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    sealedFloorBlockCalls: Type.Integer({ minimum: 0 }),
    activeDenyBlockCalls: Type.Integer({ minimum: 0 }),
    lowFidelityCalls: Type.Integer({ minimum: 0 }),
    redactedCalls: Type.Integer({ minimum: 0 }),
  },
  STRICT,
);

export const ReplayDeltaRegressionSchema = Type.Object(
  {
    transition: ReplayDeltaRegressionTransitionLiteral,
    kind: ReplayDeltaRegressionKindLiteral,
    calls: Type.Integer({ minimum: 0 }),
    uniqueCommands: Type.Integer({ minimum: 0 }),
    message: Type.String(),
  },
  STRICT,
);

export const ReplayDeltaChangedRecordSchema = Type.Object(
  {
    recordId: Type.String({ minLength: 1 }),
    command: Type.String(),
    toolName: Type.String({ minLength: 1 }),
    familyId: Type.String({ minLength: 1 }),
    baselineStatus: ReplayStatusLiteral,
    candidateStatus: ReplayStatusLiteral,
    transition: ReplayDeltaTransitionLiteral,
    baselineRuleId: Type.Optional(Type.String({ minLength: 1 })),
    candidateRuleId: Type.Optional(Type.String({ minLength: 1 })),
    baselineReason: Type.String(),
    candidateReason: Type.String(),
    fidelity: Type.Union([Type.Literal("high"), Type.Literal("redacted")]),
  },
  STRICT,
);

export const ReplayDeltaFamilySchema = Type.Object(
  {
    familyId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    executable: Type.Optional(Type.String({ minLength: 1 })),
    calls: Type.Integer({ minimum: 0 }),
    uniqueCommands: Type.Integer({ minimum: 0 }),
    baselineStatusCounts: Type.Array(ReplayStatusCountSchema),
    candidateStatusCounts: Type.Array(ReplayStatusCountSchema),
    transitions: Type.Array(ReplayDeltaTransitionCountSchema),
    reviewToAllowCalls: Type.Integer({ minimum: 0 }),
    regressions: Type.Array(ReplayDeltaRegressionSchema),
    unchangedReviewCalls: Type.Integer({ minimum: 0 }),
    sealedFloorBlockCalls: Type.Integer({ minimum: 0 }),
    unknownToolCalls: Type.Integer({ minimum: 0 }),
    unknownPathCalls: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    sampleRecordIds: Type.Array(Type.String()),
    sampleCommands: Type.Array(Type.String()),
  },
  STRICT,
);

export const ReplayDeltaSchema = Type.Object(
  {
    version: Type.Literal(REPLAY_DELTA_SCHEMA_VERSION),
    status: ReplayDeltaStatusLiteral,
    notRun: Type.Optional(ProposalNotRunReasonSchema),
    baseline: CorpusQuerySummarySnapshotSchema,
    candidate: CorpusQuerySummarySnapshotSchema,
    changedCalls: Type.Integer({ minimum: 0 }),
    changedUniqueCommands: Type.Integer({ minimum: 0 }),
    transitions: Type.Array(ReplayDeltaTransitionCountSchema),
    improvement: ReplayDeltaImprovementSchema,
    blocked: ReplayDeltaBlockedSummarySchema,
    regressions: Type.Array(ReplayDeltaRegressionSchema),
    changedFamilies: Type.Array(ReplayDeltaFamilySchema),
    changedRecords: Type.Array(ReplayDeltaChangedRecordSchema),
    warnings: Type.Array(Type.String()),
  },
  STRICT,
);

export const AdversarialCaseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    command: Type.String({ minLength: 1 }),
    category: AdversarialCaseCategoryLiteral,
    expectation: AdversarialCaseExpectationLiteral,
    rationale: Type.String({ minLength: 1 }),
    source: AdversarialCaseSourceLiteral,
    derivedFrom: Type.Optional(Type.String({ minLength: 1 })),
  },
  STRICT,
);

export const AdversarialCaseResultSchema = Type.Object(
  {
    caseId: Type.String({ minLength: 1 }),
    command: Type.String({ minLength: 1 }),
    category: AdversarialCaseCategoryLiteral,
    expectation: AdversarialCaseExpectationLiteral,
    outcome: AdversarialCaseResultOutcomeLiteral,
    actualStatus: Type.Optional(ReplayStatusLiteral),
    actualRuleId: Type.Optional(Type.String({ minLength: 1 })),
    actualReason: Type.Optional(Type.String()),
    diagnostics: Type.Array(Type.String()),
  },
  STRICT,
);

export const AdversarialValidationReportSchema = Type.Object(
  {
    version: Type.Literal(ADVERSARIAL_VALIDATION_SCHEMA_VERSION),
    proposalId: Type.String({ minLength: 1 }),
    status: AdversarialValidationStatusLiteral,
    notRun: Type.Optional(ProposalNotRunReasonSchema),
    generatedCaseCount: Type.Integer({ minimum: 0 }),
    evaluatedCaseCount: Type.Integer({ minimum: 0 }),
    failedCaseCount: Type.Integer({ minimum: 0 }),
    skippedCaseCount: Type.Integer({ minimum: 0 }),
    cases: Type.Array(AdversarialCaseSchema),
    results: Type.Array(AdversarialCaseResultSchema),
    warnings: Type.Array(Type.String()),
  },
  STRICT,
);

export const ProposalEvidenceSchema = Type.Object(
  {
    corpusSummary: Type.Optional(CorpusSummarySnapshotSchema),
    familyIds: Type.Array(Type.String()),
    recordIds: Type.Array(Type.String()),
    calls: Type.Integer({ minimum: 0 }),
    uniqueCommands: Type.Integer({ minimum: 0 }),
    reviewCalls: Type.Integer({ minimum: 0 }),
    hardBlockCalls: Type.Integer({ minimum: 0 }),
    modelReviewCalls: Type.Integer({ minimum: 0 }),
    capturedDenialCalls: Type.Integer({ minimum: 0 }),
    replayStatusCounts: Type.Array(ReplayStatusCountSchema),
    capturedOutcomeCounts: Type.Array(CapturedOutcomeCountSchema),
    sampleCommands: Type.Array(Type.String()),
    replayDelta: Type.Optional(ReplayDeltaSchema),
    adversarial: Type.Optional(AdversarialValidationReportSchema),
  },
  STRICT,
);

// ---------------------------------------------------------------------------
// Examples, fixture suggestions, trust notes
// ---------------------------------------------------------------------------

export const ProposalExampleSchema = Type.Object(
  {
    command: Type.String({ minLength: 1 }),
    matches: Type.Boolean(),
    capturedOutcome: Type.Optional(CapturedOutcomeLabelLiteral),
    note: Type.Optional(Type.String()),
  },
  STRICT,
);

/** Fixture suggestion shape — mirrors `CorpusFixtureRow` from `history.ts`. */
export const ProposalFixtureSuggestionSchema = Type.Object(
  {
    command: Type.String({ minLength: 1 }),
    expected: CorpusExpectedLabelLiteral,
    reason: Type.String(),
    provenance: Type.String(),
  },
  STRICT,
);

export const ProposalTrustNoteSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    severity: Type.Optional(ProposalTrustSeverityLiteral),
  },
  STRICT,
);

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const UserGlobalConfigTargetSchema = Type.Object(
  {
    kind: Type.Literal("user-global-config"),
    path: Type.String({ minLength: 1 }),
  },
  STRICT,
);

const UserProjectOverlayTargetSchema = Type.Object(
  {
    kind: Type.Literal("user-project-overlay"),
    path: Type.String({ minLength: 1 }),
    projectKey: Type.String({ minLength: 1 }),
    projectRoot: Type.String({ minLength: 1 }),
  },
  STRICT,
);

const PackagePackConfigTargetSchema = Type.Object(
  {
    kind: Type.Literal("package-pack-config"),
    path: Type.String({ minLength: 1 }),
    packId: Type.String({ minLength: 1 }),
    packageName: Type.Optional(Type.String({ minLength: 1 })),
    packageVersion: Type.Optional(Type.String({ minLength: 1 })),
  },
  STRICT,
);

const DesignInputTargetSchema = Type.Object(
  {
    kind: Type.Literal("design-input"),
    route: DesignInputRouteLiteral,
    suggestedPath: Type.Optional(Type.String({ minLength: 1 })),
  },
  STRICT,
);

export const ProposalTargetSchema = Type.Union([
  UserGlobalConfigTargetSchema,
  UserProjectOverlayTargetSchema,
  PackagePackConfigTargetSchema,
  DesignInputTargetSchema,
]);

// ---------------------------------------------------------------------------
// Change variants (discriminated on `kind`)
// ---------------------------------------------------------------------------

export const PolicyPackProposalChangeSchema = Type.Object(
  {
    kind: Type.Literal("policy-pack"),
    packId: Type.String({ minLength: 1 }),
    ruleId: Type.String({ minLength: 1 }),
    effect: DecisionEffectLiteral,
    reason: Type.String({ minLength: 1 }),
    // Raw matcher JSON; the owning policy DSL schema validates it later.
    match: Type.Unknown(),
    rawPackPatch: Type.Array(JsonPatchOperationSchema),
    fileWrite: Type.Optional(FileWriteDescriptionSchema),
  },
  STRICT,
);

export const ReviewerConfigProposalChangeSchema = Type.Object(
  {
    kind: Type.Literal("reviewer-config"),
    pointer: Type.String({ minLength: 1 }),
    op: Type.Union([
      Type.Literal("set"),
      Type.Literal("append-string"),
      Type.Literal("remove"),
    ]),
    before: Type.Unknown(),
    after: Type.Unknown(),
    rendered: Type.String(),
  },
  STRICT,
);

export const ProjectScopeProposalChangeSchema = Type.Object(
  {
    kind: Type.Literal("project-scope-config"),
    patch: Type.Array(JsonPatchOperationSchema),
  },
  STRICT,
);

const PackEnablementConfigSnapshotSchema = Type.Object(
  {
    enabledPackagePacks: Type.Array(Type.String()),
    disabledPackagePacks: Type.Array(Type.String()),
    disabledConfigPacks: Type.Array(Type.String()),
  },
  STRICT,
);

const PackEnablementStateSnapshotSchema = Type.Object(
  {
    scope: PackEnablementScopeLiteral,
    packEnablement: PackEnablementConfigSnapshotSchema,
    packs: Type.Array(Type.Unknown()),
  },
  STRICT,
);

const PackEnablementWarningSnapshotSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    level: PackEnablementWarningLevelLiteral,
    message: Type.String({ minLength: 1 }),
    source: PackEnablementWarningSourceLiteral,
    requiresAcknowledgement: Type.Boolean(),
  },
  STRICT,
);

const PackEnablementPlanSnapshotSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    request: Type.Object(
      {
        action: PackEnablementActionLiteral,
        scope: PackEnablementScopeLiteral,
        subject: PackEnablementSubjectLiteral,
        packId: Type.String({ minLength: 1 }),
        rawPack: Type.Optional(Type.Unknown()),
      },
      STRICT,
    ),
    targetPath: Type.String({ minLength: 1 }),
    patch: Type.Array(JsonPatchOperationSchema),
    before: PackEnablementStateSnapshotSchema,
    after: PackEnablementStateSnapshotSchema,
    warnings: Type.Array(PackEnablementWarningSnapshotSchema),
    requiredAcknowledgementCodes: Type.Array(Type.String()),
  },
  STRICT,
);

export const PackagePackEnablementProposalChangeSchema = Type.Object(
  {
    kind: Type.Literal("package-pack-enablement"),
    packId: Type.String({ minLength: 1 }),
    enable: Type.Boolean(),
    packageName: Type.Optional(Type.String({ minLength: 1 })),
    packageVersion: Type.Optional(Type.String({ minLength: 1 })),
    packagePath: Type.Optional(Type.String({ minLength: 1 })),
    metadataWarnings: Type.Array(Type.String()),
    /** Exact previewed plan snapshot required by the approval-gated writer. */
    plan: PackEnablementPlanSnapshotSchema,
  },
  STRICT,
);

export const PackFileAuthoringProposalChangeSchema = Type.Object(
  {
    kind: Type.Literal("pack-file-authoring"),
    authoringKind: PackFileAuthoringKindLiteral,
    moduleId: Type.Optional(Type.String({ minLength: 1 })),
    packId: Type.Optional(Type.String({ minLength: 1 })),
    ruleId: Type.Optional(Type.String({ minLength: 1 })),
    matcherName: Type.Optional(Type.String({ minLength: 1 })),
    matcherSignature: Type.Optional(Type.String({ minLength: 1 })),
    rationale: Type.String({ minLength: 1 }),
    fileWrite: Type.Optional(FileWriteDescriptionSchema),
    rawRule: Type.Optional(Type.Unknown()),
  },
  STRICT,
);

export const ProposalChangeSchema = Type.Union([
  PolicyPackProposalChangeSchema,
  ReviewerConfigProposalChangeSchema,
  ProjectScopeProposalChangeSchema,
  PackagePackEnablementProposalChangeSchema,
  PackFileAuthoringProposalChangeSchema,
]);

// ---------------------------------------------------------------------------
// Provenance + top-level proposal
// ---------------------------------------------------------------------------

const ProposalProvenanceSchema = Type.Object(
  {
    source: Type.Literal("generated"),
  },
  STRICT,
);

export const StructuredRatchetProposalSchema = Type.Object(
  {
    version: Type.Literal(PROPOSAL_SCHEMA_VERSION),
    id: Type.String({ minLength: 1 }),
    kind: StructuredProposalKindLiteral,
    title: Type.String({ minLength: 1 }),
    summary: Type.String(),
    reason: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
    provenance: ProposalProvenanceSchema,
    intendedProvenance: Type.Optional(ProvenanceSourceLiteral),
    applicationMode: ProposalApplicationModeLiteral,
    target: ProposalTargetSchema,
    change: ProposalChangeSchema,
    evidence: ProposalEvidenceSchema,
    examples: Type.Array(ProposalExampleSchema),
    fixtureSuggestions: Type.Array(ProposalFixtureSuggestionSchema),
    validation: ProposalValidationSchema,
    trustNotes: Type.Array(ProposalTrustNoteSchema),
    warnings: Type.Array(Type.String()),
  },
  STRICT,
);

// ---------------------------------------------------------------------------
// Batch (transport shape only — construction/merge/dedupe live in proposal-batch.ts)
// ---------------------------------------------------------------------------

export const StructuredProposalBatchSchema = Type.Object(
  {
    version: Type.Literal(PROPOSAL_BATCH_SCHEMA_VERSION),
    generatedAt: Type.String({ minLength: 1 }),
    source: Type.Object(
      {
        corpusSummary: Type.Optional(CorpusSummarySnapshotSchema),
        warnings: Type.Array(Type.String()),
      },
      STRICT,
    ),
    proposals: Type.Array(StructuredRatchetProposalSchema),
    warnings: Type.Array(Type.String()),
  },
  STRICT,
);

// ---------------------------------------------------------------------------
// Derived public types (lockstep with the schemas above)
// ---------------------------------------------------------------------------

export type StructuredRatchetProposal = DeepReadonly<
  Static<typeof StructuredRatchetProposalSchema>
>;
export type StructuredProposalBatch = DeepReadonly<
  Static<typeof StructuredProposalBatchSchema>
>;
export type ProposalTarget = DeepReadonly<Static<typeof ProposalTargetSchema>>;
export type ProposalChange = DeepReadonly<Static<typeof ProposalChangeSchema>>;
/** `data-pack-policy` change variant — names the pack/rule/effect/match + raw pack patch. */
export type PolicyPackProposalChange = DeepReadonly<
  Static<typeof PolicyPackProposalChangeSchema>
>;
export type ReviewerConfigProposalChange = DeepReadonly<
  Static<typeof ReviewerConfigProposalChangeSchema>
>;
export type ProjectScopeProposalChange = DeepReadonly<
  Static<typeof ProjectScopeProposalChangeSchema>
>;
export type PackagePackEnablementProposalChange = DeepReadonly<
  Static<typeof PackagePackEnablementProposalChangeSchema>
>;
export type PackFileAuthoringProposalChange = DeepReadonly<
  Static<typeof PackFileAuthoringProposalChangeSchema>
>;
export type ProposalEvidence = DeepReadonly<
  Static<typeof ProposalEvidenceSchema>
>;
export type CorpusQuerySummarySnapshot = DeepReadonly<
  Static<typeof CorpusQuerySummarySnapshotSchema>
>;
export type ReplayStatusCount = DeepReadonly<
  Static<typeof ReplayStatusCountSchema>
>;
export type CapturedOutcomeCount = DeepReadonly<
  Static<typeof CapturedOutcomeCountSchema>
>;
export type CorpusSourceCount = DeepReadonly<
  Static<typeof CorpusSourceCountSchema>
>;
export type ReplayDelta = DeepReadonly<Static<typeof ReplayDeltaSchema>>;
export type ProposalNotRunReason = DeepReadonly<
  Static<typeof ProposalNotRunReasonSchema>
>;
export type ReplayDeltaTransitionCount = DeepReadonly<
  Static<typeof ReplayDeltaTransitionCountSchema>
>;
export type ReplayDeltaImprovement = DeepReadonly<
  Static<typeof ReplayDeltaImprovementSchema>
>;
export type ReplayDeltaBlockedSummary = DeepReadonly<
  Static<typeof ReplayDeltaBlockedSummarySchema>
>;
export type ReplayDeltaRegression = DeepReadonly<
  Static<typeof ReplayDeltaRegressionSchema>
>;
export type ReplayDeltaChangedRecord = DeepReadonly<
  Static<typeof ReplayDeltaChangedRecordSchema>
>;
export type ReplayDeltaFamily = DeepReadonly<
  Static<typeof ReplayDeltaFamilySchema>
>;
export type AdversarialCase = DeepReadonly<
  Static<typeof AdversarialCaseSchema>
>;
export type AdversarialCaseResult = DeepReadonly<
  Static<typeof AdversarialCaseResultSchema>
>;
export type AdversarialValidationReport = DeepReadonly<
  Static<typeof AdversarialValidationReportSchema>
>;
export type ProposalValidation = DeepReadonly<
  Static<typeof ProposalValidationSchema>
>;
export type ProposalValidationCheck = DeepReadonly<
  Static<typeof ProposalValidationCheckSchema>
>;
export type ProposalExample = DeepReadonly<
  Static<typeof ProposalExampleSchema>
>;
export type ProposalFixtureSuggestion = DeepReadonly<
  Static<typeof ProposalFixtureSuggestionSchema>
>;
export type ProposalTrustNote = DeepReadonly<
  Static<typeof ProposalTrustNoteSchema>
>;
export type JsonPatchOperation = DeepReadonly<
  Static<typeof JsonPatchOperationSchema>
>;
export type FileWriteDescription = DeepReadonly<
  Static<typeof FileWriteDescriptionSchema>
>;
export type StructuredProposalKind = Static<
  typeof StructuredProposalKindLiteral
>;
export type ProposalApplicationMode = Static<
  typeof ProposalApplicationModeLiteral
>;
export type ProposalValidationStatus = Static<
  typeof ProposalValidationStatusLiteral
>;
export type ReplayDeltaStatus = Static<typeof ReplayDeltaStatusLiteral>;
export type ReplayDeltaTransition = Static<typeof ReplayDeltaTransitionLiteral>;
export type ReplayDeltaRegressionTransition = Static<
  typeof ReplayDeltaRegressionTransitionLiteral
>;
export type ReplayDeltaRegressionKind = Static<
  typeof ReplayDeltaRegressionKindLiteral
>;
export type AdversarialValidationStatus = Static<
  typeof AdversarialValidationStatusLiteral
>;
export type AdversarialCaseCategory = Static<
  typeof AdversarialCaseCategoryLiteral
>;
export type AdversarialCaseExpectation = Static<
  typeof AdversarialCaseExpectationLiteral
>;
export type AdversarialCaseSource = Static<typeof AdversarialCaseSourceLiteral>;
export type AdversarialCaseResultOutcome = Static<
  typeof AdversarialCaseResultOutcomeLiteral
>;
export type ProposalNotRunReasonCode = Static<
  typeof ProposalNotRunReasonCodeLiteral
>;
/** Intended-landing provenance subset (mirrors `DecisionSource` minus `"package"`). */
export type ProposalProvenanceSource = Static<typeof ProvenanceSourceLiteral>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

// Discriminated on `ok` so callers can narrow without touching `undefined`:
// after `if (!result.ok) ...`, the success branch exposes a non-optional
// `proposal`/`batch`. Kept as a union (not an interface with `proposal?`)
// specifically so `exactOptionalPropertyTypes` does not force `| undefined`
// onto the narrowed success value.
export type ProposalSchemaValidationResult =
  | {
      readonly ok: true;
      readonly proposal: StructuredRatchetProposal;
      readonly errors: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

export type ProposalBatchValidationResult =
  | {
      readonly ok: true;
      readonly batch: StructuredProposalBatch;
      readonly errors: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Error thrown by {@link assertStructuredProposal} when input does not conform to
 * the structured proposal schema. Carries the collected field-level messages so
 * callers can surface them without re-running validation.
 */
export class ProposalSchemaError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(
      `structured proposal failed schema validation:\n${errors.join("\n")}`,
    );
    this.name = "ProposalSchemaError";
    this.errors = errors;
  }
}

function collectErrors(schema: TSchema, input: unknown): readonly string[] {
  return [...Value.Errors(schema, input)].map((error) => {
    const path = error.path.length > 0 ? error.path : "(root)";
    return `${path}: ${error.message}`;
  });
}

/**
 * Validate an unknown value against {@link StructuredRatchetProposalSchema}.
 * Returns a structured result rather than throwing so batch builders and
 * renderers can skip or warn on malformed proposals without try/catch noise.
 */
export function validateStructuredProposal(
  input: unknown,
): ProposalSchemaValidationResult {
  const errors = collectErrors(StructuredRatchetProposalSchema, input);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const proposal = input as StructuredRatchetProposal;
  const semanticErrors = proposalCoherenceErrors(proposal);
  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors };
  }

  return {
    ok: true,
    proposal,
    errors: [],
  };
}

/**
 * Validate and narrow an unknown value to a {@link StructuredRatchetProposal},
 * throwing {@link ProposalSchemaError} on any schema violation. Use when a
 * caller needs a typed proposal and cannot recover from malformed input.
 */
export function assertStructuredProposal(
  input: unknown,
): StructuredRatchetProposal {
  const result = validateStructuredProposal(input);
  if (!result.ok) {
    throw new ProposalSchemaError(result.errors);
  }
  return result.proposal;
}

/**
 * Validate an unknown value against {@link StructuredProposalBatchSchema}.
 */
export function validateStructuredProposalBatch(
  input: unknown,
): ProposalBatchValidationResult {
  const errors = collectErrors(StructuredProposalBatchSchema, input);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const batch = input as StructuredProposalBatch;
  const proposalErrors = batch.proposals.flatMap((proposal, index) =>
    proposalCoherenceErrors(proposal).map(
      (error) => `/proposals/${index}: ${error}`,
    ),
  );
  if (proposalErrors.length > 0) {
    return { ok: false, errors: proposalErrors };
  }

  return { ok: true, batch, errors: [] };
}

function proposalCoherenceErrors(
  proposal: StructuredRatchetProposal,
): readonly string[] {
  const expectedChangeKind = proposalKindToChangeKind(proposal.kind);
  const errors: string[] = [];
  if (proposal.change.kind !== expectedChangeKind) {
    errors.push(
      `/change/kind: proposal kind "${proposal.kind}" requires change kind "${expectedChangeKind}"`,
    );
  }

  if (!targetIsAllowedForProposalKind(proposal)) {
    errors.push(
      `/target/kind: proposal kind "${proposal.kind}" cannot target "${proposal.target.kind}"`,
    );
  }

  if (
    proposal.kind === "pack-file-authoring" &&
    proposal.applicationMode !== "design-input-only"
  ) {
    errors.push(
      '/applicationMode: pack-file-authoring proposals must be "design-input-only"',
    );
  }

  return errors;
}

function proposalKindToChangeKind(
  kind: StructuredRatchetProposal["kind"],
): ProposalChange["kind"] {
  switch (kind) {
    case "data-pack-policy":
      return "policy-pack";
    case "reviewer-config":
      return "reviewer-config";
    case "project-scope-config":
      return "project-scope-config";
    case "package-pack-enablement":
      return "package-pack-enablement";
    case "pack-file-authoring":
      return "pack-file-authoring";
  }
}

function targetIsAllowedForProposalKind(
  proposal: StructuredRatchetProposal,
): boolean {
  switch (proposal.kind) {
    case "data-pack-policy":
      return (
        proposal.target.kind === "user-global-config" ||
        proposal.target.kind === "user-project-overlay" ||
        (proposal.target.kind === "design-input" &&
          proposal.target.route === "shipped-pack")
      );
    case "reviewer-config":
      return (
        proposal.target.kind === "user-global-config" ||
        proposal.target.kind === "user-project-overlay"
      );
    case "project-scope-config":
      return proposal.target.kind === "user-project-overlay";
    case "package-pack-enablement":
      return proposal.target.kind === "package-pack-config";
    case "pack-file-authoring":
      return proposal.target.kind === "design-input";
  }
}

/**
 * True iff the proposal is on the writable-after-approval path. The validation
 * helpers reject incoherent unsafe combinations such as writable pack-file
 * authoring proposals before callers receive a typed proposal.
 */
export function isWritableProposal(
  proposal: StructuredRatchetProposal,
): boolean {
  return proposal.applicationMode === "writable-after-approval";
}

/**
 * Prove the structured proposal is raw-JSON-compatible by round-tripping it
 * through `JSON.stringify`/`JSON.parse` and re-validating. A proposal that
 * carries a `Map`, function, compiled matcher predicate, or any other
 * non-JSON value will either lose required data on serialization or fail
 * re-validation, so a successful round-trip is proof the contract holds no
 * non-JSON authoritative state. Throws {@link ProposalSchemaError} on failure.
 */
export function proposalJsonRoundTrip(
  proposal: StructuredRatchetProposal,
): StructuredRatchetProposal {
  return assertStructuredProposal(JSON.parse(JSON.stringify(proposal)));
}
