import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { resolveConfigPaths } from "../../config/paths.ts";
import { proposeStructuredAuthoringInputs } from "../../replay/authoring-proposal-adapter.ts";
import { proposeStructuredReviewerConfig } from "../../replay/config-proposal-adapter.ts";
import type { ReplayCorpus } from "../../replay/history.ts";
import { proposeStructuredPolicyChanges } from "../../replay/policy-proposal-adapter.ts";
import {
  createStructuredProposalBatch,
  getStructuredProposal,
} from "../../replay/proposal-batch.ts";
import { renderStructuredProposalCardMarkdown } from "../../replay/proposal-card.ts";
import type {
  ProposalApplicationMode,
  StructuredProposalBatch,
  StructuredProposalKind,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import { validateStructuredProposalBatch } from "../../replay/proposal-schema.ts";
import { type RatchetReport, replayHistory } from "../../replay/ratchet.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import type { RatchetToolDefinition } from "../ratchet-mode.ts";
import { readRatchetReplayCorpus, resolveRatchetPolicy } from "./analysis.ts";
import type { RatchetBatchCache } from "./batch-cache.ts";
import { RATCHET_TOOL_IDS } from "./ids.ts";
import {
  formatRatchetToolError,
  formatRatchetToolResult,
  throwIfAborted,
} from "./result.ts";
import type { RatchetToolDependencies } from "./types.ts";

const STRICT = { additionalProperties: false } as const;
const DEFAULT_MAX_PROPOSALS = 20;
const DEFAULT_MAX_CLUSTERS = 50;
const NO_PROPOSALS_WARNING =
  "No structured proposals generated from the current ratchet history and policy.";
const INCLUDE_FULL_SHAPE_NOTE =
  "includeFullShape is accepted for compatibility; structured proposal details remain authoritative and are not meaningfully trimmed by these proposal tools today.";

export const AutoReviewerGenerateProposalsParameters = Type.Object(
  {
    maxProposals: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description:
          "Maximum structured proposals to keep in the cached batch.",
      }),
    ),
    maxClusters: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description:
          "Maximum evidence clusters or reviewer families to inspect.",
      }),
    ),
    includeFullShape: Type.Optional(
      Type.Boolean({
        description:
          "Compatibility flag. Proposal details remain authoritative; current generation does not trim meaningful proposal shape data.",
      }),
    ),
  },
  STRICT,
);

export const AutoReviewerShowProposalParameters = Type.Object(
  {
    batchId: Type.String({
      minLength: 1,
      description: "Cached structured proposal batch id.",
    }),
    proposalId: Type.String({ minLength: 1, description: "Proposal id." }),
    includeFullShape: Type.Optional(
      Type.Boolean({
        description:
          "Compatibility flag. Returned structured proposal details remain authoritative.",
      }),
    ),
  },
  STRICT,
);

export interface ProposalSummaryEntry {
  readonly id: string;
  readonly kind: StructuredProposalKind;
  readonly title: string;
  readonly applicationMode: ProposalApplicationMode;
  readonly targetSummary: string;
  readonly changeSummary: string;
}

export interface ProposalCounts {
  readonly byKind: Readonly<Record<string, number>>;
  readonly byApplicationMode: Readonly<Record<string, number>>;
}

export interface IncludeFullShapeCompatibility {
  readonly requested: boolean;
  readonly note: string;
}

export interface AutoReviewerGenerateProposalsDetails {
  readonly batchId: string;
  readonly generatedAt: string;
  readonly proposalCount: number;
  readonly proposals: readonly ProposalSummaryEntry[];
  readonly counts: ProposalCounts;
  readonly warnings: readonly string[];
  readonly includeFullShape: IncludeFullShapeCompatibility;
}

export type AutoReviewerShowProposalDetails =
  | {
      readonly found: true;
      readonly batchId: string;
      readonly proposalId: string;
      readonly proposal: StructuredRatchetProposal;
      readonly cardMarkdown: string;
      readonly warnings: readonly string[];
      readonly includeFullShape: IncludeFullShapeCompatibility;
    }
  | {
      readonly found: false;
      readonly batchId: string;
      readonly proposalId: string;
      readonly reason:
        | "invalid-input"
        | "batch-not-found"
        | "proposal-not-found";
      readonly message: string;
      readonly knownProposalIds: readonly string[];
      readonly warnings: readonly string[];
      readonly includeFullShape: IncludeFullShapeCompatibility;
    };

export interface ProposalGenerationEngines {
  readonly readCorpus?: (ctx: ExtensionContext) => ReplayCorpus;
  readonly replayHistory?: typeof replayHistory;
  readonly proposePolicyChanges?: typeof proposeStructuredPolicyChanges;
  readonly proposeAuthoringInputs?: typeof proposeStructuredAuthoringInputs;
  readonly proposeReviewerConfig?: typeof proposeStructuredReviewerConfig;
  readonly clock?: () => Date;
}

interface ParsedGenerateParameters {
  readonly maxProposals: number;
  readonly maxClusters: number;
  readonly includeFullShape: boolean;
  readonly warnings: readonly string[];
}

interface ParsedShowParameters {
  readonly batchId: string;
  readonly proposalId: string;
  readonly includeFullShape: boolean;
  readonly warnings: readonly string[];
  readonly valid: boolean;
}

interface AdapterPaths {
  readonly globalConfigPath: string;
  readonly projectOverlayPath: string;
  readonly projectKey: string;
  readonly projectRoot: string;
}

export function createAutoReviewerGenerateProposalsTool(
  deps: RatchetToolDependencies,
  batchCache: RatchetBatchCache,
  engines: ProposalGenerationEngines = {},
): RatchetToolDefinition {
  return {
    name: RATCHET_TOOL_IDS.generateProposals,
    label: "Generate Ratchet Proposals",
    description:
      "Generate a bounded, structured batch of policy, authoring, and reviewer-config ratchet proposals from captured history. Read-only: never writes config or policy.",
    promptSnippet:
      "Draft structured ratchet proposal batches from replay evidence.",
    promptGuidelines: [
      "Use clearance_generate_proposals after inspecting structured history and pack status; generation caches the batch but never writes config.",
    ],
    parameters: AutoReviewerGenerateProposalsParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        const input = parseGenerateParameters(params);
        const policy = await resolveRatchetPolicy(ctx, deps);
        throwIfAborted(signal);
        const generatedAt = (
          engines.clock ?? (() => new Date())
        )().toISOString();
        const generatedDate = new Date(generatedAt);
        const readCorpus = engines.readCorpus ?? readRatchetReplayCorpus;
        const runReplay = engines.replayHistory ?? replayHistory;

        const corpus = readCorpus(ctx);
        throwIfAborted(signal);
        const report = await runReplay(corpus, policy.effectivePolicy, {
          clock: () => generatedDate,
          unknownToolPosture: policy.config.unknownToolPosture,
        });
        throwIfAborted(signal);

        const generationWarnings: string[] = [...input.warnings];
        const proposals = await generateStructuredProposals({
          report,
          policy,
          input,
          adapterPaths: adapterPathsFor(policy),
          engines,
          generatedAt,
          generatedDate,
          warnings: generationWarnings,
        });
        throwIfAborted(signal);

        if (proposals.length === 0) {
          generationWarnings.push(NO_PROPOSALS_WARNING);
        }

        let batch = createStructuredProposalBatch({
          generatedAt,
          proposals,
          source: {
            corpusSummary: corpusSummaryFromReport(report),
            warnings: report.corpus.warnings,
          },
          warnings: generationWarnings,
        });
        batch = capBatch(batch, input.maxProposals);

        const batchId = batchCache.store(batch);
        const details = buildGenerateDetails(batchId, batch, input);

        return formatRatchetToolResult(
          details,
          formatGenerateMarkdown(details),
        ) as unknown as AgentToolResult<AutoReviewerGenerateProposalsDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          RATCHET_TOOL_IDS.generateProposals,
          error,
        ) as unknown as AgentToolResult<AutoReviewerGenerateProposalsDetails>;
      }
    },
  };
}

export function createAutoReviewerShowProposalTool(
  batchCache: RatchetBatchCache,
): RatchetToolDefinition {
  return {
    name: RATCHET_TOOL_IDS.showProposal,
    label: "Show Ratchet Proposal",
    description:
      "Return one structured proposal and its proposal-card markdown from a cached ratchet proposal batch.",
    promptSnippet:
      "Show an exact structured proposal from a cached ratchet batch.",
    promptGuidelines: [
      "Use clearance_show_proposal to inspect exact proposed changes before replaying, validating, presenting, or approving them.",
    ],
    parameters: AutoReviewerShowProposalParameters,
    async execute(_toolCallId, params) {
      try {
        const input = parseShowParameters(params);
        const compatibility = includeFullShapeCompatibility(
          input.includeFullShape,
        );

        if (!input.valid) {
          const details: AutoReviewerShowProposalDetails = {
            found: false,
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "invalid-input",
            message:
              "Proposal lookup requires non-empty batchId and proposalId strings.",
            knownProposalIds: [],
            warnings: input.warnings,
            includeFullShape: compatibility,
          };
          return formatRatchetToolResult(
            details,
            formatNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerShowProposalDetails>;
        }

        const batch = batchCache.get(input.batchId);
        if (batch === undefined) {
          const warning = `No cached ratchet proposal batch found for batchId ${JSON.stringify(input.batchId)}. Generate proposals again if the extension reloaded or the session changed.`;
          const details: AutoReviewerShowProposalDetails = {
            found: false,
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "batch-not-found",
            message: warning,
            knownProposalIds: [],
            warnings: stableUnique([...input.warnings, warning]),
            includeFullShape: compatibility,
          };
          return formatRatchetToolResult(
            details,
            formatNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerShowProposalDetails>;
        }

        const proposal = getStructuredProposal(batch, input.proposalId);
        if (proposal === undefined) {
          const knownProposalIds = batch.proposals.map(
            (candidate) => candidate.id,
          );
          const warning = `No proposal ${JSON.stringify(input.proposalId)} found in batch ${JSON.stringify(input.batchId)}.`;
          const details: AutoReviewerShowProposalDetails = {
            found: false,
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "proposal-not-found",
            message: warning,
            knownProposalIds,
            warnings: stableUnique([
              ...input.warnings,
              ...batch.warnings,
              warning,
            ]),
            includeFullShape: compatibility,
          };
          return formatRatchetToolResult(
            details,
            formatNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerShowProposalDetails>;
        }

        const cardMarkdown = renderStructuredProposalCardMarkdown(proposal);
        const details: AutoReviewerShowProposalDetails = {
          found: true,
          batchId: input.batchId,
          proposalId: input.proposalId,
          proposal,
          cardMarkdown,
          warnings: stableUnique([...batch.warnings, ...proposal.warnings]),
          includeFullShape: compatibility,
        };

        return formatRatchetToolResult(
          details,
          cardMarkdown,
        ) as unknown as AgentToolResult<AutoReviewerShowProposalDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          RATCHET_TOOL_IDS.showProposal,
          error,
        ) as unknown as AgentToolResult<AutoReviewerShowProposalDetails>;
      }
    },
  };
}

async function generateStructuredProposals(input: {
  readonly report: RatchetReport;
  readonly policy: ResolvedPolicy;
  readonly input: ParsedGenerateParameters;
  readonly adapterPaths: AdapterPaths;
  readonly engines: ProposalGenerationEngines;
  readonly generatedAt: string;
  readonly generatedDate: Date;
  readonly warnings: string[];
}): Promise<readonly StructuredRatchetProposal[]> {
  const proposals: StructuredRatchetProposal[] = [];
  const proposalInput = {
    report: input.report,
    currentPolicy: input.policy.effectivePolicy,
  };
  const commonRuleOptions = {
    createdAt: input.generatedAt,
    clock: () => input.generatedDate,
    maxProposals: input.input.maxProposals,
    maxClusters: input.input.maxClusters,
  };
  const paths = input.adapterPaths;

  await appendGeneratedProposals(
    proposals,
    input.warnings,
    "policy proposal generation",
    () =>
      (input.engines.proposePolicyChanges ?? proposeStructuredPolicyChanges)(
        proposalInput,
        {
          ...commonRuleOptions,
          globalConfigPath: paths.globalConfigPath,
          projectOverlayPath: paths.projectOverlayPath,
          projectKey: paths.projectKey,
          projectRoot: paths.projectRoot,
        },
      ),
  );

  await appendGeneratedProposals(
    proposals,
    input.warnings,
    "authoring proposal generation",
    () =>
      (
        input.engines.proposeAuthoringInputs ?? proposeStructuredAuthoringInputs
      )(proposalInput, {
        ...commonRuleOptions,
        globalConfigPath: paths.globalConfigPath,
        projectRoot: paths.projectRoot,
      }),
  );

  await appendGeneratedProposals(
    proposals,
    input.warnings,
    "reviewer-config proposal generation",
    () =>
      (input.engines.proposeReviewerConfig ?? proposeStructuredReviewerConfig)(
        {
          report: input.report,
          currentReviewer: input.policy.config.reviewer,
          trustedProject: input.policy.config.trustedProject.trusted,
        },
        {
          createdAt: input.generatedAt,
          clock: () => input.generatedDate,
          maxProposals: input.input.maxProposals,
          maxFamilies: input.input.maxClusters,
          globalConfigPath: paths.globalConfigPath,
          projectOverlayPath: paths.projectOverlayPath,
          projectKey: paths.projectKey,
          projectRoot: paths.projectRoot,
        },
      ),
  );

  return proposals;
}

async function appendGeneratedProposals(
  proposals: StructuredRatchetProposal[],
  warnings: string[],
  label: string,
  generate: () => Promise<readonly StructuredRatchetProposal[]>,
): Promise<void> {
  try {
    proposals.push(...(await generate()));
  } catch (error: unknown) {
    warnings.push(`${label} failed safely: ${errorMessage(error)}`);
  }
}

function parseGenerateParameters(params: unknown): ParsedGenerateParameters {
  const record = asRecord(params);
  const warnings: string[] = [];
  return {
    maxProposals: readBoundedInteger(
      record,
      "maxProposals",
      { min: 1, max: 50, defaultValue: DEFAULT_MAX_PROPOSALS },
      warnings,
    ),
    maxClusters: readBoundedInteger(
      record,
      "maxClusters",
      { min: 1, max: 50, defaultValue: DEFAULT_MAX_CLUSTERS },
      warnings,
    ),
    includeFullShape: readOptionalBoolean(
      record,
      "includeFullShape",
      false,
      warnings,
    ),
    warnings,
  };
}

function parseShowParameters(params: unknown): ParsedShowParameters {
  const record = asRecord(params);
  const warnings: string[] = [];
  const batchId = readNonEmptyString(record, "batchId", warnings);
  const proposalId = readNonEmptyString(record, "proposalId", warnings);
  const includeFullShape = readOptionalBoolean(
    record,
    "includeFullShape",
    false,
    warnings,
  );

  return {
    batchId: batchId ?? "",
    proposalId: proposalId ?? "",
    includeFullShape,
    warnings,
    valid: batchId !== undefined && proposalId !== undefined,
  };
}

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function readBoundedInteger(
  record: Record<string, unknown>,
  key: string,
  bounds: {
    readonly min: number;
    readonly max: number;
    readonly defaultValue: number;
  },
  warnings: string[],
): number {
  if (!hasOwn(record, key)) {
    return bounds.defaultValue;
  }

  const value = record[key];
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
  ) {
    return value;
  }

  warnings.push(
    `Ignoring ${key} because it must be an integer between ${bounds.min} and ${bounds.max}.`,
  );
  return bounds.defaultValue;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
  warnings: string[],
): boolean {
  if (!hasOwn(record, key)) {
    return defaultValue;
  }

  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }

  warnings.push(`Ignoring ${key} because it must be a boolean.`);
  return defaultValue;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  warnings: string[],
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  warnings.push(`Ignoring ${key} because it must be a non-empty string.`);
  return undefined;
}

function adapterPathsFor(policy: ResolvedPolicy): AdapterPaths {
  const projectRoot = policy.config.cwd;
  const paths = resolveConfigPaths(projectRoot);
  return {
    globalConfigPath: paths.globalConfigFile,
    projectOverlayPath: paths.projectOverlayFile,
    projectKey: paths.projectKey,
    projectRoot,
  };
}

function corpusSummaryFromReport(
  report: RatchetReport,
): NonNullable<StructuredProposalBatch["source"]["corpusSummary"]> {
  return {
    totalRecords: nonNegativeInteger(report.corpus.totalCalls),
    totalUniqueCommands: nonNegativeInteger(report.corpus.totalUnique),
    modelReviewLoad: {
      calls: nonNegativeInteger(report.summary.modelReviewLoad.calls),
      uniqueCommands: nonNegativeInteger(report.summary.modelReviewLoad.unique),
    },
    redactedCalls: nonNegativeInteger(report.summary.redactedCalls),
    // Legacy RatchetReport exposes redaction but not a separate low-fidelity
    // count. In the current corpus model, redacted audit-only rows are the
    // low-fidelity rows, so this is the safest JSON-safe summary available here.
    lowFidelityCalls: nonNegativeInteger(report.summary.redactedCalls),
  };
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function capBatch(
  batch: StructuredProposalBatch,
  maxProposals: number,
): StructuredProposalBatch {
  if (batch.proposals.length <= maxProposals) {
    return batch;
  }

  const capped: StructuredProposalBatch = {
    ...batch,
    proposals: batch.proposals.slice(0, maxProposals),
    warnings: stableUnique([
      ...batch.warnings,
      `Capped proposal batch to ${maxProposals} of ${batch.proposals.length} proposals after validation and dedupe.`,
    ]),
  };
  const validation = validateStructuredProposalBatch(capped);
  if (!validation.ok) {
    throw new Error(
      `capped structured proposal batch failed validation: ${validation.errors.join("; ")}`,
    );
  }
  return validation.batch;
}

function buildGenerateDetails(
  batchId: string,
  batch: StructuredProposalBatch,
  input: ParsedGenerateParameters,
): AutoReviewerGenerateProposalsDetails {
  return {
    batchId,
    generatedAt: batch.generatedAt,
    proposalCount: batch.proposals.length,
    proposals: batch.proposals.map(proposalSummary),
    counts: proposalCounts(batch.proposals),
    warnings: batch.warnings,
    includeFullShape: includeFullShapeCompatibility(input.includeFullShape),
  };
}

function proposalSummary(
  proposal: StructuredRatchetProposal,
): ProposalSummaryEntry {
  return {
    id: proposal.id,
    kind: proposal.kind,
    title: proposal.title,
    applicationMode: proposal.applicationMode,
    targetSummary: targetSummary(proposal.target),
    changeSummary: changeSummary(proposal.change),
  };
}

function proposalCounts(
  proposals: readonly StructuredRatchetProposal[],
): ProposalCounts {
  return {
    byKind: countBy(proposals.map((proposal) => proposal.kind)),
    byApplicationMode: countBy(
      proposals.map((proposal) => proposal.applicationMode),
    ),
  };
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function targetSummary(target: StructuredRatchetProposal["target"]): string {
  switch (target.kind) {
    case "user-global-config":
      return `user-global config at ${target.path}`;
    case "user-project-overlay":
      return `project overlay ${target.projectKey} at ${target.path}`;
    case "package-pack-config":
      return `package pack ${target.packId} at ${target.path}`;
    case "design-input":
      return `design input via ${target.route}${
        target.suggestedPath === undefined
          ? ""
          : ` suggested at ${target.suggestedPath}`
      }`;
  }
}

function changeSummary(change: StructuredRatchetProposal["change"]): string {
  switch (change.kind) {
    case "policy-pack":
      return `${change.effect} ${change.packId}/${change.ruleId}`;
    case "reviewer-config":
      return `${change.op} ${change.pointer}`;
    case "project-scope-config":
      return `${change.patch.length} project-scope patch operation${
        change.patch.length === 1 ? "" : "s"
      }`;
    case "package-pack-enablement":
      return `${change.enable ? "enable" : "disable"} ${change.packId}`;
    case "pack-file-authoring":
      return `${change.authoringKind}${
        change.ruleId === undefined ? "" : ` ${change.ruleId}`
      }`;
  }
}

function includeFullShapeCompatibility(
  requested: boolean,
): IncludeFullShapeCompatibility {
  return {
    requested,
    note: INCLUDE_FULL_SHAPE_NOTE,
  };
}

function formatGenerateMarkdown(
  details: AutoReviewerGenerateProposalsDetails,
): string {
  const lines = [
    "# Clearance proposal batch",
    "",
    `- Batch id: \`${details.batchId}\``,
    `- Generated at: ${details.generatedAt}`,
    `- Proposals: ${details.proposalCount}`,
    `- Warnings: ${details.warnings.length}`,
  ];

  if (details.proposals.length === 0) {
    lines.push(
      "",
      "No structured proposals were generated from the current ratchet history and policy. The empty batch is cached so downstream tools can still handle it consistently.",
    );
    return lines.join("\n");
  }

  lines.push("", "## Proposals");
  for (const proposal of details.proposals.slice(0, 20)) {
    lines.push(
      `- \`${proposal.id}\` (${proposal.kind}, ${proposal.applicationMode}): ${proposal.title}`,
    );
  }
  if (details.proposals.length > 20) {
    lines.push(`- … ${details.proposals.length - 20} more proposal(s)`);
  }

  return lines.join("\n");
}

function formatNotFoundMarkdown(
  details: Extract<AutoReviewerShowProposalDetails, { readonly found: false }>,
): string {
  const lines = [
    "# Clearance proposal lookup",
    "",
    `- Found: false`,
    `- Reason: ${details.reason}`,
    `- Batch id: \`${details.batchId}\``,
    `- Proposal id: \`${details.proposalId}\``,
    `- Message: ${details.message}`,
  ];

  if (details.knownProposalIds.length > 0) {
    lines.push(
      `- Known proposal ids: ${details.knownProposalIds
        .map((id) => `\`${id}\``)
        .join(", ")}`,
    );
  }

  return lines.join("\n");
}

function stableUnique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
