/**
 * Type-only compatibility surface for the native contract migration.
 *
 * The Rust definitions in `crates/clearance-core/src/contracts.rs` are the
 * source of truth; `src/contracts/` is generated with ts-rs. Runtime literal
 * tables remain here because they are authoring/test conveniences, not boundary
 * types.
 */
import type { PiBuiltinToolShape as GeneratedPiBuiltinToolShape } from "../contracts/PiBuiltinToolShape.ts";

export type {
  BashBlock,
  BashCommandShape,
  BashConditionalArm,
  BashControlConstruct,
  BashFlag,
  BashForLoopKeywordSpans,
  BashIteratorEntry,
  BashIteratorEntryKind,
  BashListOperator,
  BashLoopVariableReference,
  BashPathFact,
  BashPathFactContext,
  BashPathFactProvenance,
  BashPathFactProvenanceEntry,
  BashPathFacts,
  BashPipeline,
  BashStage,
  BashStageProgram,
  BlockOperator,
  CompoundBodyReason,
  CompoundFeatureReason,
  CompoundIteratorReason,
  DiagnosticSeverity,
  EnvironmentAssignment,
  IteratorSourceKind,
  LoopQuoteKind,
  LoopVariableUnknownReason,
  MutationTrustBoundaryClassification,
  MutationTrustBoundaryKind,
  PathAccess,
  PathFactProjectScope,
  PathFactsResolvedConfig,
  PathNormalization,
  PathScope,
  PathUnknownReason,
  PathUsageKind,
  PiBuiltinToolOperation,
  PiBuiltinToolPathInput,
  PiBuiltinToolSpec,
  PiFileMutationToolName,
  PiToolMutationFacts,
  QuoteKind,
  Redirect,
  RedirectStream,
  RedirectTargetKind,
  ShapeDiagnostic,
  SourceSpan,
  Substitution,
  SubstitutionKind,
  ToolPathAccess,
  ToolPathFact,
  ToolPathFacts,
  ToolPathUsage,
  ToolShape,
  UnknownPathBehavior,
  UnknownToolShape,
} from "../contracts/index.ts";

/**
 * The generated native shape is data-only and includes the native embedded-shell
 * projection used by background/monitor tool analyzers.
 */
export interface PiBuiltinToolShape extends GeneratedPiBuiltinToolShape {}

export const BASH_ITERATOR_ENTRY_KINDS = [
  "literal-word",
  "literal-glob",
] as const;

export const COMPOUND_ITERATOR_REASONS = [
  "substitution",
  "arithmetic",
  "indirect",
  "parameter",
  "brace",
  "extglob",
  "mixed",
] as const;

export const COMPOUND_BODY_REASONS = [
  "nested-form",
  "unsupported-stage",
  "function",
] as const;

export const COMPOUND_FEATURE_REASONS = [
  "select",
  "for-arithmetic",
  "case",
  "while",
  "until",
  "heredoc-in-compound",
] as const;

export const PATH_SCOPES = [
  "writable-project",
  "project",
  "temp",
  "home",
  "safe-home",
  "sensitive-home",
  "agent-support",
  "system",
  "outside",
  "denied",
  "unknown",
] as const;

export const PATH_USAGE_KINDS = [
  "cwd-prefix",
  "argument",
  "flag-value",
  "redirect-target",
  "implicit-temp",
] as const;

export const PATH_ACCESSES = [
  "read",
  "write",
  "create",
  "read-write",
  "cwd",
  "temp",
] as const;

export const ITERATOR_SOURCE_KINDS = [
  "literal-word",
  "literal-glob",
  "mixed",
  "opaque",
] as const;

export const MUTATION_TRUST_BOUNDARY_KINDS = [
  "none",
  "project-overlay",
  "policy-pack",
  "trust-record",
  "reviewer-config",
  "executable-hook",
  "package-script",
  "user-owned-config",
  "sensitive-home",
  "unknown",
] as const;
