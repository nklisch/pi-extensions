import { resolveConfigPaths } from "../config/paths.ts";
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
  PackFileAuthoringProposalChange,
  ProposalFixtureSuggestion,
  ProposalTarget,
  ProposalTrustNote,
  ProposalValidation,
  ProposalValidationCheck,
  ProposalEvidence as StructuredProposalEvidence,
  ProposalExample as StructuredProposalExample,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";
import {
  assertStructuredProposal,
  PROPOSAL_SCHEMA_VERSION,
} from "./proposal-schema.ts";
import type {
  CoreMatcherDesignInput,
  ProposalEvidence,
  ProposalExample,
  ProposeRulesInput,
  ProposeRulesOptions,
  RuleProposal,
} from "./proposals.ts";
import { proposeRules } from "./proposals.ts";

export type AuthoringDesignInputProposal = RuleProposal &
  (
    | {
        readonly kind: "core-matcher";
        readonly target: "core-matcher";
        readonly coreMatcher: CoreMatcherDesignInput;
      }
    | {
        readonly kind: "data";
        readonly target: "shipped-pack";
        readonly packId: string;
        readonly match: unknown;
      }
  );

export interface AuthoringProposalAdapterOptions {
  readonly createdAt: string;
  readonly globalConfigPath?: string;
  readonly projectRoot?: string;
  readonly coreMatcherPath?: string;
  readonly shippedPackPath?: string;
}

export interface PackFileWriteDescriptionInput {
  readonly path: string;
  readonly format: FileWriteDescription["format"];
  readonly mode?: FileWriteDescription["mode"];
  readonly contents?: string;
  readonly patch?: readonly JsonPatchOperation[];
  readonly atomic?: boolean;
  readonly backupRequired?: boolean;
}

export class AuthoringProposalAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoringProposalAdapterError";
  }
}

interface ResolvedAuthoringPaths {
  readonly projectRoot: string;
  readonly globalConfigPath: string;
  readonly coreMatcherPath?: string;
  readonly shippedPackPath?: string;
}

export function authoringDesignInputToStructuredProposal(
  input: AuthoringDesignInputProposal,
  options: AuthoringProposalAdapterOptions,
): StructuredRatchetProposal {
  const paths = resolveAuthoringPaths(options);
  const target = authoringTarget(input, paths);
  const change = authoringChange(input, paths);
  const intendedProvenance = authoringIntendedProvenance();
  const structured: StructuredRatchetProposal = {
    version: PROPOSAL_SCHEMA_VERSION,
    id: input.id,
    kind: "pack-file-authoring",
    title: authoringTitle(input),
    summary: authoringSummary(input),
    reason: input.reason,
    createdAt: options.createdAt,
    provenance: { source: "generated" },
    ...(intendedProvenance === undefined ? {} : { intendedProvenance }),
    applicationMode: "design-input-only",
    target,
    change,
    evidence: structuredEvidence(input.evidence),
    examples: structuredExamples(input.examples),
    fixtureSuggestions: structuredFixtureSuggestions(input),
    validation: authoringValidation(input),
    trustNotes: authoringTrustNotes(input),
    warnings: authoringWarnings(input),
  };

  return assertStructuredProposal(structured);
}

export function ruleProposalDesignInputToStructuredProposal(
  proposal: RuleProposal,
  options: AuthoringProposalAdapterOptions,
): StructuredRatchetProposal | undefined {
  if (isAuthoringDesignInputProposal(proposal)) {
    return authoringDesignInputToStructuredProposal(proposal, options);
  }
  return undefined;
}

export function packFileWriteDescription(
  input: PackFileWriteDescriptionInput,
): FileWriteDescription {
  const hasContents = input.contents !== undefined;
  const hasPatch = input.patch !== undefined;
  if (hasContents === hasPatch) {
    throw new AuthoringProposalAdapterError(
      "file-write descriptions require exactly one of contents or patch",
    );
  }

  return {
    path: input.path,
    format: input.format,
    mode: input.mode ?? (hasPatch ? "patch" : "create"),
    atomic: input.atomic ?? true,
    backupRequired: input.backupRequired ?? true,
    ...(input.patch === undefined ? {} : { patch: input.patch }),
    ...(input.contents === undefined ? {} : { contents: input.contents }),
  };
}

export async function proposeStructuredAuthoringInputs(
  input: ProposeRulesInput,
  options?: ProposeRulesOptions & Partial<AuthoringProposalAdapterOptions>,
): Promise<readonly StructuredRatchetProposal[]> {
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
  const createdAt = options?.createdAt ?? new Date().toISOString();
  const adapterOptions: AuthoringProposalAdapterOptions = {
    createdAt,
    ...(options?.globalConfigPath === undefined
      ? {}
      : { globalConfigPath: options.globalConfigPath }),
    ...(options?.projectRoot === undefined
      ? {}
      : { projectRoot: options.projectRoot }),
    ...(options?.coreMatcherPath === undefined
      ? {}
      : { coreMatcherPath: options.coreMatcherPath }),
    ...(options?.shippedPackPath === undefined
      ? {}
      : { shippedPackPath: options.shippedPackPath }),
  };

  return proposals.flatMap((proposal) => {
    const structured = ruleProposalDesignInputToStructuredProposal(
      proposal,
      adapterOptions,
    );
    return structured === undefined ? [] : [structured];
  });
}

function isAuthoringDesignInputProposal(
  proposal: RuleProposal,
): proposal is AuthoringDesignInputProposal {
  return (
    (proposal.kind === "core-matcher" &&
      proposal.target === "core-matcher" &&
      proposal.coreMatcher !== undefined) ||
    (proposal.kind === "data" &&
      proposal.target === "shipped-pack" &&
      proposal.packId !== undefined &&
      proposal.match !== undefined)
  );
}

function resolveAuthoringPaths(
  options: AuthoringProposalAdapterOptions,
): ResolvedAuthoringPaths {
  const projectRoot = options.projectRoot ?? process.cwd();
  const resolved = resolveConfigPaths(projectRoot);
  return {
    projectRoot,
    globalConfigPath: options.globalConfigPath ?? resolved.globalConfigFile,
    ...(options.coreMatcherPath === undefined
      ? {}
      : { coreMatcherPath: options.coreMatcherPath }),
    ...(options.shippedPackPath === undefined
      ? {}
      : { shippedPackPath: options.shippedPackPath }),
  };
}

function authoringTarget(
  input: AuthoringDesignInputProposal,
  paths: ResolvedAuthoringPaths,
): ProposalTarget {
  switch (input.kind) {
    case "core-matcher":
      return {
        kind: "design-input",
        route: "core-matcher",
        ...(paths.coreMatcherPath === undefined
          ? {}
          : { suggestedPath: paths.coreMatcherPath }),
      };
    case "data":
      return {
        kind: "design-input",
        route: "shipped-pack",
        ...(paths.shippedPackPath === undefined
          ? {}
          : { suggestedPath: paths.shippedPackPath }),
      };
  }
}

function authoringChange(
  input: AuthoringDesignInputProposal,
  paths: ResolvedAuthoringPaths,
): PackFileAuthoringProposalChange {
  switch (input.kind) {
    case "core-matcher":
      return {
        kind: "pack-file-authoring",
        authoringKind: "core-matcher",
        matcherName: input.coreMatcher.name,
        matcherSignature: input.coreMatcher.signature,
        rationale: coreMatcherRationale(input),
        ...(paths.coreMatcherPath === undefined
          ? {}
          : {
              fileWrite: packFileWriteDescription({
                path: paths.coreMatcherPath,
                format: "json",
                contents: coreMatcherDesignInputContents(input.coreMatcher),
              }),
            }),
      };
    case "data":
      return {
        kind: "pack-file-authoring",
        authoringKind: "shipped-pack-source",
        packId: input.packId,
        ruleId: input.ruleId,
        rationale: shippedPackRationale(input),
        rawRule: rawRuleFromShippedPackProposal(input),
        ...(paths.shippedPackPath === undefined
          ? {}
          : {
              fileWrite: packFileWriteDescription({
                path: paths.shippedPackPath,
                format: "json",
                patch: [
                  {
                    op: "add",
                    path: "/rules/-",
                    value: rawRuleFromShippedPackProposal(input),
                  },
                ],
              }),
            }),
      };
  }
}

function authoringIntendedProvenance(): StructuredRatchetProposal["intendedProvenance"] {
  return "shipped";
}

function structuredEvidence(
  evidence: ProposalEvidence,
): StructuredProposalEvidence {
  const capturedOutcomeCounts = sortCountsByOrder<CapturedOutcomeLabel>(
    [...evidence.capturedOutcomeBreakdown.entries()].map(([label, calls]) => ({
      label,
      calls,
    })),
    CAPTURED_OUTCOME_LABELS,
  );
  const replayStatusCounts = sortCountsByOrder<ReplayStatus>(
    [
      { label: "review", calls: evidence.reviewCalls },
      { label: "hard_block", calls: evidence.hardBlockCalls },
    ],
    REPLAY_STATUSES,
  );

  return {
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
  examples: readonly ProposalExample[],
): readonly StructuredProposalExample[] {
  return examples;
}

function structuredFixtureSuggestions(
  proposal: RuleProposal,
): readonly ProposalFixtureSuggestion[] {
  return proposal.fixtureSuggestions;
}

function authoringValidation(
  input: AuthoringDesignInputProposal,
): ProposalValidation {
  return {
    schema: check(
      "pass",
      "proposal-schema-ok",
      "structured proposal conforms to proposal-schema",
    ),
    matcherCompile:
      input.kind === "data"
        ? check(
            input.compiledMatch === undefined ? "pending" : "pass",
            input.compiledMatch === undefined
              ? "matcher-compile-pending"
              : "matcher-compiled",
            input.compiledMatch === undefined
              ? "shipped-pack source suggestion carries raw matcher JSON for later compile validation"
              : "legacy generator compiled the shipped-pack matcher through compileMatch",
          )
        : check(
            "skipped",
            "matcher-compile-design-input",
            "authoring design input does not carry data-pack matcher JSON",
          ),
    floorOverlap: floorOverlapCheck(input),
    trust: trustCheck(input),
    replay: check(
      "pending",
      "replay-pending",
      "replay-delta validation runs in a downstream feature",
    ),
  };
}

function floorOverlapCheck(
  input: AuthoringDesignInputProposal,
): ProposalValidationCheck {
  if (input.kind === "core-matcher") {
    return check(
      "pending",
      "floor-overlap-core-design",
      "core matcher implementation must prove sealed-floor overlap behavior before it can become writable policy",
      {
        checkedFloorRuleIds: input.floorOverlap.checkedFloorRuleIds,
        overlappingFloorRuleIds: input.floorOverlap.overlappingFloorRuleIds,
      },
    );
  }
  return check(
    input.floorOverlap.status === "disjoint" ? "pass" : "pending",
    input.floorOverlap.status === "disjoint"
      ? "floor-overlap-recorded"
      : "floor-overlap-review-required",
    input.floorOverlap.note,
    {
      checkedFloorRuleIds: input.floorOverlap.checkedFloorRuleIds,
      overlappingFloorRuleIds: input.floorOverlap.overlappingFloorRuleIds,
    },
  );
}

function trustCheck(
  input: AuthoringDesignInputProposal,
): ProposalValidationCheck {
  if (input.kind === "core-matcher") {
    return check(
      "pending",
      "trust-pending-core-source-change",
      "core matcher design input routes to package-source implementation, not user config",
    );
  }
  return check(
    "pending",
    "trust-pending-shipped-source-change",
    "shipped-pack source suggestions route to package-source implementation, not user config",
  );
}

function authoringTrustNotes(
  input: AuthoringDesignInputProposal,
): readonly ProposalTrustNote[] {
  const notes: ProposalTrustNote[] = [
    {
      kind: "design-input-only",
      message:
        "This recommendation is structured design input; generation never writes pack source or executable policy.",
      severity: "info",
    },
    {
      kind: "corpus-link-pending",
      message:
        "Legacy proposal evidence is aggregate-only; corpus family and record ids will be populated by the corpus-query-model integration.",
      severity: "info",
    },
  ];

  if (input.kind === "core-matcher") {
    notes.push({
      kind: "core-source-change",
      message:
        "Core matcher proposals route to package-source design and implementation, not user-owned config.",
      severity: "warning",
    });
  } else {
    notes.push({
      kind: "shipped-source-change",
      message:
        "Shipped-pack suggestions route to package-source design and implementation, not user-owned config.",
      severity: "warning",
    });
  }

  return notes;
}

function authoringWarnings(
  input: AuthoringDesignInputProposal,
): readonly string[] {
  const warnings = new Set<string>(input.warnings);
  warnings.add(
    "authoring proposal is design input only; no file is written during generation",
  );
  if (input.kind === "core-matcher") {
    warnings.add(
      "core matcher implementation is package-source work, not user config",
    );
  }
  if (input.kind === "data") {
    warnings.add("shipped-pack source suggestion is non-writable design input");
  }
  return [...warnings];
}

function authoringTitle(input: AuthoringDesignInputProposal): string {
  switch (input.kind) {
    case "core-matcher":
      return `Design core matcher ${input.coreMatcher.name}`;
    case "data":
      return `Suggest shipped-pack rule ${input.ruleId}`;
  }
}

function authoringSummary(input: AuthoringDesignInputProposal): string {
  switch (input.kind) {
    case "core-matcher":
      return input.coreMatcher.gap;
    case "data":
      return `Suggest adding ${input.ruleId} to shipped pack ${input.packId}.`;
  }
}

function coreMatcherRationale(
  input: Extract<AuthoringDesignInputProposal, { kind: "core-matcher" }>,
): string {
  return `${input.coreMatcher.rationale}\n\nDSL gap: ${input.coreMatcher.gap}`;
}

function shippedPackRationale(
  input: Extract<AuthoringDesignInputProposal, { kind: "data" }>,
): string {
  return `${input.reason}\n\nTarget shipped pack: ${input.packId}.`;
}

function rawRuleFromShippedPackProposal(
  input: Extract<AuthoringDesignInputProposal, { kind: "data" }>,
): unknown {
  return {
    id: input.ruleId,
    effect: input.effect,
    match: input.match,
    reason: input.reason,
    provenance: { source: "shipped" },
  };
}

function coreMatcherDesignInputContents(input: CoreMatcherDesignInput): string {
  return JSON.stringify(
    {
      kind: "core-matcher-design-input",
      name: input.name,
      signature: input.signature,
      gap: input.gap,
      rationale: input.rationale,
      examples: input.examples,
    },
    null,
    2,
  );
}

function check(
  status: ProposalValidationCheck["status"],
  code: string,
  message: string,
  details?: unknown,
): ProposalValidationCheck {
  return {
    status,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}
