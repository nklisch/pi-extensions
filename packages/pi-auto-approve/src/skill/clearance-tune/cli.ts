#!/usr/bin/env node
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAuditLogger } from "../../audit/logger.ts";
import { createRotatingFileSink, noopAuditSink } from "../../audit/sink.ts";
import { loadConfig, type ResolvedConfig } from "../../config/loader.ts";
import {
  resolveConfigPaths,
  resolveUserConfigRoot,
} from "../../config/paths.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
  ProjectOverlaySchema,
} from "../../config/schema.ts";
import {
  type ComposerResult,
  composeEffectivePolicy,
} from "../../policy/composer.ts";
import type { EffectivePolicy } from "../../policy/core.ts";
import {
  type AuthoringProposalAdapterOptions,
  ruleProposalDesignInputToStructuredProposal,
} from "../../replay/authoring-proposal-adapter.ts";
import {
  type ConfigProposalAdapterOptions,
  reviewerConfigProposalToStructuredProposal,
} from "../../replay/config-proposal-adapter.ts";
import type { CorpusQueryModel } from "../../replay/corpus-query.ts";
import { buildCorpusQueryModel } from "../../replay/corpus-query.ts";
import type { ReplayCorpus } from "../../replay/history.ts";
import {
  type PolicyProposalAdapterOptions,
  policyRuleProposalToStructuredProposal,
} from "../../replay/policy-proposal-adapter.ts";
import {
  createStructuredProposalBatch,
  type StructuredProposalBatchInput,
} from "../../replay/proposal-batch.ts";
import { renderStructuredProposalCardMarkdown } from "../../replay/proposal-card.ts";
import type {
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import { proposeRules, type RuleProposal } from "../../replay/proposals.ts";
import { replayHistory } from "../../replay/ratchet.ts";
import { renderRatchetMarkdown } from "../../replay/ratchet-markdown.ts";
import { readReplayCorpus } from "../../replay/reader.ts";
import {
  type DeferredFrictionNote,
  proposeReviewerConfig,
  type ReviewerConfigProposal,
} from "../../replay/reviewer-config-proposals.ts";
import { renderStructuredRatchetMarkdown } from "../../replay/structured-markdown.ts";
import {
  type PlanWritePorts,
  planReviewerConfigWrite,
  planRuleWrite,
  type WritePlan,
  type WritePlanError,
} from "./apply-writer.ts";
import {
  type ApprovalPresentation,
  presentReviewerProposal,
  presentRuleProposal,
  renderDesignInputArtifact,
  routeReviewerProposal,
  routeRuleProposal,
} from "./presentation.ts";
import {
  isStructuredRatchetProposalLike,
  renderStructuredProposalPresentationMarkdown,
} from "./structured-presentation.ts";
import { verifyAfterWrite } from "./verify.ts";

export type RatchetCliCommand =
  | "propose"
  | "list"
  | "show"
  | "apply"
  | "verify";

export interface RatchetCliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly artifacts: readonly string[];
}

interface RatchetCliOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface ParsedArgs {
  readonly command: RatchetCliCommand;
  readonly id?: string;
  readonly runDir?: string;
  readonly cwd: string;
  readonly auditLogPath?: string;
  readonly sessionFilePath?: string;
  readonly corpusPaths?: readonly string[];
}

type LegacyStoredProposal = RuleProposal | ReviewerConfigProposal;
type StoredProposal = LegacyStoredProposal | StructuredRatchetProposal;

interface StoredRunArtifacts {
  readonly runDir: string;
  readonly proposals: readonly StoredProposal[];
  readonly deferred: readonly DeferredFrictionNote[];
  readonly corpus: ReplayCorpus;
}

interface StructuredRunArtifacts {
  readonly batch: StructuredProposalBatch;
  readonly report: string;
  readonly proposalCards: string;
}

interface LegacyToStructuredArtifactInput {
  readonly args: ParsedArgs;
  readonly paths: ReturnType<typeof resolveConfigPaths>;
  readonly generatedAt: string;
  readonly corpusModel: CorpusQueryModel;
  readonly ruleProposals: readonly RuleProposal[];
  readonly reviewerProposals: readonly ReviewerConfigProposal[];
}

interface LegacyToStructuredResult {
  readonly proposals: readonly StructuredRatchetProposal[];
  readonly warnings: readonly string[];
}

interface ComposedConfig {
  readonly resolved: ResolvedConfig;
  readonly composed: ComposerResult;
}

const COMMANDS = new Set<RatchetCliCommand>([
  "propose",
  "list",
  "show",
  "apply",
  "verify",
]);
const DEFAULT_AUDIT_LOG_FILE = "audit.log";
const REPORT_FILE = "report.md";
const STRUCTURED_REPORT_FILE = "structured-report.md";
const PROPOSALS_FILE = "proposals.json";
const STRUCTURED_PROPOSALS_FILE = "structured-proposals.json";
const PROPOSAL_CARDS_FILE = "proposal-cards.md";
const DEFERRED_FILE = "deferred.json";
const CORPUS_FILE = "corpus.json";
const VERIFICATION_FILE = "verification.md";
const PACKAGE_REGISTRY_HELPER_DISCLOSURE =
  "Helper CLI package parity disclosure: this internal harness does not collect Pi package-registration snapshots, so package-pack enablement replay/adversarial evidence is unavailable here unless a future snapshot option is added; use live Pi ratchet tools for authoritative package-pack validation.";

/**
 * Internal test/debug harness entry point for the ratchet replay, presentation,
 * write-plan, and verification modules. The maintained product workflow is
 * Pi-native `/clearance tune` with the temporary `clearance_*` tools; this
 * harness exists for focused tests and maintainer debugging, not as
 * a supported installed executable. Structured proposal objects remain the
 * source of truth and helper markdown is presentation only.
 */
export async function runRatchetCli(
  argv: readonly string[],
  options: RatchetCliOptions = {},
): Promise<RatchetCliResult> {
  return withProcessEnv(options.env, async () => {
    try {
      const parsed = parseArgs(argv, options);
      switch (parsed.command) {
        case "propose":
          return await runPropose(parsed);
        case "list":
          return await runList(parsed);
        case "show":
          return await runShow(parsed);
        case "apply":
          return await runApply(parsed);
        case "verify":
          return await runVerify(parsed);
      }
    } catch (error) {
      return result(1, `${errorMessage(error)}\n`, []);
    }
  });
}

async function runPropose(args: ParsedArgs): Promise<RatchetCliResult> {
  const paths = resolveConfigPaths(args.cwd);
  const runDir = args.runDir ?? newRunDir(paths.userConfigRoot);
  await mkdir(runDir, { recursive: true });

  const corpus = readReplayCorpus({
    ...(args.auditLogPath === undefined
      ? {}
      : { auditLogPath: args.auditLogPath }),
    ...(args.corpusPaths === undefined
      ? {}
      : { corpusPaths: args.corpusPaths }),
    ...(args.sessionFilePath === undefined
      ? {}
      : { sessionFilePath: args.sessionFilePath }),
  });
  const audit = createAuditLogger({ sink: noopAuditSink });
  const { resolved, composed } = await loadAndCompose(args.cwd, audit);
  if (!composed.ok) {
    return result(
      1,
      `Failed to compose effective policy:\n${composed.errors.join("\n")}\n`,
      [],
    );
  }

  const generatedAt = currentTimestampIso();
  const report = await replayHistory(corpus, composed.effectivePolicy, {
    repoRoot: args.cwd,
  });
  const markdown = renderRatchetMarkdown(report);
  const corpusModel = await buildCorpusQueryModel(
    corpus,
    composed.effectivePolicy,
  );
  const ruleProposals = await proposeRules({
    report,
    currentPolicy: composed.effectivePolicy,
  });
  const reviewerResult = await proposeReviewerConfig({
    report,
    currentReviewer: resolved.reviewer,
    currentMode: resolved.mode,
    trustedProject: resolved.trustedProject.trusted,
  });
  const proposals: readonly StoredProposal[] = [
    ...ruleProposals,
    ...reviewerResult.proposals,
  ];
  const structured = structuredArtifactsFromLegacy({
    args,
    paths,
    generatedAt,
    corpusModel,
    ruleProposals,
    reviewerProposals: reviewerResult.proposals,
  });

  const artifacts = await writeRunArtifacts(runDir, {
    report: markdown,
    proposals,
    deferred: reviewerResult.deferred,
    corpus,
    structured,
  });
  const warningText =
    reviewerResult.warnings.length === 0
      ? ""
      : `\nWarnings:\n${reviewerResult.warnings.map((warning) => `- ${warning}`).join("\n")}\n`;

  return result(
    0,
    `${[
      `Run directory: ${runDir}`,
      `Report: ${path.join(runDir, REPORT_FILE)}`,
      `Structured report: ${path.join(runDir, STRUCTURED_REPORT_FILE)}`,
      PACKAGE_REGISTRY_HELPER_DISCLOSURE,
      `Structured proposals: ${structured.batch.proposals.length}`,
      `Proposals: ${proposals.length}`,
      ...proposals.map((proposal) => `- ${proposal.id}`),
      warningText.trimEnd(),
    ]
      .filter((line) => line.length > 0)
      .join("\n")}\n`,
    artifacts,
  );
}

async function runList(args: ParsedArgs): Promise<RatchetCliResult> {
  const run = await loadRunArtifacts(args);
  const stdout = run.proposals.map((proposal) => proposal.id).join("\n");
  return result(0, stdout.length === 0 ? "" : `${stdout}\n`, []);
}

async function runShow(args: ParsedArgs): Promise<RatchetCliResult> {
  const id = requireProposalId(args);
  const run = await loadRunArtifacts(args);
  const proposal = findProposal(run.proposals, id);
  if (isStructuredRatchetProposalLike(proposal)) {
    return result(
      0,
      renderStructuredProposalPresentationMarkdown(proposal),
      [],
    );
  }

  const resolved = await loadConfig({ cwd: args.cwd });
  const presentation = presentProposal(
    proposal,
    resolved.trustedProject.trusted,
  );
  const designInput =
    presentation.route === "route-design-input"
      ? `\n${renderDesignInputArtifact(proposal, run.deferred)}`
      : "";

  return result(
    0,
    `${renderApprovalPresentation(presentation)}${designInput}`,
    [],
  );
}

async function runApply(args: ParsedArgs): Promise<RatchetCliResult> {
  const id = requireProposalId(args);
  const run = await loadRunArtifacts(args);
  const proposal = findProposal(run.proposals, id);

  if (isStructuredRatchetProposalLike(proposal)) {
    return result(
      2,
      "Structured proposals are display-only in this helper seam; no config write was attempted. Use legacy proposal apply or a later structured writer integration.\n",
      [],
    );
  }

  if (
    isRuleProposal(proposal) &&
    routeRuleProposal(proposal) === "route-design-input"
  ) {
    const artifactPath = path.join(
      run.runDir,
      "design-inputs",
      `${safeFileName(id)}.md`,
    );
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      renderDesignInputArtifact(proposal, run.deferred),
      "utf8",
    );
    return result(
      0,
      `Design-input artifact written: ${artifactPath}\nNo config write performed.\n`,
      [artifactPath],
    );
  }

  if (
    !isRuleProposal(proposal) &&
    routeReviewerProposal(proposal) === "route-design-input"
  ) {
    const artifactPath = path.join(
      run.runDir,
      "design-inputs",
      `${safeFileName(id)}.md`,
    );
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      renderDesignInputArtifact(proposal, run.deferred),
      "utf8",
    );
    return result(
      0,
      `Design-input artifact written: ${artifactPath}\nNo config write performed.\n`,
      [artifactPath],
    );
  }

  const paths = resolveConfigPaths(args.cwd);
  const silentAudit = createAuditLogger({ sink: noopAuditSink });
  const preWriteAudit = createAuditLogger({ sink: noopAuditSink });
  const before = await loadAndCompose(args.cwd, preWriteAudit);
  if (!before.composed.ok) {
    return result(
      1,
      `Failed to compose pre-write policy:\n${before.composed.errors.join("\n")}\n`,
      [],
    );
  }

  const currentRaw = await readCurrentTargetRaw(proposal, paths);
  const ports: PlanWritePorts = {
    compose: composeWithAudit,
    silentAudit,
  };
  const planResult = isRuleProposal(proposal)
    ? await planRuleWrite(proposal, before.resolved, currentRaw, paths, ports)
    : await planReviewerConfigWrite(
        proposal,
        before.resolved,
        currentRaw,
        paths,
        ports,
      );

  if (!planResult.ok) {
    return result(2, renderWritePlanError(planResult.error), []);
  }

  await atomicWriteJson(planResult.plan);

  const postWriteAudit = createAuditLogger({
    sink: createRotatingFileSink({
      path: defaultAuditLogPath(paths.userConfigRoot),
    }),
  });
  const after = await loadAndCompose(args.cwd, postWriteAudit);
  await postWriteAudit.flush?.();
  if (!after.composed.ok) {
    return result(
      1,
      `Config write completed but post-write policy composition failed:\n${after.composed.errors.join("\n")}\n`,
      [planResult.plan.target.path, planResult.plan.target.backupPath],
    );
  }

  const verification = await verifyPolicies(
    run.corpus,
    before.composed.effectivePolicy,
    after.composed.effectivePolicy,
  );
  const verificationPath = path.join(run.runDir, VERIFICATION_FILE);
  await writeFile(verificationPath, verification.markdown, "utf8");
  const artifacts = [verificationPath];

  const verificationSummary = verification.ok
    ? "Verification ok."
    : "Verification found hard fixture regressions.";

  return result(
    verification.ok ? 0 : 1,
    `${[
      `Applied proposal: ${id}`,
      `Target: ${planResult.plan.target.path}`,
      `Backup: ${planResult.plan.target.backupPath}`,
      `Verification: ${verificationPath}`,
      verificationSummary,
      `Expansions: ${verification.expansions.calls} calls / ${verification.expansions.unique} unique`,
    ].join("\n")}\n`,
    artifacts,
  );
}

async function runVerify(args: ParsedArgs): Promise<RatchetCliResult> {
  const run = await loadRunArtifacts(args);
  const audit = createAuditLogger({ sink: noopAuditSink });
  const current = await loadAndCompose(args.cwd, audit);
  if (!current.composed.ok) {
    return result(
      1,
      `Failed to compose current policy:\n${current.composed.errors.join("\n")}\n`,
      [],
    );
  }

  const verification = await verifyPolicies(
    run.corpus,
    current.composed.effectivePolicy,
    current.composed.effectivePolicy,
  );
  return result(
    verification.ok ? 0 : 1,
    `${verification.markdown}\nFixture regressions: ${verification.fixtureRegressions.length}\n`,
    [],
  );
}

async function verifyPolicies(
  userCorpus: ReplayCorpus,
  beforePolicy: EffectivePolicy,
  afterPolicy: EffectivePolicy,
) {
  const fixtureCorpus = readReplayCorpus({ auditLogPath: "" });
  return await verifyAfterWrite(
    userCorpus,
    fixtureCorpus,
    beforePolicy,
    afterPolicy,
  );
}

function structuredArtifactsFromLegacy(
  input: LegacyToStructuredArtifactInput,
): StructuredRunArtifacts {
  const converted = legacyProposalsToStructured(input);
  const batch = createStructuredProposalBatch({
    generatedAt: input.generatedAt,
    proposals: converted.proposals,
    source: {
      corpusSummary: corpusSummarySnapshot(input.corpusModel),
      warnings: input.corpusModel.warnings,
    },
    warnings: [PACKAGE_REGISTRY_HELPER_DISCLOSURE, ...converted.warnings],
  });
  return {
    batch,
    report: renderStructuredRatchetMarkdown({
      generatedAt: input.generatedAt,
      repoRoot: input.args.cwd,
      sourcePath: CORPUS_FILE,
      corpus: input.corpusModel,
      proposals: batch,
    }),
    proposalCards: renderStructuredProposalCardsMarkdown(batch),
  };
}

function legacyProposalsToStructured(
  input: LegacyToStructuredArtifactInput,
): LegacyToStructuredResult {
  const proposals: StructuredRatchetProposal[] = [];
  const warnings: string[] = [];
  const commonOptions = structuredAdapterOptions(input);

  for (const proposal of input.ruleProposals) {
    try {
      const authoring = ruleProposalDesignInputToStructuredProposal(
        proposal,
        commonOptions,
      );
      if (authoring !== undefined) {
        proposals.push(authoring);
        continue;
      }
      if (proposal.kind === "data") {
        proposals.push(
          policyRuleProposalToStructuredProposal(proposal, commonOptions),
        );
        continue;
      }
      warnings.push(
        `Skipped structured conversion for unsupported legacy rule proposal ${proposal.id} (${proposal.kind}/${proposal.target}).`,
      );
    } catch (error) {
      warnings.push(
        `Skipped structured conversion for legacy rule proposal ${proposal.id}: ${errorMessage(error)}`,
      );
    }
  }

  for (const proposal of input.reviewerProposals) {
    try {
      proposals.push(
        reviewerConfigProposalToStructuredProposal(proposal, commonOptions),
      );
    } catch (error) {
      warnings.push(
        `Skipped structured conversion for reviewer proposal ${proposal.id}: ${errorMessage(error)}`,
      );
    }
  }

  return { proposals, warnings };
}

function structuredAdapterOptions(
  input: LegacyToStructuredArtifactInput,
): PolicyProposalAdapterOptions &
  ConfigProposalAdapterOptions &
  AuthoringProposalAdapterOptions {
  return {
    createdAt: input.generatedAt,
    globalConfigPath: input.paths.globalConfigFile,
    projectOverlayPath: input.paths.projectOverlayFile,
    projectKey: input.paths.projectKey,
    projectRoot: input.args.cwd,
  };
}

function corpusSummarySnapshot(
  model: CorpusQueryModel,
): NonNullable<StructuredProposalBatchInput["source"]>["corpusSummary"] {
  return {
    totalRecords: model.summary.totalRecords,
    totalUniqueCommands: model.summary.totalUniqueCommands,
    modelReviewLoad: model.summary.modelReviewLoad,
    redactedCalls: model.summary.redactedCalls,
    lowFidelityCalls: model.summary.lowFidelityCalls,
  };
}

function renderStructuredProposalCardsMarkdown(
  batch: StructuredProposalBatch,
): string {
  if (batch.proposals.length === 0) {
    return "# Structured proposal cards\n\nNo structured proposals generated.\n";
  }
  return `${batch.proposals.map(renderStructuredProposalCardMarkdown).join("\n\n")}\n`;
}

async function writeRunArtifacts(
  runDir: string,
  artifacts: {
    readonly report: string;
    readonly proposals: readonly StoredProposal[];
    readonly deferred: readonly DeferredFrictionNote[];
    readonly corpus: ReplayCorpus;
    readonly structured?: StructuredRunArtifacts;
  },
): Promise<readonly string[]> {
  const reportPath = path.join(runDir, REPORT_FILE);
  const structuredReportPath = path.join(runDir, STRUCTURED_REPORT_FILE);
  const proposalsPath = path.join(runDir, PROPOSALS_FILE);
  const structuredProposalsPath = path.join(runDir, STRUCTURED_PROPOSALS_FILE);
  const proposalCardsPath = path.join(runDir, PROPOSAL_CARDS_FILE);
  const deferredPath = path.join(runDir, DEFERRED_FILE);
  const corpusPath = path.join(runDir, CORPUS_FILE);

  await writeFile(reportPath, artifacts.report, "utf8");
  await writeJson(proposalsPath, artifacts.proposals);
  await writeJson(deferredPath, artifacts.deferred);
  await writeJson(corpusPath, artifacts.corpus);

  const written = [reportPath, proposalsPath, deferredPath, corpusPath];
  if (artifacts.structured !== undefined) {
    await writeFile(structuredReportPath, artifacts.structured.report, "utf8");
    await writeJson(structuredProposalsPath, artifacts.structured.batch);
    await writeFile(
      proposalCardsPath,
      artifacts.structured.proposalCards,
      "utf8",
    );
    written.push(
      structuredReportPath,
      structuredProposalsPath,
      proposalCardsPath,
    );
  }

  return written;
}

async function loadRunArtifacts(args: ParsedArgs): Promise<StoredRunArtifacts> {
  const runDir =
    args.runDir ??
    (await latestRunDir(resolveConfigPaths(args.cwd).userConfigRoot));
  if (runDir === undefined) {
    throw new Error(
      "No ratchet run directory found. Run `propose` first or pass --run-dir.",
    );
  }

  return {
    runDir,
    proposals: await readJson<readonly StoredProposal[]>(
      path.join(runDir, PROPOSALS_FILE),
    ),
    deferred: await readJson<readonly DeferredFrictionNote[]>(
      path.join(runDir, DEFERRED_FILE),
    ),
    corpus: await readJson<ReplayCorpus>(path.join(runDir, CORPUS_FILE)),
  };
}

async function loadAndCompose(
  cwd: string,
  audit: ReturnType<typeof createAuditLogger>,
): Promise<ComposedConfig> {
  const resolved = await loadConfig({ cwd });
  const composed = await composeWithAudit(resolved, audit);
  return { resolved, composed };
}

async function composeWithAudit(
  config: ResolvedConfig,
  audit: ReturnType<typeof createAuditLogger>,
): Promise<ComposerResult> {
  return await composeEffectivePolicy(config, { audit });
}

async function readCurrentTargetRaw(
  proposal: LegacyStoredProposal,
  paths: ReturnType<typeof resolveConfigPaths>,
): Promise<unknown> {
  const target = proposal.target;
  const targetPath =
    target === "user-global"
      ? paths.globalConfigFile
      : paths.projectOverlayFile;

  try {
    return JSON.parse(await readFile(targetPath, "utf8")) as unknown;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new Error(`Could not read ${targetPath}: ${errorMessage(error)}`);
    }

    return defaultRawForTarget(target);
  }
}

function defaultRawForTarget(target: LegacyStoredProposal["target"]): unknown {
  if (target === "user-global") {
    const normalized = normalizeConfig(GlobalConfigSchema, { version: 1 });
    if (!normalized.ok) {
      throw new Error(
        "Internal default global config failed schema validation",
      );
    }
    return normalized.value;
  }

  if (target === "user-project") {
    const normalized = normalizeConfig(ProjectOverlaySchema, { version: 1 });
    if (!normalized.ok) {
      throw new Error(
        "Internal default project overlay failed schema validation",
      );
    }
    return normalized.value;
  }

  throw new Error(`Proposal target ${target} is not writable`);
}

async function atomicWriteJson(plan: WritePlan): Promise<void> {
  const targetPath = plan.target.path;
  const backupPath = plan.target.backupPath;
  const tmpPath = `${targetPath}.tmp`;
  const targetExisted = await pathExists(targetPath);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeJson(tmpPath, plan.mergedJson);

  try {
    if (targetExisted) {
      await rm(backupPath, { force: true });
      await rename(targetPath, backupPath);
    }
    await rename(tmpPath, targetPath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    if (targetExisted && (await pathExists(backupPath))) {
      await rm(targetPath, { force: true });
      await rename(backupPath, targetPath);
    }
    throw error;
  }
}

function parseArgs(
  argv: readonly string[],
  options: RatchetCliOptions,
): ParsedArgs {
  const cwdFromOptions = path.resolve(options.cwd ?? process.cwd());
  let command: RatchetCliCommand | undefined;
  let id: string | undefined;
  let runDir: string | undefined;
  let cwd = cwdFromOptions;
  let auditLogPath: string | undefined;
  let sessionFilePath: string | undefined;
  const corpusPaths: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      throw new Error(usage());
    }

    if (token === "--run-dir") {
      runDir = path.resolve(requireValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === "--cwd") {
      cwd = path.resolve(requireValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === "--audit-log") {
      auditLogPath = requireValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--no-audit") {
      auditLogPath = "";
      continue;
    }
    if (token === "--session-file") {
      sessionFilePath = requireValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--corpus") {
      corpusPaths.push(path.resolve(requireValue(argv, index, token)));
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}\n\n${usage()}`);
    }

    if (command === undefined) {
      if (!COMMANDS.has(token as RatchetCliCommand)) {
        throw new Error(`Unknown command: ${token}\n\n${usage()}`);
      }
      command = token as RatchetCliCommand;
      continue;
    }

    if (id === undefined) {
      id = token;
      continue;
    }

    throw new Error(`Unexpected argument: ${token}\n\n${usage()}`);
  }

  if (command === undefined) {
    throw new Error(usage());
  }

  return {
    command,
    cwd,
    ...(id === undefined ? {} : { id }),
    ...(runDir === undefined ? {} : { runDir }),
    ...(auditLogPath === undefined ? {} : { auditLogPath }),
    ...(sessionFilePath === undefined ? {} : { sessionFilePath }),
    ...(corpusPaths.length === 0 ? {} : { corpusPaths }),
  };
}

function requireValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function usage(): string {
  return [
    "scripts/dev/pi-clearance-tune.cjs — internal development harness",
    "",
    "This is an internal test/debug harness for the ratchet replay, presentation,",
    "write-plan, and verification modules. It does not collect live Pi package-registration snapshots, so package-pack evidence is lower fidelity here unless a snapshot option is added. It is not a supported installed",
    "executable and is not the maintained approval path. The supported product",
    "workflow is Pi-native ratchet mode:",
    "",
    "  /clearance tune             toggle Tune mode and expose/remove clearance_* tools",
    "",
    "Usage: scripts/dev/pi-clearance-tune.cjs <command> [id] [options]",
    "",
    "Commands:",
    "  propose              replay history and write report/proposal artifacts",
    "  list                 list proposal ids from the latest or selected run",
    "  show <id>            render an approval presentation; writes nothing",
    "  apply <id>           apply an already-approved proposal (internal harness only)",
    "  verify               re-check current on-disk policy against saved corpus/fixtures",
    "",
    "Options:",
    "  --run-dir <path>     use a specific ratchet run directory",
    "  --cwd <path>         project cwd for config resolution",
    "  --audit-log <path>   read audit history from path (empty string disables)",
    "  --no-audit           omit audit history",
    "  --session-file <p>   read Pi session tool calls from a saved session file",
    "  --corpus <path>      add a saved corpus JSON file (repeatable)",
  ].join("\n");
}

function presentProposal(
  proposal: LegacyStoredProposal,
  trustedProject: boolean,
): ApprovalPresentation {
  return isRuleProposal(proposal)
    ? presentRuleProposal(proposal, trustedProject)
    : presentReviewerProposal(proposal, trustedProject);
}

function renderApprovalPresentation(
  presentation: ApprovalPresentation,
): string {
  const fixtureLines =
    presentation.fixtureSuggestions === undefined
      ? []
      : [
          "## Fixture suggestions",
          "",
          ...presentation.fixtureSuggestions.map(
            (fixture) =>
              `- \`${fixture.command}\` → ${fixture.expected}: ${fixture.reason}`,
          ),
          "",
        ];
  const warningLines =
    presentation.warnings.length === 0
      ? []
      : [
          "## Warnings",
          "",
          ...presentation.warnings.map((warning) => `- ${warning}`),
          "",
        ];

  return `${[
    `# ${presentation.title}`,
    "",
    `Proposal: ${presentation.proposalId}`,
    `Kind: ${presentation.kind}`,
    `Route: ${presentation.route}`,
    `Summary: ${presentation.summary}`,
    `Trust required: ${presentation.trustRequired ? "yes" : "no"}`,
    "",
    "## Framing",
    "",
    `- ${presentation.framing.summary}`,
    `- Writes executable code: ${presentation.framing.writesExecutableCode ? "yes" : "no"}`,
    `- Touches DSL: ${presentation.framing.touchesDsl ? "yes" : "no"}`,
    `- Routes as design input: ${presentation.framing.routesAsDesignInput ? "yes" : "no"}`,
    `- Requires acknowledgment: ${presentation.framing.requiresAcknowledgment ? "yes" : "no"}`,
    `- Consent required: ${presentation.framing.consentRequired ? "yes" : "no"}`,
    "",
    "## Evidence",
    "",
    `- Calls: ${presentation.evidence.calls}`,
    `- Review calls: ${presentation.evidence.reviewCalls}`,
    `- Model-review calls: ${presentation.evidence.modelReviewCalls}`,
    `- Captured denial calls: ${presentation.evidence.capturedDenialCalls}`,
    `- Sample commands: ${presentation.evidence.sampleCommands.join(", ") || "none"}`,
    "",
    "## Exact diff",
    "",
    "```text",
    presentation.diffText,
    "```",
    "",
    "## Examples",
    "",
    ...exampleLines(presentation),
    "",
    ...fixtureLines,
    ...warningLines,
  ]
    .join("\n")
    .trimEnd()}\n`;
}

function exampleLines(presentation: ApprovalPresentation): readonly string[] {
  if (presentation.examples.length === 0) {
    return ["- none"];
  }

  return presentation.examples.map((example) => {
    const note = example.note === undefined ? "" : ` — ${example.note}`;
    return `- ${example.matches ? "matches" : "does not match"}: \`${example.command}\`${note}`;
  });
}

function findProposal(
  proposals: readonly StoredProposal[],
  id: string,
): StoredProposal {
  const proposal = proposals.find((candidate) => candidate.id === id);
  if (proposal === undefined) {
    throw new Error(`Proposal not found: ${id}`);
  }
  return proposal;
}

function requireProposalId(args: ParsedArgs): string {
  if (args.id === undefined || args.id.length === 0) {
    throw new Error(`${args.command} requires a proposal id`);
  }
  return args.id;
}

function isRuleProposal(
  proposal: LegacyStoredProposal,
): proposal is RuleProposal {
  return "ruleId" in proposal && "effect" in proposal;
}

function renderWritePlanError(error: WritePlanError): string {
  switch (error.kind) {
    case "schema":
      return `Rejected at write-time schema validation:\n${error.errors.join("\n")}\n`;
    case "floor-overlap":
      return `Rejected at write-time floor-overlap validation:\n${error.errors.join("\n")}\n`;
    case "override-invalid":
      return `Rejected invalid reviewer prompt override: ${error.reason}\n`;
    case "not-writable":
      return `Proposal is not writable: ${error.reason}\n`;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(value, jsonReplacer, 2)}\n`,
    "utf8",
  );
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }
  return value;
}

function currentTimestampIso(): string {
  return process.env.PI_AUTO_APPROVE_RATCHET_NOW ?? new Date().toISOString();
}

function newRunDir(userConfigRoot: string): string {
  const timestamp = currentTimestampIso().replace(/[:.]/g, "-");
  return path.join(userConfigRoot, "ratchet", timestamp);
}

async function latestRunDir(
  userConfigRoot: string,
): Promise<string | undefined> {
  const root = path.join(userConfigRoot, "ratchet");
  let entries: readonly string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry);
    try {
      if ((await stat(candidate)).isDirectory()) {
        dirs.push(candidate);
      }
    } catch {
      // Ignore races with cleanup; latest-run discovery is best-effort.
    }
  }

  return dirs.sort((left, right) => left.localeCompare(right)).at(-1);
}

function defaultAuditLogPath(userConfigRoot = resolveUserConfigRoot()): string {
  return path.join(userConfigRoot, DEFAULT_AUDIT_LOG_FILE);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function result(
  exitCode: 0 | 1 | 2,
  stdout: string,
  artifacts: readonly string[],
): RatchetCliResult {
  return { exitCode, stdout, artifacts };
}

async function withProcessEnv<T>(
  env: NodeJS.ProcessEnv | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  if (env === undefined) {
    return await callback();
  }

  const keys = Object.keys(env);
  const previous = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of keys) {
      const value = env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function isDirectCli(): boolean {
  const argvPath = process.argv[1];
  if (argvPath === undefined) {
    return false;
  }
  return path.resolve(argvPath) === fileURLToPath(import.meta.url);
}

if (isDirectCli()) {
  runRatchetCli(process.argv.slice(2)).then(
    (cliResult) => {
      if (cliResult.stdout.length > 0) {
        process.stdout.write(cliResult.stdout);
      }
      process.exitCode = cliResult.exitCode;
    },
    (error: unknown) => {
      process.stdout.write(`${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
