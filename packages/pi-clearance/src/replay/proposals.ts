import { analyzeBashCommand } from "../parse/native-parser.ts";
import type { BashStage, ToolShape } from "../parse/shape.ts";
import {
  flattenStages,
  hasStdoutRedirect,
  hasSubstitution,
  primaryExecutableFromShape,
} from "../parse/shape-utils.ts";
import type {
  DecisionEffect,
  DecisionSource,
  EffectivePolicy,
  PolicyRule,
} from "../policy/core.ts";
import {
  classifyOverlap,
  compileMatch,
  evalMatcher,
  getMatcherExpr,
  inspectable,
  type MatcherExpr,
  type TriOverlap,
} from "../policy/core.ts";
import { programCatalogCommandsForExecutable } from "./adversarial.ts";
import type { CorpusFixtureRow } from "./history.ts";
import type {
  CapturedOutcomeLabel,
  PerCommandRow,
  RatchetReport,
  ReplayBashParser,
} from "./ratchet.ts";

export type ProposalKind = "data" | "core-matcher";

/** Where the apply skill routes an approved proposal. */
export type ProposalTarget =
  | "user-global"
  | "user-project"
  | "shipped-pack"
  | "core-matcher";

export type ProposalEffect = DecisionEffect;
export type ProposalScope = "global" | "project";

export interface ProposalExample {
  readonly command: string;
  readonly matches: boolean;
  readonly capturedOutcome?: CapturedOutcomeLabel;
  readonly note?: string;
}

/** A fixture the apply skill may add to the corpus. REFERENCE_PATTERNS vocabulary. */
export type ProposalFixtureSuggestion = CorpusFixtureRow;

export type FloorOverlapStatus = "disjoint" | "overlap" | "unknown";
export type FloorOverlapAction =
  | "emit"
  | "narrowed"
  | "downgraded-to-review"
  | "skipped-non-allow";

export interface FloorOverlapCheck {
  readonly status: FloorOverlapStatus;
  readonly action: FloorOverlapAction;
  readonly checkedFloorRuleIds: readonly string[];
  readonly overlappingFloorRuleIds: readonly string[];
  readonly note: string;
}

export interface ProposalEvidence {
  readonly executable: string;
  readonly calls: number;
  readonly unique: number;
  readonly reviewCalls: number;
  readonly hardBlockCalls: number;
  readonly modelReviewCalls: number;
  readonly capturedDenialCalls: number;
  readonly behaviors: readonly string[];
  readonly sampleCommands: readonly string[];
  readonly capturedOutcomeBreakdown: ReadonlyMap<CapturedOutcomeLabel, number>;
}

/** Proposed reusable core DSL matcher combinator (design input, not shipped here). */
export interface CoreMatcherDesignInput {
  readonly name: string;
  readonly signature: string;
  readonly gap: string;
  readonly rationale: string;
  readonly examples: readonly ProposalExample[];
}

export interface ProposalApprovalFraming {
  readonly writesExecutableCode: boolean;
  readonly touchesDsl: boolean;
  readonly routesAsDesignInput: boolean;
  readonly requiresAcknowledgment: boolean;
  readonly summary: string;
}

export interface RuleProposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly target: ProposalTarget;
  readonly effect: ProposalEffect;
  readonly ruleId: string;
  readonly packId?: string;
  readonly match?: unknown;
  readonly compiledMatch?: MatcherExpr;
  readonly reason: string;
  readonly scope: ProposalScope;
  readonly provenance: { readonly source: "generated" };
  readonly intendedProvenance: DecisionSource;
  readonly evidence: ProposalEvidence;
  readonly examples: readonly ProposalExample[];
  readonly fixtureSuggestions: readonly ProposalFixtureSuggestion[];
  readonly floorOverlap: FloorOverlapCheck;
  readonly coreMatcher?: CoreMatcherDesignInput;
  readonly approvalFraming: ProposalApprovalFraming;
  readonly modelDrafted: boolean;
  readonly warnings: readonly string[];
}

export type ClusterAddressableBy = "data" | "core-matcher" | "none";

export interface CommandSignature {
  readonly program: string | undefined;
  readonly arg0Set: readonly string[];
  readonly flags: readonly string[];
  readonly hasSubstitution: boolean;
  readonly hasStdoutRedirect: boolean;
  readonly parseDiagnostics: readonly string[];
}

export interface FrictionCluster {
  readonly executable: string;
  readonly rows: readonly PerCommandRow[];
  readonly signature: CommandSignature;
  readonly addressableBy: ClusterAddressableBy;
  readonly frictionScore: number;
  readonly behaviors: readonly string[];
  readonly sampleCommands: readonly string[];
  readonly evidence: ProposalEvidence;
  readonly notes: readonly string[];
}

export interface ClusterFrictionOptions {
  /** default analyzeBashCommand; injected to avoid WASM in unit tests */
  readonly bashParser?: ReplayBashParser;
  /** default 50 */
  readonly maxClusters?: number;
}

export interface DraftedMatcher {
  /** Exact JSON DSL matcher text that the apply skill can show or write. */
  readonly match: unknown;
  /** Derived IR from compileMatch; match is the source of truth. */
  readonly compiled: MatcherExpr;
  readonly effect: ProposalEffect;
  readonly origin: "structural" | "model";
  readonly notes: readonly string[];
}

export type FloorOverlapOutcome =
  | { readonly action: "emit" }
  | { readonly action: "narrowed"; readonly narrowed: DraftedMatcher }
  | {
      readonly action: "downgraded-to-review";
      readonly downgraded: DraftedMatcher;
    }
  | { readonly action: "skipped-non-allow"; readonly note: string };

export interface ModelDraftContext {
  readonly cluster: FrictionCluster;
  readonly floor: readonly PolicyRule[];
  readonly existingRuleIds: ReadonlySet<string>;
}

export interface ModelDraftResult {
  readonly match: unknown;
  readonly effect: ProposalEffect;
  readonly reason: string;
}

/** Optional model-drafting port. Default: none (deterministic structural drafting only). */
export type ModelDrafter = (
  context: ModelDraftContext,
) => Promise<ModelDraftResult | undefined>;

export interface ProposeRulesInput {
  readonly report: RatchetReport;
  readonly currentPolicy: EffectivePolicy;
}

export interface ProposeRulesOptions {
  readonly bashParser?: ReplayBashParser;
  readonly modelDrafter?: ModelDrafter;
  readonly clock?: () => Date;
  readonly maxProposals?: number;
  readonly maxClusters?: number;
}

interface ParsedCommandFacts {
  readonly signature: CommandSignature;
  readonly notes: readonly string[];
}

interface ParsedFrictionRow {
  readonly row: PerCommandRow;
  readonly executable: string;
  readonly signature: CommandSignature;
  readonly notes: readonly string[];
}

interface MutableCluster {
  readonly executable: string;
  readonly rows: PerCommandRow[];
  readonly signatures: CommandSignature[];
  readonly notes: string[];
}

interface SelectedDraft {
  readonly draft: DraftedMatcher;
  readonly floorOutcome: FloorOverlapOutcome;
}

interface ProposalTargeting {
  readonly kind: ProposalKind;
  readonly target: ProposalTarget;
  readonly scope: ProposalScope;
  readonly intendedProvenance: DecisionSource;
  readonly packId?: string;
}

const DEFAULT_MAX_CLUSTERS = 50;
// Ratchet runs are not inherently one-change runs. The cap keeps noisy first
// passes readable while still allowing an initial backlog to produce a real
// evidence-sized set of proposals.
const DEFAULT_MAX_PROPOSALS = 20;
const DEFAULT_SAMPLE_COMMAND_LIMIT = 5;

const CAPTURED_OUTCOME_LABELS = [
  "deterministic-allow",
  "deterministic-deny",
  "deterministic-review",
  "model-allow",
  "model-deny",
  "model-review",
  "human-allow",
  "human-deny",
  "block-and-log",
  "fixture-fast-path",
  "fixture-review",
  "fixture-hard-block",
  "no-captured-outcome",
] as const satisfies readonly CapturedOutcomeLabel[];

const MODEL_OUTCOME_LABELS = new Set<CapturedOutcomeLabel>([
  "model-allow",
  "model-deny",
  "model-review",
]);

const DENIAL_OUTCOME_LABELS = new Set<CapturedOutcomeLabel>([
  "deterministic-deny",
  "model-deny",
  "human-deny",
  "block-and-log",
  "fixture-hard-block",
]);

const RISKY_ALLOW_BEHAVIORS = new Set([
  "destructive-git",
  "force-push",
  "branch-delete",
  "worktree-remove",
  "hard-reset",
  "git-clean",
  "recursive-delete",
  "privilege-escalation",
  "broad-chmod",
  "fork-bomb",
  "disk-destructive",
  "system-shutdown",
  "remote-shell",
]);

const SAFETY_FLAG_PROGRAMS = new Set(["prettier"]);

interface FloorCheckResult {
  readonly allDisjoint: boolean;
  readonly hasOverlap: boolean;
  readonly hasUnknown: boolean;
  readonly checkedRuleIds: readonly string[];
  readonly unsafeRuleIds: readonly string[];
}

interface DecidableFloorFacts {
  readonly programs: readonly string[];
  readonly arg0Values: readonly string[];
}

/**
 * Group the report's friction into clusters. Pure and total: parses sample commands
 * through the injected bash parser to derive each cluster's CommandSignature and
 * addressableBy classification. Never executes commands; never reads files.
 */
export async function clusterFriction(
  report: RatchetReport,
  options?: ClusterFrictionOptions,
): Promise<readonly FrictionCluster[]> {
  const rows = validFrictionRows(report);
  if (rows.length === 0) {
    return [];
  }

  const parser = options?.bashParser ?? analyzeBashCommand;
  const parseCache = new Map<string, Promise<ParsedCommandFacts>>();
  const parsedRows = await Promise.all(
    rows.map(async (row) => parsedRow(row, parser, parseCache)),
  );
  const clusters = new Map<string, MutableCluster>();

  for (const parsed of parsedRows) {
    if (parsed === null) {
      continue;
    }

    const key = clusterKey(parsed.executable, parsed.signature.arg0Set);
    const cluster = clusters.get(key) ?? {
      executable: parsed.executable,
      rows: [],
      signatures: [],
      notes: [],
    };
    cluster.rows.push(parsed.row);
    cluster.signatures.push(parsed.signature);
    cluster.notes.push(...parsed.notes);
    clusters.set(key, cluster);
  }

  return [...clusters.values()]
    .map(finalizeCluster)
    .sort(compareClusters)
    .slice(0, boundedLimit(options?.maxClusters, DEFAULT_MAX_CLUSTERS));
}

/**
 * Deterministic structural drafter for data-shaped friction clusters.
 * It emits the same JSON DSL vocabulary as shipped packs and derives IR only
 * through compileMatch so proposal text remains the single source of truth.
 */
export function draftStructuralMatcher(
  cluster: FrictionCluster,
): DraftedMatcher | null {
  try {
    const program = nonEmpty(cluster.signature.program);
    if (program === undefined) {
      return null;
    }

    const match = structuralMatchForCluster(cluster, program);
    const compiled = compileMatch(match);
    if ("errors" in compiled) {
      return null;
    }

    const riskyAllow = cluster.behaviors.some((behavior) =>
      RISKY_ALLOW_BEHAVIORS.has(behavior),
    );
    const canAllow =
      !riskyAllow &&
      !cluster.signature.hasSubstitution &&
      !cluster.signature.hasStdoutRedirect;

    return {
      match,
      compiled: compiled.expr,
      effect: canAllow ? "allow" : "review",
      origin: "structural",
      notes: structuralDraftNotes(cluster, { riskyAllow, canAllow }),
    };
  } catch {
    return null;
  }
}

/**
 * Mirror loadEffectivePolicy's allow-vs-floor check at the proposal stage.
 * Allow drafts must be provably disjoint from every sealed floor deny; when
 * a safe finite narrowing is possible, return it, otherwise downgrade to review.
 */
export function checkFloorOverlap(
  draft: DraftedMatcher,
  floor: readonly PolicyRule[],
): FloorOverlapOutcome {
  if (draft.effect !== "allow") {
    return {
      action: "skipped-non-allow",
      note: "floor overlap check applies only to allow proposals",
    };
  }

  try {
    const initial = checkAgainstFloor(draft.compiled, floor);
    if (initial.allDisjoint) {
      return { action: "emit" };
    }

    if (initial.hasOverlap) {
      const narrowed = narrowAllowDraft(draft, floor);
      if (narrowed !== null) {
        const narrowedCheck = checkAgainstFloor(narrowed.compiled, floor);
        if (narrowedCheck.allDisjoint) {
          return { action: "narrowed", narrowed };
        }
      }
    }

    return {
      action: "downgraded-to-review",
      downgraded: downgradeDraftToReview(draft, initial),
    };
  } catch {
    return {
      action: "downgraded-to-review",
      downgraded: {
        ...draft,
        effect: "review",
        notes: [
          ...draft.notes,
          "downgraded to review because floor overlap checking failed closed",
        ],
      },
    };
  }
}

/**
 * Validate a model-drafted matcher with the same bar as structural drafts:
 * compile through the DSL, prove or narrow floor disjointness, then verify
 * positives and adversarial near-misses. Any failure discards the draft.
 */
export async function validateModelDraft(
  draft: ModelDraftResult,
  cluster: FrictionCluster,
  floor: readonly PolicyRule[],
  options: { readonly bashParser?: ReplayBashParser } = {},
): Promise<DraftedMatcher | null> {
  try {
    const compiled = compileMatch(draft.match);
    if ("errors" in compiled) {
      return null;
    }

    const candidate: DraftedMatcher = {
      match: draft.match,
      compiled: compiled.expr,
      effect: draft.effect,
      origin: "model",
      notes: [`model reason: ${draft.reason}`],
    };
    const checked = checkFloorOverlap(candidate, floor);
    const floorSafe = modelDraftAfterFloorCheck(candidate, checked);
    if (floorSafe === null) {
      return null;
    }

    const verified = await verifyDraftSamples(
      floorSafe,
      cluster,
      parserOption(options.bashParser),
    );
    return verified ? floorSafe : null;
  } catch {
    return null;
  }
}

/**
 * Pure proposal generator. Runs cluster → draft → floor-check → annotate,
 * dedups against active policy, sorts by friction, and caps. The returned
 * proposal set is sized to evidence, not forced to one item; applying/writing
 * remains the apply skill's approval-gated job.
 */
export async function proposeRules(
  input: ProposeRulesInput,
  options?: ProposeRulesOptions,
): Promise<readonly RuleProposal[]> {
  try {
    if (!isRecord(input) || !isRecord(input.currentPolicy)) {
      return [];
    }

    const floor = Array.isArray(input.currentPolicy.floor)
      ? input.currentPolicy.floor
      : [];
    const active = Array.isArray(input.currentPolicy.active)
      ? input.currentPolicy.active
      : Array.isArray(input.currentPolicy.rules)
        ? input.currentPolicy.rules
        : [];
    const existingRuleIds = new Set(active.map((rule) => rule.id));
    const activeMatcherKeys = activeRuleMatcherKeys(active);
    const clusters = await clusterFriction(
      input.report,
      clusterOptions(options),
    );
    const proposals: RuleProposal[] = [];

    for (const cluster of clusters) {
      if (cluster.addressableBy === "core-matcher") {
        proposals.push(designInputProposal(cluster));
        continue;
      }

      const selected = await chooseDraftForCluster(
        cluster,
        floor,
        existingRuleIds,
        draftChoiceOptions(options),
      );
      if (
        selected === null ||
        existingRuleIds.has(generatedRuleId(cluster, selected.draft)) ||
        dedupedByActive(selected.draft, activeMatcherKeys)
      ) {
        continue;
      }

      const proposal = await dataProposal(
        cluster,
        selected,
        floor,
        parserOption(options?.bashParser),
      );
      if (proposal !== null) {
        proposals.push(proposal);
      }
    }

    return proposals
      .sort(compareProposals)
      .slice(0, boundedLimit(options?.maxProposals, DEFAULT_MAX_PROPOSALS));
  } catch {
    return [];
  }
}

async function chooseDraftForCluster(
  cluster: FrictionCluster,
  floor: readonly PolicyRule[],
  existingRuleIds: ReadonlySet<string>,
  options: {
    readonly bashParser?: ReplayBashParser;
    readonly modelDrafter?: ModelDrafter;
  },
): Promise<SelectedDraft | null> {
  if (options.modelDrafter !== undefined) {
    try {
      const modelDraft = await options.modelDrafter({
        cluster,
        floor,
        existingRuleIds,
      });
      if (modelDraft !== undefined) {
        const selected = await selectModelDraft(
          modelDraft,
          cluster,
          floor,
          parserOption(options.bashParser),
        );
        if (selected !== null) {
          return selected;
        }
      }
    } catch {
      // Model drafting is optional evidence. A failing adapter falls back to
      // deterministic structural drafting rather than changing correctness.
    }
  }

  const structural = draftStructuralMatcher(cluster);
  if (structural === null) {
    return null;
  }

  const floorOutcome = checkFloorOverlap(structural, floor);
  return {
    draft: structuralDraftAfterFloorCheck(structural, floorOutcome),
    floorOutcome,
  };
}

async function selectModelDraft(
  draft: ModelDraftResult,
  cluster: FrictionCluster,
  floor: readonly PolicyRule[],
  options: { readonly bashParser?: ReplayBashParser },
): Promise<SelectedDraft | null> {
  try {
    const compiled = compileMatch(draft.match);
    if ("errors" in compiled) {
      return null;
    }

    const candidate: DraftedMatcher = {
      match: draft.match,
      compiled: compiled.expr,
      effect: draft.effect,
      origin: "model",
      notes: [`model reason: ${draft.reason}`],
    };
    const floorOutcome = checkFloorOverlap(candidate, floor);
    const floorSafe = modelDraftAfterFloorCheck(candidate, floorOutcome);
    if (floorSafe === null) {
      return null;
    }

    const verified = await verifyDraftSamples(floorSafe, cluster, options);
    return verified ? { draft: floorSafe, floorOutcome } : null;
  } catch {
    return null;
  }
}

function clusterOptions(
  options: ProposeRulesOptions | undefined,
): ClusterFrictionOptions {
  return {
    ...(options?.bashParser === undefined
      ? {}
      : { bashParser: options.bashParser }),
    ...(options?.maxClusters === undefined
      ? {}
      : { maxClusters: options.maxClusters }),
  };
}

function draftChoiceOptions(options: ProposeRulesOptions | undefined): {
  readonly bashParser?: ReplayBashParser;
  readonly modelDrafter?: ModelDrafter;
} {
  return {
    ...(options?.bashParser === undefined
      ? {}
      : { bashParser: options.bashParser }),
    ...(options?.modelDrafter === undefined
      ? {}
      : { modelDrafter: options.modelDrafter }),
  };
}

function parserOption(bashParser: ReplayBashParser | undefined): {
  readonly bashParser?: ReplayBashParser;
} {
  return bashParser === undefined ? {} : { bashParser };
}

function modelDraftAfterFloorCheck(
  draft: DraftedMatcher,
  outcome: FloorOverlapOutcome,
): DraftedMatcher | null {
  switch (outcome.action) {
    case "emit":
    case "skipped-non-allow":
      return draft;
    case "narrowed":
      return outcome.narrowed;
    case "downgraded-to-review":
      // A model draft that cannot pass as written-or-narrowed is evidence only;
      // do not relax it into a review rule on the model's behalf.
      return null;
  }
}

function structuralDraftAfterFloorCheck(
  draft: DraftedMatcher,
  outcome: FloorOverlapOutcome,
): DraftedMatcher {
  switch (outcome.action) {
    case "emit":
    case "skipped-non-allow":
      return draft;
    case "narrowed":
      return outcome.narrowed;
    case "downgraded-to-review":
      return outcome.downgraded;
  }
}

async function verifyDraftSamples(
  draft: DraftedMatcher,
  cluster: FrictionCluster,
  options: { readonly bashParser?: ReplayBashParser },
): Promise<boolean> {
  if (cluster.sampleCommands.length === 0) {
    return false;
  }

  const parser = options.bashParser ?? analyzeBashCommand;
  const matcher = inspectable(draft.compiled);

  for (const command of cluster.sampleCommands) {
    const shape = await parser(command);
    if (!evalMatcher(matcher, shape)) {
      return false;
    }
  }

  for (const command of negativeSampleCommands(cluster)) {
    const shape = await parser(command);
    if (evalMatcher(matcher, shape)) {
      return false;
    }
  }

  return true;
}

function negativeSampleCommands(cluster: FrictionCluster): readonly string[] {
  const executable = cluster.signature.program ?? cluster.executable;
  const candidates = programCatalogCommandsForExecutable(executable);
  const positives = new Set(cluster.sampleCommands);
  return candidates.filter((command) => !positives.has(command));
}

async function dataProposal(
  cluster: FrictionCluster,
  selected: SelectedDraft,
  floor: readonly PolicyRule[],
  options: { readonly bashParser?: ReplayBashParser },
): Promise<RuleProposal | null> {
  const { draft, floorOutcome } = selected;
  if (
    draft.effect === "allow" &&
    floorOutcome.action !== "emit" &&
    floorOutcome.action !== "narrowed"
  ) {
    return null;
  }

  const examples = await verifiedDataExamples(cluster, draft, options);
  const positiveExamples = examples.filter((example) => example.matches);
  if (positiveExamples.length === 0) {
    return null;
  }

  const ruleId = generatedRuleId(cluster, draft);
  const targeting = dataTargeting(cluster);
  const floorOverlap = floorOverlapCheckFromOutcome(floorOutcome, floor);
  const fixtureSuggestions = fixturesForProposal(
    `prop:${ruleId}`,
    draft.effect,
    examples,
  );

  return {
    id: `prop:${ruleId}`,
    kind: targeting.kind,
    target: targeting.target,
    effect: draft.effect,
    ruleId,
    ...(targeting.packId === undefined ? {} : { packId: targeting.packId }),
    match: draft.match,
    compiledMatch: draft.compiled,
    reason: proposalReason(cluster, draft),
    scope: targeting.scope,
    provenance: { source: "generated" },
    intendedProvenance: targeting.intendedProvenance,
    evidence: cluster.evidence,
    examples,
    fixtureSuggestions,
    floorOverlap,
    approvalFraming: approvalFraming(targeting),
    modelDrafted: draft.origin === "model",
    warnings: sortedUnique([
      ...cluster.notes,
      ...draft.notes,
      floorOverlap.note,
    ]),
  };
}

function designInputProposal(cluster: FrictionCluster): RuleProposal {
  const targeting: ProposalTargeting = {
    kind: "core-matcher",
    target: "core-matcher",
    scope: "global",
    intendedProvenance: "shipped",
  };
  const kind = targeting.kind;
  const effect: ProposalEffect = "review";
  const ruleId = sanitizeRuleId(
    `generated-${kind}-${cluster.executable}-${signatureSlug(cluster)}`,
  );
  const floorOverlap: FloorOverlapCheck = {
    status: "disjoint",
    action: "skipped-non-allow",
    checkedFloorRuleIds: [],
    overlappingFloorRuleIds: [],
    note: `${kind} proposal is a design input, not an allow rule`,
  };
  const examples = cluster.sampleCommands.map((command) =>
    proposalExample({
      command,
      matches: true,
      capturedOutcome: capturedOutcomeForCommand(cluster, command),
      note: `${kind} representative friction example`,
    }),
  );
  const shared = {
    id: `prop:${ruleId}`,
    kind: targeting.kind,
    target: targeting.target,
    effect,
    ruleId,
    reason: designInputReason(cluster),
    scope: targeting.scope,
    provenance: { source: "generated" as const },
    intendedProvenance: targeting.intendedProvenance,
    evidence: cluster.evidence,
    examples,
    fixtureSuggestions: fixturesForProposal(`prop:${ruleId}`, effect, examples),
    floorOverlap,
    approvalFraming: approvalFraming(targeting),
    modelDrafted: false,
    warnings: sortedUnique([...cluster.notes, floorOverlap.note]),
  };

  if (kind === "core-matcher") {
    const coreMatcher: CoreMatcherDesignInput = {
      name: proposedCoreMatcherName(cluster),
      signature: proposedCoreMatcherSignature(cluster),
      gap: "Current data DSL cannot express the value-shape guard this command family needs.",
      rationale: designInputReason(cluster),
      examples,
    };
    return { ...shared, coreMatcher };
  }

  return { ...shared };
}

async function verifiedDataExamples(
  cluster: FrictionCluster,
  draft: DraftedMatcher,
  options: { readonly bashParser?: ReplayBashParser },
): Promise<readonly ProposalExample[]> {
  const parser = options.bashParser ?? analyzeBashCommand;
  const matcher = inspectable(draft.compiled);
  const examples: ProposalExample[] = [];

  for (const command of cluster.sampleCommands) {
    if (await commandMatches(command, matcher, parser)) {
      examples.push(
        proposalExample({
          command,
          matches: true,
          capturedOutcome: capturedOutcomeForCommand(cluster, command),
          note: "corpus command verified against proposed matcher",
        }),
      );
    }
  }

  for (const command of negativeSampleCommands(cluster)) {
    const matches = await commandMatches(command, matcher, parser);
    if (!matches) {
      examples.push({
        command,
        matches: false,
        note: "adversarial near-miss verified not to match",
      });
    }
  }

  return examples;
}

async function commandMatches(
  command: string,
  matcher: ReturnType<typeof inspectable>,
  parser: ReplayBashParser,
): Promise<boolean> {
  try {
    return evalMatcher(matcher, await parser(command));
  } catch {
    return false;
  }
}

function proposalExample(input: {
  readonly command: string;
  readonly matches: boolean;
  readonly capturedOutcome?: CapturedOutcomeLabel | undefined;
  readonly note?: string | undefined;
}): ProposalExample {
  return {
    command: input.command,
    matches: input.matches,
    ...(input.capturedOutcome === undefined
      ? {}
      : { capturedOutcome: input.capturedOutcome }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
}

function capturedOutcomeForCommand(
  cluster: FrictionCluster,
  command: string,
): CapturedOutcomeLabel | undefined {
  const row = cluster.rows.find((candidate) => candidate.command === command);
  if (row === undefined) {
    return undefined;
  }

  for (const label of CAPTURED_OUTCOME_LABELS) {
    const count = row.capturedOutcomes.get(label);
    if (count !== undefined && count > 0) {
      return label;
    }
  }

  return undefined;
}

function fixturesForProposal(
  proposalId: string,
  effect: ProposalEffect,
  examples: readonly ProposalExample[],
): readonly ProposalFixtureSuggestion[] {
  return examples.map((example) => ({
    command: example.command,
    expected: example.matches
      ? expectedForPositive(effect)
      : expectedForNegative(example.command),
    reason: example.matches
      ? `Positive example for ${proposalId}`
      : `Adversarial near-miss for ${proposalId}`,
    provenance: proposalId,
  }));
}

function expectedForPositive(
  effect: ProposalEffect,
): "fast_path" | "review" | "hard_block" {
  switch (effect) {
    case "allow":
      return "fast_path";
    case "deny":
      return "hard_block";
    case "review":
      return "review";
  }
}

function expectedForNegative(command: string): "review" | "hard_block" {
  return /\b(rm\s+-rf\s+--\s+\/|sudo\b|systemctl\s+reboot|chmod\s+-R\s+777|\|\s*(sh|bash)\b)/.test(
    command,
  )
    ? "hard_block"
    : "review";
}

function floorOverlapCheckFromOutcome(
  outcome: FloorOverlapOutcome,
  floor: readonly PolicyRule[],
): FloorOverlapCheck {
  const checkedFloorRuleIds = floor
    .filter((rule) => rule.effect === "deny")
    .map((rule) => rule.id);

  switch (outcome.action) {
    case "emit":
      return {
        status: "disjoint",
        action: "emit",
        checkedFloorRuleIds,
        overlappingFloorRuleIds: [],
        note: "allow draft is disjoint from checked floor denies",
      };
    case "narrowed":
      return {
        status: "disjoint",
        action: "narrowed",
        checkedFloorRuleIds,
        overlappingFloorRuleIds: [],
        note: "allow draft was narrowed to a floor-disjoint matcher",
      };
    case "downgraded-to-review":
      return {
        status: "unknown",
        action: "downgraded-to-review",
        checkedFloorRuleIds,
        overlappingFloorRuleIds: [],
        note: "allow draft was downgraded to review because floor safety was not provable",
      };
    case "skipped-non-allow":
      return {
        status: "disjoint",
        action: "skipped-non-allow",
        checkedFloorRuleIds,
        overlappingFloorRuleIds: [],
        note: outcome.note,
      };
  }
}

function dataTargeting(cluster: FrictionCluster): ProposalTargeting {
  const packId = shippedPackCandidate(cluster);
  if (packId !== undefined) {
    return {
      kind: "data",
      target: "shipped-pack",
      scope: "global",
      intendedProvenance: "shipped",
      packId,
    };
  }

  if (isGeneralDevCommand(cluster)) {
    return {
      kind: "data",
      target: "user-global",
      scope: "global",
      intendedProvenance: "user-global",
    };
  }

  return {
    kind: "data",
    target: "user-project",
    scope: "project",
    intendedProvenance: "user-project",
  };
}

function shippedPackCandidate(cluster: FrictionCluster): string | undefined {
  const program = cluster.signature.program ?? cluster.executable;
  const arg0 = new Set(cluster.signature.arg0Set);

  if (
    ["pnpm", "npm", "yarn"].includes(program) &&
    [...arg0].some((value) =>
      [
        "test",
        "build",
        "lint",
        "typecheck",
        "check",
        "run",
        "run-script",
      ].includes(value),
    )
  ) {
    return "bash.dev.verify";
  }

  if (
    [
      "cargo",
      "go",
      "vitest",
      "jest",
      "pytest",
      "tsc",
      "biome",
      "eslint",
      "prettier",
      "ruff",
      "mypy",
    ].includes(program)
  ) {
    return "bash.dev.verify";
  }

  return undefined;
}

function isGeneralDevCommand(cluster: FrictionCluster): boolean {
  return [
    "git",
    "gh",
    "rg",
    "grep",
    "find",
    "ls",
    "cat",
    "head",
    "tail",
  ].includes(cluster.signature.program ?? cluster.executable);
}

function approvalFraming(
  targeting: ProposalTargeting,
): ProposalApprovalFraming {
  const writesExecutableCode = false;
  const touchesDsl = targeting.kind === "core-matcher";
  const routesAsDesignInput =
    targeting.kind === "core-matcher" || targeting.target === "shipped-pack";
  const requiresAcknowledgment = writesExecutableCode || touchesDsl;

  return {
    writesExecutableCode,
    touchesDsl,
    routesAsDesignInput,
    requiresAcknowledgment,
    summary: approvalSummary(targeting, {
      writesExecutableCode,
      touchesDsl,
      routesAsDesignInput,
      requiresAcknowledgment,
    }),
  };
}

function approvalSummary(
  targeting: ProposalTargeting,
  flags: Omit<ProposalApprovalFraming, "summary">,
): string {
  if (flags.touchesDsl) {
    return "core matcher DSL design input; requires explicit acknowledgment";
  }
  if (flags.routesAsDesignInput) {
    return "shipped-pack design input; apply skill routes without writing shipped code";
  }
  return `data-only ${targeting.target} overlay proposal`;
}

function proposalReason(
  cluster: FrictionCluster,
  draft: DraftedMatcher,
): string {
  if (draft.origin === "model") {
    const modelReason = draft.notes.find((note) =>
      note.startsWith("model reason: "),
    );
    if (modelReason !== undefined) {
      return modelReason.replace("model reason: ", "");
    }
  }

  return `Reduce repeated ${cluster.executable} review friction with a validated ${draft.origin} matcher.`;
}

function designInputReason(cluster: FrictionCluster): string {
  return `Route repeated ${cluster.executable} friction to a core DSL matcher design because the data DSL lacks the needed value-shape guard.`;
}

function proposedCoreMatcherName(cluster: FrictionCluster): string {
  return `${sanitizeIdentifier(cluster.executable)}ArgMatchesProjectPath`;
}

function proposedCoreMatcherSignature(cluster: FrictionCluster): string {
  const arg0 = cluster.signature.arg0Set[0] ?? "<subcommand>";
  return `{ program: ${JSON.stringify(cluster.executable)}, arg0: ${JSON.stringify(arg0)}, argMatchesProjectPath: { index: 1 } }`;
}

function generatedRuleId(
  cluster: FrictionCluster,
  draft: DraftedMatcher,
): string {
  return sanitizeRuleId(
    `generated-${draft.effect}-${cluster.executable}-${signatureSlug(cluster)}`,
  );
}

function signatureSlug(cluster: FrictionCluster): string {
  return cluster.signature.arg0Set.length
    ? cluster.signature.arg0Set.join("-")
    : "any";
}

function sanitizeIdentifier(value: string): string {
  const words = sanitizeRuleId(value)
    .split("-")
    .filter((part) => part.length > 0);
  const [first = "command", ...rest] = words;
  return [
    first,
    ...rest.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`),
  ].join("");
}

function sanitizeRuleId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function activeRuleMatcherKeys(
  rules: readonly PolicyRule[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const rule of rules) {
    const expr = getMatcherExpr(rule.match);
    if (expr !== null) {
      keys.add(matcherDedupKey(rule.effect, expr));
    }
  }
  return keys;
}

function dedupedByActive(
  draft: DraftedMatcher,
  activeMatcherKeys: ReadonlySet<string>,
): boolean {
  return activeMatcherKeys.has(matcherDedupKey(draft.effect, draft.compiled));
}

function matcherDedupKey(effect: ProposalEffect, expr: MatcherExpr): string {
  return `${effect}:${stableStringify(canonicalMatcherExpr(expr))}`;
}

function canonicalMatcherExpr(expr: MatcherExpr): unknown {
  switch (expr.kind) {
    case "arg0In":
      return { kind: expr.kind, values: sortedUnique(expr.values) };
    case "all":
    case "any":
      return {
        kind: expr.kind,
        of: expr.of
          .map(canonicalMatcherExpr)
          .sort((left, right) =>
            stableStringify(left).localeCompare(stableStringify(right)),
          ),
      };
    case "stageEvery":
    case "stageSome":
      return { kind: expr.kind, inner: canonicalMatcherExpr(expr.inner) };
    case "composition":
      return {
        kind: expr.kind,
        stage: canonicalMatcherExpr(expr.stage),
        operators: sortedUnique(expr.operators),
        allowBackground: expr.allowBackground === true,
        minStages: expr.minStages ?? 1,
        orFallback:
          expr.orFallback === undefined ? [] : sortedUnique(expr.orFallback),
      };
    case "not":
      return { kind: expr.kind, of: canonicalMatcherExpr(expr.of) };
    default:
      return expr;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareProposals(left: RuleProposal, right: RuleProposal): number {
  return (
    proposalFrictionScore(right) - proposalFrictionScore(left) ||
    right.evidence.calls - left.evidence.calls ||
    left.ruleId.localeCompare(right.ruleId)
  );
}

function proposalFrictionScore(proposal: RuleProposal): number {
  return (
    proposal.evidence.reviewCalls +
    proposal.evidence.hardBlockCalls +
    proposal.evidence.capturedDenialCalls +
    proposal.evidence.modelReviewCalls
  );
}

function structuralMatchForCluster(
  cluster: FrictionCluster,
  program: string,
): unknown {
  const clauses: unknown[] = [
    { program },
    ...arg0Clause(cluster.signature.arg0Set),
    { noSubstitution: true },
    { noStdoutRedirect: true },
    ...loadBearingSafetyFlagClauses(cluster.signature),
  ];

  return { all: clauses };
}

function arg0Clause(arg0Set: readonly string[]): readonly unknown[] {
  const values = sortedUnique(arg0Set);
  return values.length === 0 ? [] : [{ arg0In: values }];
}

function loadBearingSafetyFlagClauses(
  signature: CommandSignature,
): readonly unknown[] {
  const flags = new Set(signature.flags.map(normalizeFlagName));
  if (!flags.has("check")) {
    return [];
  }

  if (
    (signature.program !== undefined &&
      SAFETY_FLAG_PROGRAMS.has(signature.program)) ||
    (signature.program === "cargo" && signature.arg0Set.includes("fmt"))
  ) {
    return [{ flagPresent: "check" }];
  }

  return [];
}

function structuralDraftNotes(
  cluster: FrictionCluster,
  flags: { readonly riskyAllow: boolean; readonly canAllow: boolean },
): readonly string[] {
  const notes = [
    "structural draft uses program/arg0 guards plus hidden-shell output guards",
  ];

  if (cluster.signature.arg0Set.length === 0) {
    notes.push("no arg0 constraint available from the cluster signature");
  }

  if (cluster.signature.hasSubstitution) {
    notes.push("drafted as review because cluster contains substitution");
  }

  if (cluster.signature.hasStdoutRedirect) {
    notes.push("drafted as review because cluster contains stdout redirect");
  }

  if (flags.riskyAllow) {
    notes.push("drafted as review because cluster has risky-allow behavior");
  }

  if (flags.canAllow) {
    notes.push("drafted as allow because guards and risk checks passed");
  }

  return notes;
}

export function checkAgainstFloor(
  expr: MatcherExpr,
  floor: readonly PolicyRule[],
): FloorCheckResult {
  const checkedRuleIds: string[] = [];
  const unsafeRuleIds: string[] = [];
  let hasOverlap = false;
  let hasUnknown = false;

  for (const floorRule of floor) {
    if (floorRule.effect !== "deny") {
      continue;
    }

    checkedRuleIds.push(floorRule.id);
    const floorExpr = getMatcherExpr(floorRule.match);
    const overlap: TriOverlap =
      floorExpr === null ? "unknown" : classifyOverlap(expr, floorExpr);

    if (overlap === "disjoint") {
      continue;
    }

    unsafeRuleIds.push(floorRule.id);
    if (overlap === "overlap") {
      hasOverlap = true;
    } else {
      hasUnknown = true;
    }
  }

  return {
    allDisjoint: !hasOverlap && !hasUnknown,
    hasOverlap,
    hasUnknown,
    checkedRuleIds,
    unsafeRuleIds,
  };
}

function narrowAllowDraft(
  draft: DraftedMatcher,
  floor: readonly PolicyRule[],
): DraftedMatcher | null {
  const draftArg0 = arg0SetFromMatch(draft.match);
  if (draftArg0 === null || draftArg0.length === 0) {
    return null;
  }

  const draftProgram = programFromMatch(draft.match);
  const deniedArg0 = new Set<string>();

  for (const floorRule of floor) {
    if (floorRule.effect !== "deny") {
      continue;
    }

    const floorExpr = getMatcherExpr(floorRule.match);
    if (
      floorExpr === null ||
      classifyOverlap(draft.compiled, floorExpr) !== "overlap"
    ) {
      continue;
    }

    const deniedValues = deniedArg0ValuesForOverlap(
      draft,
      floorExpr,
      draftProgram,
    );
    if (deniedValues === null) {
      return null;
    }

    for (const value of deniedValues) {
      deniedArg0.add(value);
    }
  }

  if (deniedArg0.size === 0) {
    return null;
  }

  const narrowedArg0 = draftArg0.filter((value) => !deniedArg0.has(value));
  if (narrowedArg0.length === 0 || narrowedArg0.length === draftArg0.length) {
    return null;
  }

  const narrowedMatch = replaceArg0In(draft.match, narrowedArg0);
  if (narrowedMatch === null) {
    return null;
  }

  const compiled = compileMatch(narrowedMatch);
  if ("errors" in compiled) {
    return null;
  }

  return {
    ...draft,
    match: narrowedMatch,
    compiled: compiled.expr,
    notes: [
      ...draft.notes,
      `narrowed arg0In from [${draftArg0.join(", ")}] to [${narrowedArg0.join(", ")}] to avoid sealed-floor overlap`,
    ],
  };
}

function downgradeDraftToReview(
  draft: DraftedMatcher,
  check: FloorCheckResult,
): DraftedMatcher {
  const reason = check.hasUnknown
    ? "downgraded to review because floor overlap was undecidable"
    : "downgraded to review because overlap could not be narrowed to disjoint";
  const checked =
    check.checkedRuleIds.length === 0
      ? "no floor deny rules"
      : check.checkedRuleIds.join(", ");
  const unsafe =
    check.unsafeRuleIds.length === 0 ? "none" : check.unsafeRuleIds.join(", ");

  return {
    ...draft,
    effect: "review",
    notes: [
      ...draft.notes,
      `${reason}; checked=[${checked}], unsafe=[${unsafe}]`,
    ],
  };
}

function deniedArg0ValuesForOverlap(
  draft: DraftedMatcher,
  floorExpr: MatcherExpr,
  draftProgram: string | undefined,
): readonly string[] | null {
  if (floorExpr.kind === "stageSome") {
    return deniedArg0ValuesForOverlap(draft, floorExpr.inner, draftProgram);
  }

  if (floorExpr.kind === "any") {
    const values: string[] = [];
    for (const child of floorExpr.of) {
      const overlap = classifyOverlap(draft.compiled, child);
      if (overlap === "disjoint") {
        continue;
      }
      if (overlap === "unknown") {
        return null;
      }

      const childValues = deniedArg0ValuesForOverlap(
        draft,
        child,
        draftProgram,
      );
      if (childValues === null) {
        return null;
      }
      values.push(...childValues);
    }

    return values.length === 0 ? null : sortedUnique(values);
  }

  const facts = decidableFloorFacts(floorExpr);
  if (facts === null || facts.arg0Values.length === 0) {
    return null;
  }

  if (
    facts.programs.length > 0 &&
    draftProgram !== undefined &&
    !facts.programs.includes(draftProgram)
  ) {
    return [];
  }

  return facts.arg0Values;
}

function decidableFloorFacts(expr: MatcherExpr): DecidableFloorFacts | null {
  const facts = collectDecidableFacts(expr, {
    programs: [],
    arg0Values: [],
  });
  if (facts === null) {
    return null;
  }

  return {
    programs: sortedUnique(facts.programs),
    arg0Values: sortedUnique(facts.arg0Values),
  };
}

function collectDecidableFacts(
  expr: MatcherExpr,
  facts: { programs: string[]; arg0Values: string[] },
): { programs: string[]; arg0Values: string[] } | null {
  switch (expr.kind) {
    case "program":
      facts.programs.push(expr.name);
      return facts;
    case "arg0In":
      facts.arg0Values.push(...expr.values);
      return facts;
    case "all":
      return collectAllFacts(expr.of, facts);
    case "stageEvery":
    case "stageSome":
      return collectDecidableFacts(expr.inner, facts);
    case "tool":
    case "argAt":
    case "argMatches":
    case "argCount":
    case "envAssignmentCount":
    case "flagPresent":
    case "flagMatches":
    case "flagAllowlist":
    case "flagValueIn":
    case "flagCount":
    case "anyArgMatches":
    case "envAssignmentNameIn":
    case "noSubstitution":
    case "noStdoutRedirect":
    case "redirect":
    case "pipeline":
    case "operator":
    case "always":
    case "mutationTool":
    case "mutationShape":
    case "mutationTrustBoundary":
    case "pathScope":
    case "compoundForm":
    case "bodyStagesAllReadOnly":
    case "bodyStagesAllScopeIn":
    case "iteratorScopesAllIn":
    case "noBodySubstitution":
    case "noBodyShellWrap":
    case "noBodyRedirectTo":
    case "diagnosticCode":
      // `pathScope.programs` is a per-command-stage coverage guard, not the
      // matched program, so it contributes no program/arg0 floor facts. Mutation
      // and compound matchers constrain non-floor structural facts, not bash
      // floor program/arg0 facts.
      return facts;
    case "any":
    case "composition":
    case "not":
      return null;
  }
}

function collectAllFacts(
  exprs: readonly MatcherExpr[],
  facts: { programs: string[]; arg0Values: string[] },
): { programs: string[]; arg0Values: string[] } | null {
  for (const expr of exprs) {
    const next = collectDecidableFacts(expr, facts);
    if (next === null) {
      return null;
    }
  }

  return facts;
}

function programFromMatch(match: unknown): string | undefined {
  return findStringCombinator(match, "program");
}

function arg0SetFromMatch(match: unknown): readonly string[] | null {
  const found = findStringArrayCombinator(match, "arg0In");
  return found === null ? null : sortedUnique(found);
}

function replaceArg0In(
  match: unknown,
  values: readonly string[],
): unknown | null {
  if (!isRecord(match) || !Array.isArray(match.all)) {
    return null;
  }

  let replaced = false;
  const all = match.all.map((clause) => {
    if (isRecord(clause) && Array.isArray(clause.arg0In)) {
      replaced = true;
      return { arg0In: [...values] };
    }
    return cloneJsonish(clause);
  });

  return replaced ? { all } : null;
}

function findStringCombinator(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value[key] === "string") {
    return value[key];
  }

  if (Array.isArray(value.all)) {
    for (const child of value.all) {
      const found = findStringCombinator(child, key);
      if (found !== undefined) {
        return found;
      }
    }
  }

  return undefined;
}

function findStringArrayCombinator(
  value: unknown,
  key: string,
): readonly string[] | null {
  if (!isRecord(value)) {
    return null;
  }

  if (Array.isArray(value[key])) {
    const values = value[key].filter(
      (item): item is string => typeof item === "string",
    );
    return values.length === value[key].length ? values : null;
  }

  if (Array.isArray(value.all)) {
    for (const child of value.all) {
      const found = findStringArrayCombinator(child, key);
      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

function cloneJsonish(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonish);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonish(entry)]),
    );
  }

  return value;
}

function normalizeFlagName(name: string): string {
  return name.replace(/^-+/, "");
}

async function parsedRow(
  row: PerCommandRow,
  parser: ReplayBashParser,
  parseCache: Map<string, Promise<ParsedCommandFacts>>,
): Promise<ParsedFrictionRow | null> {
  const facts = await cachedParse(row.command, parser, parseCache);
  const executable = nonEmpty(row.executable) ?? facts.signature.program;
  if (executable === undefined) {
    return null;
  }

  return {
    row,
    executable,
    signature: facts.signature,
    notes: facts.notes,
  };
}

function cachedParse(
  command: string,
  parser: ReplayBashParser,
  parseCache: Map<string, Promise<ParsedCommandFacts>>,
): Promise<ParsedCommandFacts> {
  const existing = parseCache.get(command);
  if (existing !== undefined) {
    return existing;
  }

  const parsed = parseCommandFacts(command, parser);
  parseCache.set(command, parsed);
  return parsed;
}

async function parseCommandFacts(
  command: string,
  parser: ReplayBashParser,
): Promise<ParsedCommandFacts> {
  try {
    const shape = await parser(command);
    return factsFromShape(shape);
  } catch (error: unknown) {
    const message = errorMessage(error);
    return {
      signature: {
        program: undefined,
        arg0Set: [],
        flags: [],
        hasSubstitution: false,
        hasStdoutRedirect: false,
        parseDiagnostics: [message],
      },
      notes: [`parser failed for ${JSON.stringify(command)}: ${message}`],
    };
  }
}

function factsFromShape(shape: ToolShape): ParsedCommandFacts {
  if (shape.kind !== "bash") {
    return {
      signature: {
        program: undefined,
        arg0Set: [],
        flags: [],
        hasSubstitution: false,
        hasStdoutRedirect: false,
        parseDiagnostics: [`parser returned non-bash shape: ${shape.kind}`],
      },
      notes: [`parser returned non-bash shape: ${shape.kind}`],
    };
  }

  const firstStage = firstResolvableCommandStage(shape);
  const parseDiagnostics = shape.diagnostics
    .filter((diagnostic) => diagnostic.severity !== "info")
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
  const program = primaryExecutableFromShape(shape);
  const arg0 = nonEmpty(firstStage?.program.arguments[0]);

  return {
    signature: {
      program,
      arg0Set: arg0 === undefined ? [] : [arg0],
      flags: sortedUnique(
        (firstStage?.program.flags ?? []).map((flag) => flag.raw),
      ),
      hasSubstitution: flattenStages(shape.blocks).some(hasSubstitution),
      hasStdoutRedirect: flattenStages(shape.blocks).some(hasStdoutRedirect),
      parseDiagnostics,
    },
    notes: parseDiagnostics.map(
      (diagnostic) => `parse diagnostic: ${diagnostic}`,
    ),
  };
}

function firstResolvableCommandStage(
  shape: ToolShape,
): Extract<BashStage, { readonly kind: "command" }> | undefined {
  if (shape.kind !== "bash") {
    return undefined;
  }

  return flattenStages(shape.blocks).find(
    (stage): stage is Extract<BashStage, { readonly kind: "command" }> =>
      stage.kind === "command" &&
      stage.program.resolvable &&
      stage.program.program.length > 0,
  );
}

function finalizeCluster(cluster: MutableCluster): FrictionCluster {
  const rows = [...cluster.rows];
  const behaviors = sortedUnique(rows.flatMap((row) => row.behaviors ?? []));
  const sampleCommands = cappedUnique(
    rows.map((row) => row.command),
    DEFAULT_SAMPLE_COMMAND_LIMIT,
  );
  const evidence = buildEvidence(
    cluster.executable,
    rows,
    behaviors,
    sampleCommands,
  );
  const signature = mergeSignatures(cluster.signatures);
  const notes = sortedUnique(cluster.notes);
  const frictionScore =
    evidence.reviewCalls +
    evidence.hardBlockCalls +
    evidence.capturedDenialCalls +
    evidence.modelReviewCalls;

  return {
    executable: cluster.executable,
    rows,
    signature,
    addressableBy: classifyAddressableBy({ rows, behaviors, signature }),
    frictionScore,
    behaviors,
    sampleCommands,
    evidence,
    notes,
  };
}

function buildEvidence(
  executable: string,
  rows: readonly PerCommandRow[],
  behaviors: readonly string[],
  sampleCommands: readonly string[],
): ProposalEvidence {
  const capturedOutcomeBreakdown = new Map<CapturedOutcomeLabel, number>();

  let calls = 0;
  let reviewCalls = 0;
  let hardBlockCalls = 0;
  let modelReviewCalls = 0;
  let capturedDenialCalls = 0;

  for (const row of rows) {
    calls += safeCount(row.count);
    reviewCalls += row.status === "review" ? safeCount(row.count) : 0;
    hardBlockCalls += row.status === "hard_block" ? safeCount(row.count) : 0;
    modelReviewCalls += countLabels(row.capturedOutcomes, MODEL_OUTCOME_LABELS);
    capturedDenialCalls += countLabels(
      row.capturedOutcomes,
      DENIAL_OUTCOME_LABELS,
    );

    for (const [label, count] of row.capturedOutcomes) {
      capturedOutcomeBreakdown.set(
        label,
        (capturedOutcomeBreakdown.get(label) ?? 0) + safeCount(count),
      );
    }
  }

  return {
    executable,
    calls,
    unique: rows.length,
    reviewCalls,
    hardBlockCalls,
    modelReviewCalls,
    capturedDenialCalls,
    behaviors,
    sampleCommands,
    capturedOutcomeBreakdown: sortCapturedOutcomeMap(capturedOutcomeBreakdown),
  };
}

function mergeSignatures(
  signatures: readonly CommandSignature[],
): CommandSignature {
  const programs = sortedUnique(
    signatures.flatMap((signature) =>
      signature.program === undefined ? [] : [signature.program],
    ),
  );

  return {
    program: programs[0],
    arg0Set: sortedUnique(signatures.flatMap((signature) => signature.arg0Set)),
    flags: sortedUnique(signatures.flatMap((signature) => signature.flags)),
    hasSubstitution: signatures.some((signature) => signature.hasSubstitution),
    hasStdoutRedirect: signatures.some(
      (signature) => signature.hasStdoutRedirect,
    ),
    parseDiagnostics: sortedUnique(
      signatures.flatMap((signature) => signature.parseDiagnostics),
    ),
  };
}

function classifyAddressableBy(input: {
  readonly rows: readonly PerCommandRow[];
  readonly behaviors: readonly string[];
  readonly signature: CommandSignature;
}): ClusterAddressableBy {
  if (input.signature.parseDiagnostics.length > 0) {
    return "none";
  }

  if (input.behaviors.some((behavior) => RISKY_ALLOW_BEHAVIORS.has(behavior))) {
    return "none";
  }

  if (hasCoreMatcherGapSignal(input.rows, input.behaviors)) {
    return "core-matcher";
  }

  if (hasGitOptionValueSubcommandGap(input.signature)) {
    return "core-matcher";
  }

  return "data";
}

const GIT_FLAGS_WITH_SEPARATE_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

function hasGitOptionValueSubcommandGap(signature: CommandSignature): boolean {
  if (signature.program !== "git") {
    return false;
  }

  if (
    !signature.flags.some((flag) => GIT_FLAGS_WITH_SEPARATE_VALUE.has(flag))
  ) {
    return false;
  }

  return signature.arg0Set.some(looksLikePathArgument);
}

function looksLikePathArgument(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/")
  );
}

function hasCoreMatcherGapSignal(
  rows: readonly PerCommandRow[],
  behaviors: readonly string[],
): boolean {
  if (
    behaviors.some(
      (behavior) =>
        behavior === "path-shape" ||
        behavior === "project-path" ||
        behavior === "path-constraint",
    )
  ) {
    return true;
  }

  return rows.some((row) => {
    const reason = row.reason.toLowerCase();
    return (
      reason.includes("path shape") ||
      reason.includes("project path") ||
      reason.includes("inside the project root") ||
      reason.includes("inside project root")
    );
  });
}

function validFrictionRows(report: RatchetReport): readonly PerCommandRow[] {
  if (!isRecord(report) || !Array.isArray(report.perCommand)) {
    return [];
  }

  return report.perCommand.filter(
    (row): row is PerCommandRow =>
      isRecord(row) &&
      typeof row.command === "string" &&
      typeof row.toolName === "string" &&
      (row.status === "review" || row.status === "hard_block") &&
      row.capturedOutcomes instanceof Map,
  );
}

function compareClusters(
  left: FrictionCluster,
  right: FrictionCluster,
): number {
  return (
    right.frictionScore - left.frictionScore ||
    right.evidence.calls - left.evidence.calls ||
    right.evidence.unique - left.evidence.unique ||
    left.executable.localeCompare(right.executable) ||
    left.signature.arg0Set
      .join("\u0000")
      .localeCompare(right.signature.arg0Set.join("\u0000"))
  );
}

function clusterKey(executable: string, arg0Set: readonly string[]): string {
  return `${executable}\u0000${sortedUnique(arg0Set).join("\u0000")}`;
}

function countLabels(
  outcomes: ReadonlyMap<CapturedOutcomeLabel, number>,
  labels: ReadonlySet<CapturedOutcomeLabel>,
): number {
  let count = 0;
  for (const [label, calls] of outcomes) {
    if (labels.has(label)) {
      count += safeCount(calls);
    }
  }
  return count;
}

function sortCapturedOutcomeMap(
  input: ReadonlyMap<CapturedOutcomeLabel, number>,
): ReadonlyMap<CapturedOutcomeLabel, number> {
  const sorted = new Map<CapturedOutcomeLabel, number>();
  for (const label of CAPTURED_OUTCOME_LABELS) {
    const count = input.get(label);
    if (count !== undefined && count > 0) {
      sorted.set(label, count);
    }
  }
  return sorted;
}

function cappedUnique(
  values: readonly string[],
  limit: number,
): readonly string[] {
  const seen = new Set<string>();
  const capped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    capped.push(value);
    if (capped.length >= limit) {
      break;
    }
  }
  return capped;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
