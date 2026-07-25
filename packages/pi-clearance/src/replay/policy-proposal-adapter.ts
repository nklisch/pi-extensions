/**
 * Data-pack policy proposal adapter — converts legacy {@link RuleProposal}
 * outputs of `kind: "data"` into the structured {@link StructuredRatchetProposal}
 * contract (kind `data-pack-policy`) defined in `./proposal-schema.ts`.
 *
 * Scope (see story `epic-structured-ratchet-engine-proposal-schema-policy-pack-adapter`):
 *
 * - Handles `kind: "data"` proposals only: `user-global`, `user-project`, and
 *   `shipped-pack` targets. `shipped-pack` is represented as design input — the
 *   ratchet cannot write shipped source.
 * - `kind: "core-matcher"` design inputs are NOT
 *   converted here; they belong to the authoring-proposal adapter (separate
 *   story). {@link policyRuleProposalToStructuredProposal} throws for those kinds.
 * - Legacy {@link proposeRules} behavior and its `RuleProposal` output are
 *   untouched; structured output is purely additive.
 *
 * Data contract (see parent feature `epic-structured-ratchet-engine-proposal-schema`):
 *
 * - Carries RAW matcher JSON, raw pack/rule JSON-patch descriptions, and
 *   corpus-referenced evidence only. Never carries `compiledMatch`
 *   (`MatcherExpr`), `CompiledMatcher`, `PolicyRule`, `ReadonlyMap`, or
 *   functions — the schema rejects those and `JSON.stringify` round-trips
 *   cleanly without a custom replacer.
 * - `applicationMode` distinguishes `writable-after-approval` (floor-safe allow,
 *   review, deny on user-owned config) from `design-input-only` (shipped-pack
 *   and any allow the existing generator could not prove floor-safe). Neither
 *   path applies changes during generation.
 * - Validation status is STAGED and reflects checks the legacy generator
 *   actually runs (schema, matcher compile, floor overlap, adversarial
 *   near-miss). Downstream replay-delta / adversarial / config-schema checks
 *   are `pending`/`skipped`, never `pass`.
 */
import { resolveConfigPaths } from "../config/paths.ts";
import type { DecisionSource } from "../policy/core.ts";
import {
  CAPTURED_OUTCOME_LABELS,
  type CapturedOutcomeLabel,
  REPLAY_STATUSES,
  type ReplayStatus,
  sortCountsByOrder,
} from "./corpus-model.ts";
import type {
  FileWriteDescription,
  JsonPatchOperation,
  PolicyPackProposalChange,
  ProposalEvidence,
  ProposalExample,
  ProposalFixtureSuggestion,
  ProposalProvenanceSource,
  ProposalTarget,
  ProposalTrustNote,
  ProposalValidation,
  ProposalValidationCheck,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";
import {
  assertStructuredProposal,
  PROPOSAL_PROVENANCE_SOURCES,
  PROPOSAL_SCHEMA_VERSION,
} from "./proposal-schema.ts";
import type {
  ProposeRulesInput,
  ProposeRulesOptions,
  RuleProposal,
} from "./proposals.ts";
import { proposeRules } from "./proposals.ts";

// ---------------------------------------------------------------------------
// Options + errors
// ---------------------------------------------------------------------------

/**
 * Adapter options. `createdAt` is required because the structured schema
 * stamps every proposal with a non-empty creation time (the legacy
 * `RuleProposal` carries none). Path fields are optional and default to the
 * real config locations resolved from `projectRoot` (or `process.cwd()`).
 */
export interface PolicyProposalAdapterOptions {
  readonly createdAt: string;
  readonly globalConfigPath?: string;
  readonly projectOverlayPath?: string;
  readonly projectKey?: string;
  readonly projectRoot?: string;
}

/**
 * Thrown when {@link policyRuleProposalToStructuredProposal} receives a
 * `RuleProposal` it does not convert — i.e. `kind` other than `"data"`.
 * `proposeStructuredPolicyChanges` filters those out before conversion, so this
 * only fires for direct misuse of the single-proposal converter.
 */
export class PolicyProposalAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyProposalAdapterError";
  }
}

interface ResolvedAdapterPaths {
  readonly globalConfigPath: string;
  readonly projectOverlayPath: string;
  readonly projectKey: string;
  readonly projectRoot: string;
}

// ---------------------------------------------------------------------------
// Single-proposal conversion
// ---------------------------------------------------------------------------

/**
 * Convert a legacy data-pack {@link RuleProposal} into a structured
 * {@link StructuredRatchetProposal} of kind `data-pack-policy`.
 *
 * Throws {@link PolicyProposalAdapterError} for `kind` other than `"data"` —
 * core-matcher design inputs are produced by the
 * authoring-proposal adapter. The result is validated through
 * {@link assertStructuredProposal} so an adapter bug fails fast rather than
 * emitting a malformed proposal downstream.
 */
export function policyRuleProposalToStructuredProposal(
  proposal: RuleProposal,
  options: PolicyProposalAdapterOptions,
): StructuredRatchetProposal {
  if (proposal.kind !== "data") {
    throw new PolicyProposalAdapterError(
      `policy-proposal-adapter converts kind "data" only; received kind "${proposal.kind}" (target "${proposal.target}"). ` +
        "core-matcher design inputs are produced by the authoring-proposal adapter.",
    );
  }

  const paths = resolveAdapterPaths(options);
  const target = structuredTarget(proposal, paths);
  const change = rawPackChangeFromRuleProposal(proposal);
  const writable = isWritableDataProposal(proposal);
  const changeWithFileWrite = attachFileWrite(change, target, writable);
  const intendedProvenance = structuredIntendedProvenance(proposal);

  const structured: StructuredRatchetProposal = {
    version: PROPOSAL_SCHEMA_VERSION,
    id: proposal.id,
    kind: "data-pack-policy",
    title: proposalTitle(proposal),
    summary: proposalSummary(proposal, target),
    reason: proposal.reason,
    createdAt: options.createdAt,
    provenance: { source: "generated" },
    ...(intendedProvenance === undefined ? {} : { intendedProvenance }),
    applicationMode: writable ? "writable-after-approval" : "design-input-only",
    target,
    change: changeWithFileWrite,
    evidence: structuredEvidence(proposal),
    examples: structuredExamples(proposal),
    fixtureSuggestions: structuredFixtureSuggestions(proposal),
    validation: structuredValidation(proposal),
    trustNotes: trustNotesFromProposal(proposal),
    warnings: warningsFor(proposal),
  };

  return assertStructuredProposal(structured);
}

/**
 * Build the `PolicyPackProposalChange` for a data-pack proposal: raw matcher
 * JSON, the suggested rule's pack id, and a raw JSON-patch that adds a
 * user-owned pack containing the rule to the target config's `packs` array.
 *
 * `fileWrite` is intentionally NOT attached here — it depends on the resolved
 * target path, which the adapter supplies. The patch is empty for non-writable
 * proposals (shipped-pack, unsafe allow): the change names the suggested rule
 * but never claims the ratchet will write it.
 */
export function rawPackChangeFromRuleProposal(
  proposal: RuleProposal,
): PolicyPackProposalChange {
  if (proposal.kind !== "data") {
    throw new PolicyProposalAdapterError(
      `rawPackChangeFromRuleProposal converts kind "data" only; received kind "${proposal.kind}".`,
    );
  }

  const packId = derivedPackId(proposal);
  const writable = isWritableDataProposal(proposal);
  const rawPackPatch: readonly JsonPatchOperation[] = writable
    ? [
        {
          op: "add",
          path: "/packs/-",
          value: {
            version: 1,
            id: packId,
            rules: [rawRuleFromProposal(proposal)],
          },
        },
      ]
    : [];

  return {
    kind: "policy-pack",
    packId,
    ruleId: proposal.ruleId,
    effect: proposal.effect,
    reason: proposal.reason,
    // Raw matcher JSON only — never compiledMatch / MatcherExpr.
    match: proposal.match,
    rawPackPatch,
  };
}

// ---------------------------------------------------------------------------
// Batch conversion
// ---------------------------------------------------------------------------

/**
 * Run the legacy {@link proposeRules} generator and convert each `kind: "data"`
 * result into a structured `data-pack-policy` proposal. `core-matcher` design
 * inputs are NOT included — they are produced by the
 * authoring-proposal adapter (separate story) — so the returned array may be
 * shorter than `proposeRules`'s legacy output.
 *
 * `createdAt` defaults to `new Date().toISOString()` when omitted; pass an
 * explicit value for deterministic output.
 */
export async function proposeStructuredPolicyChanges(
  input: ProposeRulesInput,
  options?: ProposeRulesOptions & Partial<PolicyProposalAdapterOptions>,
): Promise<readonly StructuredRatchetProposal[]> {
  const createdAt = options?.createdAt ?? new Date().toISOString();
  const legacyOptions: ProposeRulesOptions = {
    ...(options?.bashParser === undefined
      ? {}
      : { bashParser: options.bashParser }),
    ...(options?.modelDrafter === undefined
      ? {}
      : { modelDrafter: options.modelDrafter }),
    ...(options?.maxProposals === undefined
      ? {}
      : { maxProposals: options.maxProposals }),
    ...(options?.maxClusters === undefined
      ? {}
      : { maxClusters: options.maxClusters }),
    ...(options?.clock === undefined ? {} : { clock: options.clock }),
  };
  const proposals = await proposeRules(input, legacyOptions);

  const adapterOptions: PolicyProposalAdapterOptions = {
    createdAt,
    ...(options?.globalConfigPath === undefined
      ? {}
      : { globalConfigPath: options.globalConfigPath }),
    ...(options?.projectOverlayPath === undefined
      ? {}
      : { projectOverlayPath: options.projectOverlayPath }),
    ...(options?.projectKey === undefined
      ? {}
      : { projectKey: options.projectKey }),
    ...(options?.projectRoot === undefined
      ? {}
      : { projectRoot: options.projectRoot }),
  };

  const structured: StructuredRatchetProposal[] = [];
  for (const proposal of proposals) {
    // Filter to the data-pack-policy domain; authoring design inputs route to
    // the authoring-proposal adapter and are intentionally omitted here.
    if (proposal.kind !== "data") {
      continue;
    }
    structured.push(
      policyRuleProposalToStructuredProposal(proposal, adapterOptions),
    );
  }
  return structured;
}

// ---------------------------------------------------------------------------
// Target + writability mapping
// ---------------------------------------------------------------------------

function structuredTarget(
  proposal: RuleProposal,
  paths: ResolvedAdapterPaths,
): ProposalTarget {
  switch (proposal.target) {
    case "user-global":
      return { kind: "user-global-config", path: paths.globalConfigPath };
    case "user-project":
      return {
        kind: "user-project-overlay",
        path: paths.projectOverlayPath,
        projectKey: paths.projectKey,
        projectRoot: paths.projectRoot,
      };
    case "shipped-pack":
      // Design input: name the route but do not claim a writable shipped source
      // path. `suggestedPath` is omitted — the legacy proposal does not carry
      // the shipped pack's source file path.
      return { kind: "design-input", route: "shipped-pack" };
    default:
      // core-matcher is not the data-pack-policy domain.
      throw new PolicyProposalAdapterError(
        `cannot map target "${proposal.target}" for kind "${proposal.kind}" in the data-pack-policy adapter`,
      );
  }
}

/**
 * A data-pack proposal is directly writable after approval when it lands on a
 * user-owned config AND its effect is a safe config change:
 * - `review` / `deny` rules are always safe writes (they tighten posture).
 * - `allow` rules require a provably floor-disjoint matcher (action `emit` or
 *   `narrowed`). An allow the generator could not prove safe would already be
 *   downgraded to `review`; defensively, any remaining non-floor-safe allow is
 *   marked non-writable here.
 *
 * `shipped-pack` is never writable — the ratchet cannot write shipped source.
 */
function isWritableDataProposal(proposal: RuleProposal): boolean {
  if (proposal.kind !== "data") {
    return false;
  }
  if (proposal.target === "shipped-pack") {
    return false;
  }
  if (proposal.effect === "allow") {
    return (
      proposal.floorOverlap.action === "emit" ||
      proposal.floorOverlap.action === "narrowed"
    );
  }
  return true; // review / deny: safe config writes
}

// ---------------------------------------------------------------------------
// Change / file-write construction
// ---------------------------------------------------------------------------

function attachFileWrite(
  change: PolicyPackProposalChange,
  target: ProposalTarget,
  writable: boolean,
): PolicyPackProposalChange {
  if (!writable) {
    return change;
  }
  // Only user-owned config targets carry a file-write description. (Shipped-pack
  // is design-input-only and never reaches here because writable is false.)
  if (
    target.kind !== "user-global-config" &&
    target.kind !== "user-project-overlay"
  ) {
    return change;
  }
  const fileWrite: FileWriteDescription = {
    path: target.path,
    format: "json",
    mode: "patch",
    atomic: true,
    backupRequired: true,
    patch: change.rawPackPatch,
  };
  return { ...change, fileWrite };
}

function rawRuleFromProposal(proposal: RuleProposal): unknown {
  return {
    id: proposal.ruleId,
    effect: proposal.effect,
    match: proposal.match,
    reason: proposal.reason,
    provenance: { source: proposal.intendedProvenance },
  };
}

/**
 * Pack id for the change. Shipped-pack proposals carry the shipped pack id on
 * the legacy proposal; user-global/user-project proposals do not, so derive a
 * stable user-owned pack id grouped by scope + executable.
 */
function derivedPackId(proposal: RuleProposal): string {
  if (proposal.packId !== undefined && proposal.packId.length > 0) {
    return proposal.packId;
  }
  const scope = proposal.scope === "global" ? "global" : "project";
  const segment = sanitizePackIdSegment(proposal.evidence.executable);
  return `user-${scope}-${segment}`;
}

function sanitizePackIdSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "rule";
}

// ---------------------------------------------------------------------------
// Evidence / examples / fixtures
// ---------------------------------------------------------------------------

function structuredEvidence(proposal: RuleProposal): ProposalEvidence {
  const evidence = proposal.evidence;

  // Convert the legacy ReadonlyMap<CapturedOutcomeLabel, number> to sorted
  // CountByLabel arrays — canonical order, zero-call entries dropped.
  const capturedOutcomeCounts = sortCountsByOrder<CapturedOutcomeLabel>(
    [...evidence.capturedOutcomeBreakdown.entries()].map(([label, calls]) => ({
      label,
      calls,
    })),
    CAPTURED_OUTCOME_LABELS,
  );

  // The legacy evidence tracks replay status as scalars (reviewCalls,
  // hardBlockCalls). Friction clusters contain only review/hard_block rows, so
  // fast_path is zero and omitted by sortCountsByOrder.
  const replayStatusCounts = sortCountsByOrder<ReplayStatus>(
    [
      { label: "review", calls: evidence.reviewCalls },
      { label: "hard_block", calls: evidence.hardBlockCalls },
    ],
    REPLAY_STATUSES,
  );

  return {
    // The legacy RuleProposal does not carry corpus family/record ids (it
    // groups by command, not per-occurrence record) nor fidelity/redaction
    // totals, so corpusSummary / familyIds / recordIds are left empty pending
    // corpus-query-model integration. See the trust note on each proposal.
    familyIds: [],
    recordIds: [],
    calls: evidence.calls,
    uniqueCommands: evidence.unique,
    reviewCalls: evidence.reviewCalls,
    hardBlockCalls: evidence.hardBlockCalls,
    modelReviewCalls: evidence.modelReviewCalls,
    capturedDenialCalls: evidence.capturedDenialCalls,
    replayStatusCounts,
    capturedOutcomeCounts,
    sampleCommands: [...evidence.sampleCommands],
  };
}

function structuredExamples(
  proposal: RuleProposal,
): readonly ProposalExample[] {
  // Legacy ProposalExample is structurally identical to the schema's
  // ProposalExample (command / matches / capturedOutcome? / note?). Pass
  // through directly — the optional fields are already absent-when-undefined.
  return proposal.examples;
}

function structuredFixtureSuggestions(
  proposal: RuleProposal,
): readonly ProposalFixtureSuggestion[] {
  // Legacy CorpusFixtureRow is structurally identical to the schema's
  // ProposalFixtureSuggestion (command / expected / reason / provenance).
  return proposal.fixtureSuggestions;
}

// ---------------------------------------------------------------------------
// Validation status (staged; reflects checks the generator actually runs)
// ---------------------------------------------------------------------------

function structuredValidation(proposal: RuleProposal): ProposalValidation {
  const configSchema = configSchemaCheck(proposal);
  const adversarial = adversarialCheck(proposal);
  const trust = trustCheck(proposal);

  return {
    schema: {
      status: "pass",
      code: "proposal-schema-ok",
      message: "structured proposal conforms to proposal-schema",
    },
    matcherCompile: matcherCompileCheck(proposal),
    floorOverlap: floorOverlapCheck(proposal),
    replay: {
      status: "pending",
      code: "replay-pending",
      message: "replay-delta validation runs in a downstream feature",
    },
    ...(configSchema === undefined ? {} : { configSchema }),
    ...(adversarial === undefined ? {} : { adversarial }),
    ...(trust === undefined ? {} : { trust }),
  };
}

function matcherCompileCheck(proposal: RuleProposal): ProposalValidationCheck {
  if (proposal.compiledMatch === undefined) {
    return {
      status: "skipped",
      code: "matcher-compile-na",
      message: "legacy proposal carries no compiled matcher",
    };
  }
  return {
    status: "pass",
    code: "matcher-compiled",
    message: "legacy generator compiled the matcher through compileMatch",
  };
}

function floorOverlapCheck(proposal: RuleProposal): ProposalValidationCheck {
  const note = proposal.floorOverlap.note;
  switch (proposal.floorOverlap.action) {
    case "emit":
      return {
        status: "pass",
        code: "floor-disjoint-emit",
        message: note,
        details: {
          checkedFloorRuleIds: proposal.floorOverlap.checkedFloorRuleIds,
          overlappingFloorRuleIds:
            proposal.floorOverlap.overlappingFloorRuleIds,
        },
      };
    case "narrowed":
      return {
        status: "pass",
        code: "floor-disjoint-narrowed",
        message: note,
        details: {
          checkedFloorRuleIds: proposal.floorOverlap.checkedFloorRuleIds,
          overlappingFloorRuleIds:
            proposal.floorOverlap.overlappingFloorRuleIds,
        },
      };
    case "downgraded-to-review":
      return {
        status: "fail",
        code: "floor-overlap-downgraded",
        message: note,
        details: {
          checkedFloorRuleIds: proposal.floorOverlap.checkedFloorRuleIds,
          overlappingFloorRuleIds:
            proposal.floorOverlap.overlappingFloorRuleIds,
        },
      };
    case "skipped-non-allow":
      return {
        status: "skipped",
        code: "floor-skipped-non-allow",
        message: note,
      };
  }
}

function configSchemaCheck(
  proposal: RuleProposal,
): ProposalValidationCheck | undefined {
  // Config-schema validation requires the full target config and runs at the
  // approval-gated writer; mark writable proposals pending and omit for
  // design-input-only proposals.
  if (!isWritableDataProposal(proposal)) {
    return undefined;
  }
  return {
    status: "pending",
    code: "config-schema-pending",
    message: "config-schema validation runs at the approval-gated writer",
  };
}

function adversarialCheck(
  proposal: RuleProposal,
): ProposalValidationCheck | undefined {
  const negatives = proposal.examples.filter((example) => !example.matches);
  if (negatives.length === 0) {
    return {
      status: "skipped",
      code: "adversarial-no-near-miss",
      message: "no adversarial near-miss examples on the legacy proposal",
    };
  }
  return {
    status: "pass",
    code: "adversarial-near-miss-verified",
    message:
      "legacy generator verified adversarial near-miss examples do not match the proposed matcher; full adversarial validation is downstream",
  };
}

function trustCheck(
  proposal: RuleProposal,
): ProposalValidationCheck | undefined {
  if (proposal.approvalFraming.writesExecutableCode) {
    return {
      status: "pending",
      code: "trust-pending-executable",
      message: "proposal writes executable code; requires explicit trust",
    };
  }
  return {
    status: "pass",
    code: "trust-structural",
    message: "structural matcher; no executable code or DSL change",
  };
}

// ---------------------------------------------------------------------------
// Trust notes / warnings / titles
// ---------------------------------------------------------------------------

function trustNotesFromProposal(
  proposal: RuleProposal,
): readonly ProposalTrustNote[] {
  const notes: ProposalTrustNote[] = [];
  const framing = proposal.approvalFraming;

  if (framing.writesExecutableCode) {
    notes.push({
      kind: "executable-code",
      message: framing.summary,
      severity: "warning",
    });
  }
  if (framing.touchesDsl) {
    notes.push({
      kind: "dsl-change",
      message: framing.summary,
      severity: "warning",
    });
  }
  if (framing.routesAsDesignInput) {
    notes.push({
      kind: "design-input",
      message: framing.summary,
      severity: "info",
    });
  }
  if (framing.requiresAcknowledgment) {
    notes.push({
      kind: "acknowledgment-required",
      message: framing.summary,
      severity: "warning",
    });
  }
  if (proposal.modelDrafted) {
    notes.push({
      kind: "model-origin",
      message:
        "rule drafted by a model adapter; structural verification passed before adoption",
      severity: "info",
    });
  }
  if (!isWritableDataProposal(proposal) && proposal.effect === "allow") {
    notes.push({
      kind: "non-writable-allow",
      message:
        "allow draft is not floor-safe; structured adapter marks it non-writable",
      severity: "warning",
    });
  }
  notes.push({
    kind: "structural-matcher",
    message:
      "matcher is raw JSON DSL; no compiled predicate or executable code carried",
    severity: "info",
  });
  notes.push({
    kind: "corpus-link-pending",
    message:
      "family/record ids unavailable from legacy RuleProposal; pending corpus-query-model integration",
    severity: "info",
  });
  return notes;
}

function warningsFor(proposal: RuleProposal): readonly string[] {
  const extra: string[] = [];
  if (proposal.target === "shipped-pack") {
    extra.push(
      "shipped-pack recommendation is design input; the ratchet cannot write shipped source",
    );
  }
  if (!isWritableDataProposal(proposal) && proposal.effect === "allow") {
    extra.push(
      "allow proposal is not floor-safe; marked non-writable (design-input-only)",
    );
  }
  return sortedUniqueStrings([...proposal.warnings, ...extra]);
}

function proposalTitle(proposal: RuleProposal): string {
  return `${capitalize(proposal.effect)} rule: ${proposal.ruleId}`;
}

function proposalSummary(
  proposal: RuleProposal,
  target: ProposalTarget,
): string {
  const targetLabel = targetLabelFor(target);
  return `${capitalize(proposal.effect)} ${proposal.evidence.executable} friction routed to ${targetLabel} (${proposal.evidence.calls} calls, ${proposal.evidence.reviewCalls} review).`;
}

function targetLabelFor(target: ProposalTarget): string {
  switch (target.kind) {
    case "user-global-config":
      return "user-global config";
    case "user-project-overlay":
      return "project overlay";
    case "package-pack-config":
      return "package-pack config";
    case "design-input":
      return `design input (${target.route})`;
  }
}

// ---------------------------------------------------------------------------
// Provenance narrowing + path resolution
// ---------------------------------------------------------------------------

function structuredIntendedProvenance(
  proposal: RuleProposal,
): ProposalProvenanceSource | undefined {
  // Narrow DecisionSource (which adds "package") to the schema's subset. Data
  // proposals only ever declare shipped / user-global / user-project, so this
  // preserves the value; an unexpected value is dropped rather than failing
  // schema validation.
  return isProposalProvenanceSource(proposal.intendedProvenance)
    ? proposal.intendedProvenance
    : undefined;
}

function isProposalProvenanceSource(
  value: DecisionSource,
): value is ProposalProvenanceSource {
  return (PROPOSAL_PROVENANCE_SOURCES as readonly string[]).includes(value);
}

function resolveAdapterPaths(
  options: PolicyProposalAdapterOptions,
): ResolvedAdapterPaths {
  const projectRoot = options.projectRoot ?? process.cwd();
  const paths = resolveConfigPaths(projectRoot);
  return {
    globalConfigPath: options.globalConfigPath ?? paths.globalConfigFile,
    projectOverlayPath: options.projectOverlayPath ?? paths.projectOverlayFile,
    projectKey: options.projectKey ?? paths.projectKey,
    projectRoot,
  };
}

// ---------------------------------------------------------------------------
// Small local utilities (no exported helpers duplicated from proposals.ts)
// ---------------------------------------------------------------------------

function capitalize(value: string): string {
  const head = value[0];
  return head === undefined ? value : head.toUpperCase() + value.slice(1);
}

function sortedUniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}
