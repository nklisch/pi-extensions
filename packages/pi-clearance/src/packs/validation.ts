/**
 * Filesystem-free data-pack validation — schema/provenance and the native
 * sealed-floor safety gate.
 *
 * This implements data-pack validation between package discovery and enablement. It sits between pack
 * registration/discovery and enablement: it turns a raw candidate into a
 * {@link PackValidationResult} that reports
 * schema/compiler/source/provenance issues, sealed-floor overlap
 * safety with a stable candidate id,
 * while keeping malformed and unsafe candidates discoverable with errors.
 *
 * Safety reuse: sealed-floor overlap is not re-derived here.
 * {@link validateCompiledDataPackSafety} calls
 * `loadEffectivePolicy({ floor: sealedFloor, active: [pack] })`, whose
 * inspectable lane is native composition; this module only translates its
 * errors/warnings into validation issues.
 *
 * Purity contract: this module never reads the filesystem, scans packages,
 * imports Pi runtime APIs, prompts, calls models, or executes commands. Replay
 * impact and the validated-availability report are also implemented here; both
 * are evidence/reporting surfaces, not command execution paths.
 */

import type { ResolvedConfig } from "../config/loader.ts";
import { normalizeConfig, PolicyPackSchema } from "../config/schema.ts";
import type {
  DecisionEffect,
  EffectivePolicy,
  PolicyPack,
} from "../policy/core.ts";
import { type CompileError, compilePack } from "../policy/core.ts";
import {
  type LoadError,
  type LoadWarning,
  loadEffectivePolicy,
} from "../policy/loader.ts";
import type { ReplayCorpus } from "../replay/history.ts";
import { REPLAY_DELTA_REGRESSION_TRANSITIONS } from "../replay/proposal-schema.ts";
import {
  type ReplayCompare,
  type ReplayStatus,
  replayHistory,
} from "../replay/ratchet.ts";
import { sealedFloor } from "./floor.ts";
import {
  listPackRegistryEntries,
  type PackRegistry,
  type PackRegistryEntry,
  type PackRegistryFilter,
  type PackSourceInfo,
} from "./registry.ts";

export type PackCandidateKind = "data";

export type PackValidationSeverity = "info" | "warning" | "error" | "danger";

export type PackValidationCode =
  | "schema-invalid"
  | "compile-invalid"
  | "source-invalid"
  | "provenance-mismatch"
  // Sealed-floor overlap codes are emitted by the native safety gate;
  // replay-impact-regression is emitted by
  // the Unit 3 replay-impact summarizer for unsafe status transitions.
  | "sealed-floor-overlap"
  | "sealed-floor-overlap-unknown"
  | "replay-impact-regression";

export interface PackValidationIssue {
  readonly code: PackValidationCode;
  readonly severity: PackValidationSeverity;
  readonly path?: string;
  readonly message: string;
}

/**
 * A raw JSON-compatible data pack awaiting validation. `raw` is `unknown` so
 * malformed input is reported rather than crashing the validator.
 */
export interface DataPackCandidate {
  readonly kind: "data";
  readonly idHint?: string;
  readonly raw: unknown;
  readonly source: PackSourceInfo;
}

export type PackValidationCandidate = DataPackCandidate;

/**
 * Validation context carries resolved config errors and warnings for reporting.
 */
export interface PackValidationContext {
  readonly resolvedConfig: Pick<ResolvedConfig, "mode" | "errors" | "warnings">;
}

export interface PackValidationResult {
  readonly candidateId: string;
  readonly kind: PackCandidateKind;
  readonly source: PackSourceInfo;
  /**
   * Compiled pack when one is available for inspection. This
   * can be non-null even when blocking issues exist; callers must gate policy
   * influence on `canAffectPolicy`, not on `pack` alone.
   */
  readonly pack: PolicyPack | null;
  readonly issues: readonly PackValidationIssue[];
  readonly canDiscover: boolean;
  readonly canEnable: boolean;
  readonly canAffectPolicy: boolean;
}

/**
 * Issue severities that block enablement. `canEnable` is false whenever any
 * issue carries one of these severities; warnings and info do not block.
 */
const BLOCKING_SEVERITIES: ReadonlySet<PackValidationSeverity> = new Set([
  "error",
  "danger",
]);

/**
 * Rule-provenance sources that a package-contributed pack may not legitimately
 * claim for itself. Package rule provenance is untrusted display input; a
 * package claiming a privileged source is reported so enablement can normalize
 * provenance to the user-owned config destination.
 */
const PRIVILEGED_PROVENANCE_SOURCES: ReadonlySet<string> = new Set([
  "shipped",
  "user-global",
  "user-project",
  "trusted-repo",
]);

/**
 * Validate a pack candidate into a discoverable result with issues and
 * enablement eligibility. Never throws: malformed input is captured as
 * schema/compiler/source issues while `canDiscover` stays `true`.
 */
export function validatePackCandidate(
  candidate: PackValidationCandidate,
  _context: PackValidationContext,
): PackValidationResult {
  const issues: PackValidationIssue[] = [];

  // Source coherence applies to both candidate kinds.
  collectSourceIssues(candidate.source, issues);

  let pack: PolicyPack | null = null;

  collectSchemaIssues(candidate.raw, issues);
  const compiled = compilePack(candidate.raw);
  for (const error of compiled.errors) {
    issues.push(toCompileIssue(error));
  }
  pack = compiled.pack;
  collectProvenanceIssues(candidate, issues);
  // A compiled data pack must be provably disjoint from the sealed floor before
  // it can be enabled or affect policy.
  if (pack !== null) {
    const safety = validateCompiledDataPackSafety({ pack });
    issues.push(...safety.issues);
  }

  const id = resolveCandidateId(candidate, pack);
  const canEnable = !hasBlockingValidationIssues(issues);
  const canAffectPolicy = canEnable && pack !== null;

  return {
    candidateId: id,
    kind: candidate.kind,
    source: candidate.source,
    pack,
    issues,
    canDiscover: true,
    canEnable,
    canAffectPolicy,
  };
}

/**
 * Stable candidate id. Prefers a valid compiled pack id, then a non-empty
 * `idHint`, then a package source label. This keeps malformed packs listable
 * without pretending they compiled into a `PolicyPack`.
 */
export function candidateId(candidate: PackValidationCandidate): string {
  const compiledPack =
    candidate.kind === "data" ? compilePack(candidate.raw).pack : null;
  return resolveCandidateId(candidate, compiledPack);
}

/** Whether `issues` contain any blocking (error/danger) entry. */
export function hasBlockingValidationIssues(
  issues: readonly PackValidationIssue[],
): boolean {
  return issues.some((issue) => BLOCKING_SEVERITIES.has(issue.severity));
}

// ---------------------------------------------------------------------------
// Sealed-floor safety gate
// ---------------------------------------------------------------------------

/**
 * Input to {@link validateCompiledDataPackSafety}. `existingPolicy` is
 * reserved for the downstream replay-impact unit: the sealed-floor overlap gate
 * itself only needs {@link pack} and the shipped sealed floor, so the field is
 * accepted but not consumed here.
 */
export interface PackSafetyValidationInput {
  /** Compiled data pack whose allow rules are checked against the sealed floor. */
  readonly pack: PolicyPack;
  /** Reserved for replay-impact validation; unused by the floor overlap gate. */
  readonly existingPolicy?: EffectivePolicy;
}

/** Result of {@link validateCompiledDataPackSafety}. */
export interface PackSafetyValidationResult {
  readonly issues: readonly PackValidationIssue[];
  /** Native composition warnings, retained for diagnostic callers. */
  readonly loaderWarnings: readonly LoadWarning[];
}

/**
 * Validate a compiled data pack against the sealed deny floor.
 *
 * Calls `loadEffectivePolicy({ floor: sealedFloor, active: [pack] })` and
 * translates its errors into blocking validation issues:
 * - `allow rule overlaps sealed-floor deny ...` -> `sealed-floor-overlap` / `danger`.
 * - `allow rule has undecidable overlap ...` -> `sealed-floor-overlap-unknown` / `danger`.
 *
 * Non-allow rules are not floor-checked by the loader, so review/deny-only
 * packs do not get false-positive floor blocking. Loader warnings are returned
 * verbatim. Never throws.
 */
export function validateCompiledDataPackSafety(
  input: PackSafetyValidationInput,
): PackSafetyValidationResult {
  const loadResult = loadEffectivePolicy({
    floor: sealedFloor,
    active: [input.pack],
  });
  const issues: readonly PackValidationIssue[] = loadResult.ok
    ? []
    : loadResult.errors.map(translateLoadError);
  return { issues, loaderWarnings: loadResult.warnings };
}

// ---------------------------------------------------------------------------
// Issue collectors
// ---------------------------------------------------------------------------

/**
 * Validate package source coherence. Package candidates require a non-empty
 * `packageName` and either `packageVersion` or `packagePath`; config-owned
 * candidates carry a non-package source kind and need no package detail. The
 * source kind itself is typed by {@link PackSourceInfo}, so only package detail
 * fields are validated here.
 */
function collectSourceIssues(
  source: PackSourceInfo,
  issues: PackValidationIssue[],
): void {
  if (source.kind !== "package") {
    return;
  }

  if (!isNonEmptyString(source.packageName)) {
    issues.push({
      code: "source-invalid",
      severity: "error",
      path: "source.packageName",
      message: "package source requires a non-empty packageName",
    });
  }

  if (
    !isNonEmptyString(source.packageVersion) &&
    !isNonEmptyString(source.packagePath)
  ) {
    issues.push({
      code: "source-invalid",
      severity: "error",
      path: "source",
      message: "package source requires either packageVersion or packagePath",
    });
  }
}

/**
 * Normalize the raw pack against {@link PolicyPackSchema} and report each
 * schema error with its JSON path. Schema validation runs alongside
 * {@link compilePack}: the schema catches strict-shape errors (unknown fields,
 * bad literals) while the compiler catches matcher-level errors the shallow
 * schema cannot.
 */
function collectSchemaIssues(
  raw: unknown,
  issues: PackValidationIssue[],
): void {
  // `normalizeConfig` applies TypeBox defaults in-place to plain objects. Clone
  // first so validation stays pure for caller-owned raw candidate data and so
  // later provenance checks observe the package's original claims, not schema
  // defaults injected during validation.
  const normalized = normalizeConfig(
    PolicyPackSchema,
    cloneForNormalization(raw),
  );
  if (normalized.ok) {
    return;
  }
  for (const error of normalized.errors) {
    issues.push({
      code: "schema-invalid",
      severity: "error",
      path: error.path,
      message: error.message,
    });
  }
}

/**
 * Warn when a package-contributed data pack claims a privileged rule
 * provenance source. Package rule provenance is untrusted display input; the
 * final normalization to the user-owned config destination happens at
 * enablement. Config-owned packs are authoritative and do not trigger this
 * warning. This is a non-blocking warning distinct from schema/compiler errors.
 */
function collectProvenanceIssues(
  candidate: DataPackCandidate,
  issues: PackValidationIssue[],
): void {
  if (candidate.source.kind !== "package") {
    return;
  }

  for (const { rule, index } of extractRawRules(candidate.raw)) {
    const provenance = rule.provenance;
    if (!isPlainObject(provenance)) {
      continue;
    }
    const source = provenance.source;
    if (typeof source !== "string") {
      continue;
    }
    if (!PRIVILEGED_PROVENANCE_SOURCES.has(source)) {
      continue;
    }
    const ruleId = rule.id;
    const attribution =
      typeof ruleId === "string" ? `"${ruleId}"` : `index ${index}`;
    issues.push({
      code: "provenance-mismatch",
      severity: "warning",
      path: `rules[${index}].provenance.source`,
      message: `package data pack claims privileged provenance "${source}" for rule ${attribution}; rule provenance is not trusted from packages and will be normalized at enablement`,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate a sealed-floor loader error into a blocking validation issue by
 * message prefix, preserving the loader's path and message. The loader emits
 * exactly two allow-vs-floor error shapes for a valid sealed floor; any other
 * error is conservatively blocked as a floor overlap so the gate stays closed.
 */
function translateLoadError(error: LoadError): PackValidationIssue {
  if (error.message.startsWith("allow rule overlaps sealed-floor deny")) {
    return {
      code: "sealed-floor-overlap",
      severity: "danger",
      path: error.path,
      message: error.message,
    };
  }
  if (error.message.startsWith("allow rule has undecidable overlap")) {
    return {
      code: "sealed-floor-overlap-unknown",
      severity: "danger",
      path: error.path,
      message: error.message,
    };
  }
  return {
    code: "sealed-floor-overlap",
    severity: "danger",
    path: error.path,
    message: error.message,
  };
}

/**
 * Resolve a stable candidate id from a (possibly null) compiled pack. Data
 * candidates prefer the compiled pack id, then `idHint`, then a package source
 * label.
 */
function resolveCandidateId(
  candidate: PackValidationCandidate,
  compiledPack: PolicyPack | null,
): string {
  if (compiledPack !== null) {
    return compiledPack.id;
  }
  if (isNonEmptyString(candidate.idHint)) {
    return candidate.idHint;
  }
  return packageSourceLabel(candidate.source) ?? "data:unknown";
}

/** `<packageName>:<detail>` label for a package source, or `undefined`. */
function packageSourceLabel(source: PackSourceInfo): string | undefined {
  if (source.kind !== "package") {
    return undefined;
  }
  const name = source.packageName;
  if (!isNonEmptyString(name)) {
    return undefined;
  }
  const detail =
    source.packageEntrypointPath ??
    source.packagePath ??
    source.packageVersion ??
    "unknown";
  return `${name}:${detail}`;
}

function toCompileIssue(error: CompileError): PackValidationIssue {
  return {
    code: "compile-invalid",
    severity: "error",
    path: error.path,
    message: error.message,
  };
}

/**
 * Safely extract rule objects from an unknown raw pack for provenance checks.
 * Returns an empty array when the raw is not a `{ rules: [...] }` shape so
 * provenance checking never throws on malformed input.
 */
function extractRawRules(raw: unknown): readonly {
  readonly rule: Record<string, unknown>;
  readonly index: number;
}[] {
  if (!isPlainObject(raw)) {
    return [];
  }
  const rules = raw.rules;
  if (!Array.isArray(rules)) {
    return [];
  }
  const result: { rule: Record<string, unknown>; index: number }[] = [];
  rules.forEach((rule, index) => {
    if (isPlainObject(rule)) {
      result.push({ rule, index });
    }
  });
  return result;
}

function cloneForNormalization(value: unknown): unknown {
  // Avoid `structuredClone` here so adversarial/cyclic test objects remain
  // reportable as validation errors rather than becoming clone-time throws.
  return cloneForNormalizationInner(value, new WeakMap<object, unknown>());
}

function cloneForNormalizationInner(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) {
      clone.push(cloneForNormalizationInner(item, seen));
    }
    return clone;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = cloneForNormalizationInner(item, seen);
  }
  return clone;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Unit 3: Replay-impact validation
// ---------------------------------------------------------------------------
//
// Replay summarizes how enabling an otherwise-valid candidate pack would change
// historical decisions WITHOUT executing commands. It runs only after the
// schema/floor gates and is reported as evidence, not as a safety gate: the
// sealed floor is the safety boundary, so replay regressions surface as
// non-blocking warnings carried on
// `PackReplayImpactSummary.issues` alongside a structured `status`.

/**
 * Input to {@link evaluatePackReplayImpact}. The candidate `pack` is appended to
 * `currentPolicy`'s active lane via {@link policyWithCandidatePack}; `parser`
 * and `clock` are forwarded to {@link replayHistory} so replay is deterministic
 * under test. `unknownToolPosture` mirrors the replay option for non-bash calls.
 */
export interface PackReplayImpactInput {
  readonly corpus: ReplayCorpus;
  readonly currentPolicy: EffectivePolicy;
  readonly pack: PolicyPack;
  readonly unknownToolPosture?: DecisionEffect;
  readonly clock?: () => Date;
}

/**
 * Summary of how a candidate pack would shift historical replay decisions.
 *
 * `status` is `"not-run"` when replay was not run (the candidate could not be
 * enabled, or no compare was produced), `"passed"` when only expansions or no
 * changes occurred, and `"regression"` when any unsafe transition was observed.
 *
 * `reviewToAllow`, `denyToAllow`, and `allowToReviewOrDeny` are call counts of
 * the corresponding status transitions (matching `ReplayCompare.transitions`).
 * `changedStatuses` preserves the full transition map as a runtime `Map`; its
 * keys are `${ReplayStatus}->${ReplayStatus}` literals.
 */
export interface PackReplayImpactSummary {
  readonly status: "not-run" | "passed" | "regression";
  readonly changedUnique: number;
  readonly changedCalls: number;
  readonly reviewToAllow: number;
  readonly denyToAllow: number;
  readonly allowToReviewOrDeny: number;
  readonly changedStatuses: ReadonlyMap<
    `${ReplayStatus}->${ReplayStatus}`,
    number
  >;
  /** Raw compare; omitted when replay was not run. */
  readonly compare?: ReplayCompare;
  readonly issues: readonly PackValidationIssue[];
}

/** Validated pack entry exposed to discovery commands and ratchet tools. */
export interface ValidatedAvailablePack {
  readonly candidateId: string;
  /** Present for compiled registry entries; absent for raw package candidates that never registered. */
  readonly registryEntry?: PackRegistryEntry;
  readonly validation: PackValidationResult;
  /** Optional replay evidence for otherwise-valid candidates. Replay is not a safety gate. */
  readonly replayImpact?: PackReplayImpactSummary;
}

/** Pure availability report: registry entries plus discoverable package candidates. */
export interface PackAvailabilityValidationReport {
  readonly entries: readonly ValidatedAvailablePack[];
  readonly warnings: readonly string[];
}

export interface PackAvailabilityValidationInput {
  readonly registry: PackRegistry;
  readonly context: PackValidationContext;
  readonly packageCandidates?: readonly PackValidationCandidate[];
  readonly replayImpactByCandidateId?: ReadonlyMap<
    string,
    PackReplayImpactSummary
  >;
}

/**
 * Availability report filter: registry filters plus validation state.
 * Registry fields (`source`, `inBaseline`, `enabled`, `tag`) match only entries
 * that have a `registryEntry`; raw package candidates match validation-only
 * filters such as `canEnable` until they become registry-backed entries.
 */
export interface ValidatedAvailablePackFilter extends PackRegistryFilter {
  readonly canEnable?: boolean;
}

export type PackEnablementProposalReadiness =
  | {
      readonly status: "ready";
      readonly candidateId: string;
      readonly pack: PolicyPack;
      readonly validation: PackValidationResult;
      readonly replayImpact?: PackReplayImpactSummary;
      /** Validation and replay issues to show in ratchet cards before approval. */
      readonly issues: readonly PackValidationIssue[];
    }
  | {
      readonly status: "refused";
      readonly candidateId: string;
      readonly validation: PackValidationResult;
      readonly replayImpact?: PackReplayImpactSummary;
      /** Blocking validation issues plus any replay warnings for operator context. */
      readonly issues: readonly PackValidationIssue[];
      readonly reason: string;
    };

/**
 * Status transitions treated as replay regressions. Each is an unsafe shift
 * introduced (or revealed) by the candidate pack:
 * - `hard_block->fast_path` / `hard_block->review` loosen a previously-blocked
 *   command (deny→allow, deny→review).
 * - `fast_path->review` / `fast_path->hard_block` revoke an existing allow.
 *
 * `review->fast_path` is the desired ratchet expansion and is NOT a regression;
 * `review->hard_block` is a safe tightening and is also NOT a regression.
 */
const REGRESSION_TRANSITIONS =
  REPLAY_DELTA_REGRESSION_TRANSITIONS satisfies readonly `${ReplayStatus}->${ReplayStatus}`[];

/**
 * Build the proposed effective policy for replay by appending a candidate
 * pack's rules to the active lane.
 *
 * The sealed floor lane is preserved verbatim (its rule array is shared by
 * reference and never mutated); only a new `active` array is allocated, so
 * neither `currentPolicy` nor `pack` is mutated. The legacy `rules` flat view is
 * preserved for compatibility but ignored by the interpreter, which prefers
 * `active`.
 *
 * Candidate rules are appended, not substituted: existing active deny/review
 * rules keep their precedence (`deny > review > allow`), so a candidate allow
 * can only loosen `review`/fall-through commands to `fast_path` or tighten
 * `fast_path` commands — it can never override an existing deny. That invariant
 * is why `hard_block->fast_path` cannot arise from a pure-append candidate;
 * {@link summarizeReplayCompare} still classifies it defensively.
 */
export function policyWithCandidatePack(
  currentPolicy: EffectivePolicy,
  pack: PolicyPack,
): EffectivePolicy {
  const currentActive = currentPolicy.active ?? currentPolicy.rules ?? [];
  return {
    ...currentPolicy,
    active: [...currentActive, ...pack.rules],
  };
}

/**
 * Summarize a {@link ReplayCompare} into a pack replay-impact shape, classifying
 * status transitions into expansions and regressions. Pure: no replay, no
 * command execution, no I/O.
 *
 * Expansion: `review->fast_path` (a candidate allow newly fast-paths a reviewed
 * command) is the desired ratchet outcome — visible in `reviewToAllow`, never an
 * issue, and never a regression.
 *
 * Regressions surface as non-blocking `replay-impact-regression` warnings so
 * replay stays evidence rather than a safety gate (the sealed-floor gate in
 * {@link validateCompiledDataPackSafety} remains the safety boundary):
 * - `hard_block->fast_path` (deny→allow) and `hard_block->review` (deny→review)
 *   loosen a previously-blocked command.
 * - `fast_path->review` and `fast_path->hard_block` revoke an existing allow.
 *
 * `review->hard_block` (review→deny) is a safe tightening and is not flagged.
 *
 * `undefined` compare yields `status: "not-run"` so callers can attach a not-run
 * summary when a candidate cannot be enabled; {@link evaluatePackReplayImpact}
 * itself always runs replay for an otherwise-valid candidate and so produces
 * `"passed"` or `"regression"`.
 */
export function summarizeReplayCompare(
  compare: ReplayCompare | undefined,
): PackReplayImpactSummary {
  if (compare === undefined) {
    return notRunSummary();
  }

  const changedStatuses = narrowTransitionMap(compare.transitions);
  const reviewToAllow = changedStatuses.get("review->fast_path") ?? 0;
  const denyToAllow = changedStatuses.get("hard_block->fast_path") ?? 0;
  const allowToReviewOrDeny =
    (changedStatuses.get("fast_path->review") ?? 0) +
    (changedStatuses.get("fast_path->hard_block") ?? 0);

  const issues = collectRegressionIssues(changedStatuses);
  const status: "not-run" | "passed" | "regression" =
    issues.length > 0 ? "regression" : "passed";

  return {
    status,
    changedUnique: compare.changedUnique,
    changedCalls: compare.changedCalls,
    reviewToAllow,
    denyToAllow,
    allowToReviewOrDeny,
    changedStatuses,
    compare,
    issues,
  };
}

/**
 * Replay a candidate pack against captured history and summarize its impact.
 *
 * Builds the proposed policy with {@link policyWithCandidatePack} (append to
 * the active lane; floor preserved) and runs {@link replayHistory} with
 * `proposedPolicy`, then summarizes `report.compare` via
 * {@link summarizeReplayCompare}. Never executes commands: replay parses and
 * evaluates captured commands only. The parser and clock are forwarded so
 * tests are deterministic; absent a parser the default bash analyzer is used,
 * and an absent clock falls back to `new Date()`.
 *
 * This helper assumes the candidate is otherwise valid (schema/floor gates
 * already passed). Callers attach a `status: "not-run"` summary via
 * `summarizeReplayCompare(undefined)` when validation cannot enable.
 */
export async function evaluatePackReplayImpact(
  input: PackReplayImpactInput,
): Promise<PackReplayImpactSummary> {
  const proposedPolicy = policyWithCandidatePack(
    input.currentPolicy,
    input.pack,
  );
  const report = await replayHistory(input.corpus, input.currentPolicy, {
    proposedPolicy,
    ...(input.unknownToolPosture === undefined
      ? {}
      : { unknownToolPosture: input.unknownToolPosture }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  return summarizeReplayCompare(report.compare);
}

/**
 * Build the validated availability report consumed by discovery and ratchet
 * surfaces. Registry entries stay registry-backed and raw package candidates
 * stay discoverable even when malformed; both flow through validation before
 * any future enablement proposal treats them as usable policy.
 */
export function createPackAvailabilityValidationReport(
  input: PackAvailabilityValidationInput,
): PackAvailabilityValidationReport {
  const entries: ValidatedAvailablePack[] = [];

  for (const registryEntry of input.registry.entries) {
    const validation = validateRegistryEntry(registryEntry, input.context);
    entries.push(
      withOptionalReplayImpact(
        {
          candidateId: registryEntry.id,
          registryEntry,
          validation,
        },
        input.replayImpactByCandidateId,
      ),
    );
  }

  for (const candidate of input.packageCandidates ?? []) {
    const validation = validatePackCandidate(candidate, input.context);
    entries.push(
      withOptionalReplayImpact(
        {
          candidateId: validation.candidateId,
          validation,
        },
        input.replayImpactByCandidateId,
      ),
    );
  }

  return {
    entries,
    warnings: [
      ...input.registry.warnings,
      ...duplicateValidatedCandidateWarnings(entries),
    ],
  };
}

/** List validated packs, optionally filtering by registry fields and canEnable. */
export function listValidatedAvailablePacks(
  report: PackAvailabilityValidationReport,
  filter?: ValidatedAvailablePackFilter,
): readonly ValidatedAvailablePack[] {
  if (filter === undefined) {
    return report.entries;
  }

  return report.entries.filter((entry) =>
    validatedEntryMatchesFilter(entry, filter),
  );
}

/**
 * Return the unique validated pack for `candidateId`, or `undefined` when the id
 * is absent or ambiguous. Ambiguity is also surfaced in report warnings.
 */
export function getValidatedAvailablePack(
  report: PackAvailabilityValidationReport,
  candidateId: string,
): ValidatedAvailablePack | undefined {
  const matches = report.entries.filter(
    (entry) => entry.candidateId === candidateId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Typed handoff for future ratchet pack-enablement proposals. Validation is the
 * gate: unsafe/malformed candidates are refused before policy enablement, while
 * replay issues are carried as visible evidence rather than blocking safety.
 */
export function packEnablementProposalReadiness(
  entry: ValidatedAvailablePack,
): PackEnablementProposalReadiness {
  const issues = [
    ...entry.validation.issues,
    ...(entry.replayImpact?.issues ?? []),
  ];
  const replayImpact = entry.replayImpact;

  if (!entry.validation.canEnable || entry.validation.pack === null) {
    return {
      status: "refused",
      candidateId: entry.candidateId,
      validation: entry.validation,
      ...(replayImpact === undefined ? {} : { replayImpact }),
      issues,
      reason: refusedEnablementReason(entry.validation),
    };
  }

  return {
    status: "ready",
    candidateId: entry.candidateId,
    pack: entry.validation.pack,
    validation: entry.validation,
    ...(replayImpact === undefined ? {} : { replayImpact }),
    issues,
  };
}

function validateRegistryEntry(
  entry: PackRegistryEntry,
  _context: PackValidationContext,
): PackValidationResult {
  const issues: PackValidationIssue[] = [];
  collectSourceIssues(entry.source, issues);
  issues.push(...validateCompiledDataPackSafety({ pack: entry.pack }).issues);

  const canEnable = !hasBlockingValidationIssues(issues);
  return {
    candidateId: entry.id,
    kind: "data",
    source: entry.source,
    pack: entry.pack,
    issues,
    canDiscover: true,
    canEnable,
    canAffectPolicy: canEnable,
  };
}

function withOptionalReplayImpact(
  entry: Omit<ValidatedAvailablePack, "replayImpact">,
  replayImpactByCandidateId:
    | ReadonlyMap<string, PackReplayImpactSummary>
    | undefined,
): ValidatedAvailablePack {
  const replayImpact = replayImpactByCandidateId?.get(entry.candidateId);
  return replayImpact === undefined ? entry : { ...entry, replayImpact };
}

function duplicateValidatedCandidateWarnings(
  entries: readonly ValidatedAvailablePack[],
): string[] {
  const byId = new Map<string, number>();
  for (const entry of entries) {
    byId.set(entry.candidateId, (byId.get(entry.candidateId) ?? 0) + 1);
  }

  const warnings: string[] = [];
  for (const [candidateId, count] of byId) {
    if (count <= 1) {
      continue;
    }
    warnings.push(
      `Duplicate validated pack candidate id "${candidateId}" appears ${count} time(s); getValidatedAvailablePack returns undefined for this id because it is ambiguous.`,
    );
  }
  return warnings;
}

function validatedEntryMatchesFilter(
  entry: ValidatedAvailablePack,
  filter: ValidatedAvailablePackFilter,
): boolean {
  if (
    filter.canEnable !== undefined &&
    entry.validation.canEnable !== filter.canEnable
  ) {
    return false;
  }

  if (!hasRegistryFilter(filter)) {
    return true;
  }

  if (entry.registryEntry === undefined) {
    return false;
  }

  return (
    listPackRegistryEntries(
      { entries: [entry.registryEntry], warnings: [] },
      filter,
    ).length === 1
  );
}

function hasRegistryFilter(filter: PackRegistryFilter): boolean {
  return (
    filter.source !== undefined ||
    filter.inBaseline !== undefined ||
    filter.enabled !== undefined ||
    filter.tag !== undefined
  );
}

function refusedEnablementReason(validation: PackValidationResult): string {
  if (validation.pack === null) {
    return "pack did not produce a compiled policy pack";
  }
  return "pack validation reported blocking issues";
}

/**
 * A `status: "not-run"` summary with zero deltas and no issues, for callers
 * that skip replay when a candidate cannot be enabled.
 */
function notRunSummary(): PackReplayImpactSummary {
  return {
    status: "not-run",
    changedUnique: 0,
    changedCalls: 0,
    reviewToAllow: 0,
    denyToAllow: 0,
    allowToReviewOrDeny: 0,
    changedStatuses: new Map<`${ReplayStatus}->${ReplayStatus}`, number>(),
    issues: [],
  };
}

/**
 * Copy a `ReplayCompare.transitions` map into a fresh `Map` keyed by the
 * `${ReplayStatus}->${ReplayStatus}` literal type. `replayHistory` emits
 * transition keys as `${beforeStatus}->${afterStatus}` where both halves are
 * `ReplayStatus` values, so the assertion narrows the string key to its
 * status-transition literal type without changing the runtime contents; copying
 * into a fresh Map also isolates the summary from the producer's internal map.
 */
function narrowTransitionMap(
  transitions: ReadonlyMap<string, number>,
): ReadonlyMap<`${ReplayStatus}->${ReplayStatus}`, number> {
  const result = new Map<`${ReplayStatus}->${ReplayStatus}`, number>();
  for (const [key, count] of transitions) {
    result.set(key as `${ReplayStatus}->${ReplayStatus}`, count);
  }
  return result;
}

/** Build a non-blocking `replay-impact-regression` warning per regression transition. */
function collectRegressionIssues(
  changedStatuses: ReadonlyMap<`${ReplayStatus}->${ReplayStatus}`, number>,
): PackValidationIssue[] {
  const issues: PackValidationIssue[] = [];
  for (const transition of REGRESSION_TRANSITIONS) {
    const calls = changedStatuses.get(transition) ?? 0;
    if (calls <= 0) {
      continue;
    }
    issues.push({
      code: "replay-impact-regression",
      severity: "warning",
      // Embed the raw transition key (machine-greppable) alongside the
      // effect prose so ratchet cards and tests can match either form.
      message: `replay regression: candidate would shift ${calls} command call(s) ${transition} (${transitionEffect(transition)})`,
    });
  }
  return issues;
}

/** Effect-direction prose for a status transition, for issue messages. */
function transitionEffect(
  transition: `${ReplayStatus}->${ReplayStatus}`,
): string {
  switch (transition) {
    case "hard_block->fast_path":
      return "deny→allow";
    case "hard_block->review":
      return "deny→review";
    case "fast_path->review":
      return "allow→review";
    case "fast_path->hard_block":
      return "allow→deny";
    default:
      // Defensive: covers review->fast_path / review->hard_block and any future
      // transition. REGRESSION_TRANSITIONS currently excludes both, but this
      // keeps the message coherent if the set is widened.
      return transition;
  }
}
