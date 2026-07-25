import { Value } from "@sinclair/typebox/value";

import { resolveConfigPaths } from "../config/paths.ts";
import {
  normalizeConfig,
  type ProjectOverlayConfig,
  ProjectOverlaySchema,
} from "../config/schema.ts";
import type { PackEnablementPlan } from "../packs/enablement.ts";
import type { PackRegistryEntry } from "../packs/registry.ts";
import type { PackReplayImpactSummary } from "../packs/validation.ts";
import {
  CAPTURED_OUTCOME_LABELS,
  type CapturedOutcomeLabel,
  REPLAY_STATUSES,
  type ReplayStatus,
  sortCountsByOrder,
} from "./corpus-model.ts";
import { packEnablementPlanToStructuredProposal } from "./pack-enablement-proposal.ts";
import type {
  JsonPatchOperation,
  PackagePackEnablementProposalChange,
  ProposalEvidence,
  ProposalExample,
  ProposalTarget,
  ProposalTrustNote,
  ProposalValidation,
  ProposalValidationCheck,
  ReviewerConfigProposalChange,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";
import {
  assertStructuredProposal,
  PROPOSAL_SCHEMA_VERSION,
} from "./proposal-schema.ts";
import type {
  ProposeReviewerConfigInput,
  ProposeReviewerConfigOptions,
  ReviewerConfigProposal,
  ReviewerProposalEvidence,
  ReviewerProposalExample,
} from "./reviewer-config-proposals.ts";
import { proposeReviewerConfig } from "./reviewer-config-proposals.ts";

export interface ConfigProposalAdapterOptions {
  readonly createdAt: string;
  readonly globalConfigPath?: string;
  readonly projectOverlayPath?: string;
  readonly projectKey?: string;
  readonly projectRoot?: string;
}

export interface ProjectScopeProposalInput {
  readonly id: string;
  readonly createdAt: string;
  readonly patch: readonly JsonPatchOperation[];
  readonly reason: string;
  readonly projectRoot: string;
  readonly projectKey?: string;
  readonly projectOverlayPath?: string;
  readonly beforeOverlay?: Partial<ProjectOverlayConfig>;
  readonly title?: string;
  readonly summary?: string;
  readonly evidence?: ProposalEvidence;
  readonly examples?: readonly ProposalExample[];
  readonly warnings?: readonly string[];
}

export interface PackagePackEnablementProposalInput {
  readonly plan: PackEnablementPlan;
  readonly createdAt: string;
  readonly evidence: ProposalEvidence;
  readonly registryEntry: PackRegistryEntry;
  readonly replayImpact?: PackReplayImpactSummary;
}

export class ConfigProposalAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigProposalAdapterError";
  }
}

interface ResolvedConfigProposalPaths {
  readonly globalConfigPath: string;
  readonly projectOverlayPath: string;
  readonly projectKey: string;
  readonly projectRoot: string;
}

export function reviewerConfigProposalToStructuredProposal(
  proposal: ReviewerConfigProposal,
  options: ConfigProposalAdapterOptions,
): StructuredRatchetProposal {
  const paths = resolveAdapterPaths(options);
  const target = reviewerTarget(proposal, paths);
  const structured: StructuredRatchetProposal = {
    version: PROPOSAL_SCHEMA_VERSION,
    id: proposal.id,
    kind: "reviewer-config",
    title: reviewerTitle(proposal),
    summary: proposal.diff.rendered,
    reason: proposal.reason,
    createdAt: options.createdAt,
    provenance: { source: "generated" },
    intendedProvenance:
      proposal.target === "user-global" ? "user-global" : "user-project",
    applicationMode: "writable-after-approval",
    target,
    change: reviewerChange(proposal),
    evidence: reviewerEvidence(proposal.evidence),
    examples: reviewerExamples(proposal.examples),
    fixtureSuggestions: [],
    validation: reviewerValidation(proposal),
    trustNotes: reviewerTrustNotes(proposal),
    warnings: reviewerWarnings(proposal),
  };

  return assertStructuredProposal(structured);
}

export async function proposeStructuredReviewerConfig(
  input: ProposeReviewerConfigInput,
  options?: ProposeReviewerConfigOptions &
    Partial<ConfigProposalAdapterOptions>,
): Promise<readonly StructuredRatchetProposal[]> {
  const legacy = await proposeReviewerConfig(input, options ?? {});
  const createdAt = options?.createdAt ?? new Date().toISOString();
  const adapterOptions: ConfigProposalAdapterOptions = {
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

  return legacy.proposals.map((proposal) =>
    reviewerConfigProposalToStructuredProposal(proposal, adapterOptions),
  );
}

export function projectScopeChangeToStructuredProposal(
  input: ProjectScopeProposalInput,
): StructuredRatchetProposal {
  const paths = resolveAdapterPaths({
    createdAt: input.createdAt,
    projectRoot: input.projectRoot,
    ...(input.projectKey === undefined ? {} : { projectKey: input.projectKey }),
    ...(input.projectOverlayPath === undefined
      ? {}
      : { projectOverlayPath: input.projectOverlayPath }),
  });
  const validationResult = validateProjectScopePatch(input);
  if (!validationResult.ok) {
    throw new ConfigProposalAdapterError(
      `invalid project-scope proposal: ${validationResult.errors.join("; ")}`,
    );
  }
  const validation = projectScopeValidation();
  const structured: StructuredRatchetProposal = {
    version: PROPOSAL_SCHEMA_VERSION,
    id: input.id,
    kind: "project-scope-config",
    title: input.title ?? "Update project path scope",
    summary:
      input.summary ??
      "Propose a user-owned project-scope config change for path-fact classification.",
    reason: input.reason,
    createdAt: input.createdAt,
    provenance: { source: "generated" },
    intendedProvenance: "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-project-overlay",
      path: paths.projectOverlayPath,
      projectKey: paths.projectKey,
      projectRoot: paths.projectRoot,
    },
    change: {
      kind: "project-scope-config",
      patch: input.patch,
    },
    evidence: input.evidence ?? emptyEvidence(),
    examples: input.examples ?? [],
    fixtureSuggestions: [],
    validation,
    trustNotes: projectScopeTrustNotes(input, validation),
    warnings: input.warnings ?? [],
  };

  return assertStructuredProposal(structured);
}

export function packagePackEnablementToStructuredProposal(
  input: PackagePackEnablementProposalInput,
): StructuredRatchetProposal {
  const base = packEnablementPlanToStructuredProposal({
    plan: input.plan,
    createdAt: input.createdAt,
    evidence: input.evidence,
    ...(input.replayImpact === undefined
      ? {}
      : { replayImpact: input.replayImpact }),
  });
  const change = base.change;
  if (change.kind !== "package-pack-enablement") {
    throw new ConfigProposalAdapterError(
      `expected package-pack-enablement change from plan adapter, got ${change.kind}`,
    );
  }

  const registryEntry = input.registryEntry;
  if (registryEntry.id !== input.plan.request.packId) {
    throw new ConfigProposalAdapterError(
      `registry entry id "${registryEntry.id}" does not match plan pack id "${input.plan.request.packId}"`,
    );
  }

  const packageMetadata = packageMetadataFor(registryEntry);
  const enrichedChange: PackagePackEnablementProposalChange = {
    ...change,
    ...packageMetadata,
    metadataWarnings: registryEntry.metadata.warnings.map(
      (warning) => warning.message,
    ),
  };
  const enrichedTarget = enrichPackageTarget(base.target, registryEntry);
  const proposal: StructuredRatchetProposal = {
    ...base,
    title: `${base.title}${registryEntry.availability.enabled ? " (already enabled)" : ""}`,
    summary: packageEnablementSummary(base.summary, registryEntry),
    target: enrichedTarget,
    change: enrichedChange,
    validation: packageEnablementValidation(base.validation, registryEntry),
    trustNotes: packageEnablementTrustNotes(base.trustNotes, registryEntry),
    warnings: packageEnablementWarnings(base.warnings, registryEntry),
  };

  return assertStructuredProposal(proposal);
}

function resolveAdapterPaths(
  options: ConfigProposalAdapterOptions,
): ResolvedConfigProposalPaths {
  const projectRoot = options.projectRoot ?? process.cwd();
  const resolved = resolveConfigPaths(projectRoot);
  return {
    globalConfigPath: options.globalConfigPath ?? resolved.globalConfigFile,
    projectOverlayPath:
      options.projectOverlayPath ?? resolved.projectOverlayFile,
    projectKey: options.projectKey ?? resolved.projectKey,
    projectRoot,
  };
}

function reviewerTarget(
  proposal: ReviewerConfigProposal,
  paths: ResolvedConfigProposalPaths,
): ProposalTarget {
  if (proposal.target === "user-global") {
    return { kind: "user-global-config", path: paths.globalConfigPath };
  }
  return {
    kind: "user-project-overlay",
    path: paths.projectOverlayPath,
    projectKey: paths.projectKey,
    projectRoot: paths.projectRoot,
  };
}

function reviewerChange(
  proposal: ReviewerConfigProposal,
): ReviewerConfigProposalChange {
  return {
    kind: "reviewer-config",
    pointer: proposal.diff.pointer,
    op: proposal.diff.op,
    before: proposal.diff.before,
    after: proposal.diff.after,
    rendered: proposal.diff.rendered,
  };
}

function reviewerEvidence(
  evidence: ReviewerProposalEvidence,
): ProposalEvidence {
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
  const corpusSummary = evidence.modelReviewLoad
    ? {
        totalRecords: evidence.calls,
        totalUniqueCommands: evidence.unique,
        modelReviewLoad: {
          calls: evidence.modelReviewLoad.calls,
          uniqueCommands: evidence.modelReviewLoad.unique,
        },
        redactedCalls: 0,
        lowFidelityCalls: 0,
      }
    : undefined;

  return {
    ...(corpusSummary === undefined ? {} : { corpusSummary }),
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

function reviewerExamples(
  examples: readonly ReviewerProposalExample[],
): readonly ProposalExample[] {
  return examples.map((example) => ({
    command: example.command,
    matches: true,
    ...(example.capturedOutcome === undefined
      ? {}
      : { capturedOutcome: example.capturedOutcome }),
    ...(example.note === undefined ? {} : { note: example.note }),
  }));
}

function reviewerValidation(
  proposal: ReviewerConfigProposal,
): ProposalValidation {
  return {
    schema: check(
      "pass",
      "proposal-schema-ok",
      "structured proposal conforms to proposal-schema",
    ),
    configSchema: check(
      proposal.validation.schemaOk ? "pass" : "fail",
      proposal.validation.schemaOk ? "config-schema-ok" : "config-schema-fail",
      proposal.validation.schemaOk
        ? "legacy reviewer proposal validated against config schema"
        : proposal.validation.schemaErrors.join("; "),
      { schemaErrors: proposal.validation.schemaErrors },
    ),
    promptOverride:
      proposal.validation.overrideValid === undefined
        ? check(
            "skipped",
            "prompt-override-not-applicable",
            "proposal does not change reviewer promptOverride",
          )
        : check(
            proposal.validation.overrideValid ? "pass" : "fail",
            proposal.validation.overrideValid
              ? "prompt-override-ok"
              : "prompt-override-invalid",
            proposal.validation.overrideReason ??
              "prompt override validation result recorded by legacy generator",
          ),
    trust: reviewerTrustCheck(proposal),
    replay: check(
      "pending",
      "replay-delta-pending",
      "replay-delta validation runs in a downstream feature",
    ),
  };
}

function reviewerTrustCheck(
  proposal: ReviewerConfigProposal,
): ProposalValidationCheck {
  if (proposal.approvalFraming.requiresAcknowledgment) {
    return check(
      "pending",
      "reviewer-config-ack-required",
      proposal.approvalFraming.summary,
    );
  }
  return check(
    "pass",
    "reviewer-config-trust-ok",
    "reviewer config proposal requires approval but no extra acknowledgement",
  );
}

function reviewerTrustNotes(
  proposal: ReviewerConfigProposal,
): readonly ProposalTrustNote[] {
  const notes: ProposalTrustNote[] = [
    {
      kind: "reviewer-config-change",
      message:
        "This proposal changes model-review behavior and requires explicit approval before writing user-owned config.",
      severity: "warning",
    },
  ];
  if (proposal.target === "user-project") {
    notes.push({
      kind: "project-prompt-append",
      message:
        "Project-scoped reviewer prompt changes affect this project overlay only.",
      severity: "warning",
    });
  }
  if (proposal.kind === "override-set" || proposal.kind === "override-clear") {
    notes.push({
      kind: "prompt-override",
      message:
        "Prompt override changes are validated against the reviewer response contract before proposal emission.",
      severity: "warning",
    });
  }
  if (proposal.approvalFraming.consentRequired) {
    notes.push({
      kind: "consent-required",
      message: proposal.approvalFraming.summary,
      severity: "warning",
    });
  }
  return notes;
}

function reviewerWarnings(proposal: ReviewerConfigProposal): readonly string[] {
  const warnings = new Set<string>(proposal.warnings);
  if (proposal.approvalFraming.changesReviewPath) {
    warnings.add("changes model-review behavior");
  }
  if (proposal.approvalFraming.consentRequired) {
    warnings.add("requires explicit approval before writing reviewer config");
  }
  return [...warnings];
}

function reviewerTitle(proposal: ReviewerConfigProposal): string {
  return `Reviewer config: ${proposal.kind}`;
}

function projectScopeValidation(): ProposalValidation {
  return {
    schema: check(
      "pass",
      "proposal-schema-ok",
      "structured proposal conforms to proposal-schema",
    ),
    configSchema: check(
      "pass",
      "project-overlay-schema-ok",
      "project-scope patch validates against ProjectOverlaySchema",
    ),
    trust: check(
      "pending",
      "project-scope-approval-required",
      "project-scope changes alter path-fact write boundaries and require explicit approval",
    ),
    replay: check(
      "pending",
      "replay-delta-pending",
      "replay-delta validation runs in a downstream feature",
    ),
  };
}

function validateProjectScopePatch(
  input: ProjectScopeProposalInput,
): { readonly ok: true } | { readonly ok: false; readonly errors: string[] } {
  if (projectScopePatchContainsUnknownAllow(input.patch)) {
    return {
      ok: false,
      errors: ['projectScope.unknownPathBehavior cannot be "allow"'],
    };
  }

  const base = input.beforeOverlay ?? { version: 1 };
  const normalizedBase = normalizeConfig(ProjectOverlaySchema, base);
  if (!normalizedBase.ok) {
    return {
      ok: false,
      errors: normalizedBase.errors.map(
        (error) => `${error.path}: ${error.message}`,
      ),
    };
  }

  const patched = applyJsonPatch(normalizedBase.value, input.patch);
  if (!patched.ok) {
    return patched;
  }
  if (!Value.Check(ProjectOverlaySchema, patched.value)) {
    return {
      ok: false,
      errors: [...Value.Errors(ProjectOverlaySchema, patched.value)].map(
        (error) => `${error.path}: ${error.message}`,
      ),
    };
  }
  return { ok: true };
}

type PatchContainer = Record<string, unknown> | unknown[];

function projectScopePatchContainsUnknownAllow(
  patch: readonly JsonPatchOperation[],
): boolean {
  return patch.some(
    (operation) =>
      operation.path === "/projectScope/unknownPathBehavior" &&
      operation.value === "allow",
  );
}

function applyJsonPatch(
  base: unknown,
  patch: readonly JsonPatchOperation[],
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: string[] } {
  const root = cloneJson(base);
  if (!isRecord(root)) {
    return { ok: false, errors: ["patch base must be a JSON object"] };
  }
  for (const operation of patch) {
    const applied = applyJsonPatchOperation(root, operation);
    if (!applied.ok) {
      return applied;
    }
  }
  return { ok: true, value: root };
}

function applyJsonPatchOperation(
  root: Record<string, unknown>,
  operation: JsonPatchOperation,
): { readonly ok: true } | { readonly ok: false; readonly errors: string[] } {
  const parts = pointerParts(operation.path);
  if (parts.length === 0) {
    return { ok: false, errors: ["patching the root object is not supported"] };
  }
  const parent = ensurePatchParent(root, parts.slice(0, -1));
  if (!parent.ok) {
    return parent;
  }
  const key = parts[parts.length - 1];
  if (key === undefined) {
    return { ok: false, errors: ["patch operation is missing a target key"] };
  }

  return applyPatchValue(parent.value, key, operation);
}

function ensurePatchParent(
  root: Record<string, unknown>,
  parts: readonly string[],
):
  | { readonly ok: true; readonly value: PatchContainer }
  | { readonly ok: false; readonly errors: string[] } {
  let cursor: PatchContainer = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const nextPart = parts[index + 1];
    if (part === undefined) {
      return {
        ok: false,
        errors: ["patch operation has an empty path segment"],
      };
    }

    const child = readPatchChild(cursor, part);
    if (child === undefined) {
      const next = shouldCreateArrayFor(nextPart) ? [] : {};
      const created = writePatchChild(cursor, part, next, "add");
      if (!created.ok) {
        return created;
      }
      cursor = next;
      continue;
    }

    if (!isPatchContainer(child)) {
      return {
        ok: false,
        errors: [
          `patch parent /${parts.slice(0, index + 1).join("/")} is not an object or array`,
        ],
      };
    }
    cursor = child;
  }
  return { ok: true, value: cursor };
}

function applyPatchValue(
  parent: PatchContainer,
  key: string,
  operation: JsonPatchOperation,
): { readonly ok: true } | { readonly ok: false; readonly errors: string[] } {
  if (operation.op === "remove") {
    return removePatchChild(parent, key);
  }
  return writePatchChild(parent, key, cloneJson(operation.value), operation.op);
}

function readPatchChild(parent: PatchContainer, key: string): unknown {
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key);
    return index === undefined ? undefined : parent[index];
  }
  return parent[key];
}

function writePatchChild(
  parent: PatchContainer,
  key: string,
  value: unknown,
  op: "add" | "replace",
): { readonly ok: true } | { readonly ok: false; readonly errors: string[] } {
  if (!Array.isArray(parent)) {
    parent[key] = value;
    return { ok: true };
  }

  if (key === "-") {
    if (op === "replace") {
      return { ok: false, errors: ['cannot replace array element "-"'] };
    }
    parent.push(value);
    return { ok: true };
  }

  const index = parseArrayIndex(key);
  if (index === undefined) {
    return {
      ok: false,
      errors: [`array patch path segment "${key}" is not a valid index`],
    };
  }
  if (op === "add") {
    if (index > parent.length) {
      return {
        ok: false,
        errors: [`array add index ${index} is beyond length ${parent.length}`],
      };
    }
    parent.splice(index, 0, value);
    return { ok: true };
  }
  if (index >= parent.length) {
    return {
      ok: false,
      errors: [
        `array replace index ${index} is beyond length ${parent.length}`,
      ],
    };
  }
  parent[index] = value;
  return { ok: true };
}

function removePatchChild(
  parent: PatchContainer,
  key: string,
): { readonly ok: true } | { readonly ok: false; readonly errors: string[] } {
  if (!Array.isArray(parent)) {
    delete parent[key];
    return { ok: true };
  }

  const index = parseArrayIndex(key);
  if (index === undefined || index >= parent.length) {
    return {
      ok: false,
      errors: [`array remove path segment "${key}" is not an existing index`],
    };
  }
  parent.splice(index, 1);
  return { ok: true };
}

function shouldCreateArrayFor(nextPart: string | undefined): boolean {
  return (
    nextPart === "-" ||
    (nextPart !== undefined && parseArrayIndex(nextPart) !== undefined)
  );
}

function parseArrayIndex(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/")) {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function projectScopeTrustNotes(
  _input: ProjectScopeProposalInput,
  _validation: ProposalValidation,
): readonly ProposalTrustNote[] {
  return [
    {
      kind: "path-scope-boundary",
      message:
        "Project-scope config changes alter path-fact write boundaries and must be approved before writing the project overlay.",
      severity: "warning",
    },
  ];
}

function packageMetadataFor(entry: PackRegistryEntry): {
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly packagePath?: string;
} {
  return {
    ...(entry.source.packageName === undefined
      ? {}
      : { packageName: entry.source.packageName }),
    ...(entry.source.packageVersion === undefined
      ? {}
      : { packageVersion: entry.source.packageVersion }),
    ...(entry.source.packagePath === undefined
      ? {}
      : { packagePath: entry.source.packagePath }),
  };
}

function enrichPackageTarget(
  target: StructuredRatchetProposal["target"],
  entry: PackRegistryEntry,
): ProposalTarget {
  if (target.kind !== "package-pack-config") {
    return target;
  }
  return {
    ...target,
    ...(entry.source.packageName === undefined
      ? {}
      : { packageName: entry.source.packageName }),
    ...(entry.source.packageVersion === undefined
      ? {}
      : { packageVersion: entry.source.packageVersion }),
  };
}

function packageEnablementValidation(
  validation: ProposalValidation,
  entry: PackRegistryEntry,
): ProposalValidation {
  return {
    ...validation,
    packageAvailability: check(
      "pass",
      entry.availability.enabled
        ? "package-pack-already-enabled"
        : "package-pack-available-disabled",
      entry.availability.enabled
        ? `package pack ${entry.id} is already enabled; applying this proposal should be a no-op or stale-preview refusal`
        : `package pack ${entry.id} is available but disabled until user-owned config explicitly enables it`,
      {
        packageName: entry.source.packageName,
        packageVersion: entry.source.packageVersion,
        packagePath: entry.source.packagePath,
        enabled: entry.availability.enabled,
      },
    ),
  };
}

function packageEnablementTrustNotes(
  existing: readonly ProposalTrustNote[],
  entry: PackRegistryEntry,
): readonly ProposalTrustNote[] {
  const notes: ProposalTrustNote[] = [...existing];
  if (entry.metadata.warnings.length > 0) {
    notes.push(
      ...entry.metadata.warnings.map((warning) => ({
        kind: "package-metadata-warning",
        message: warning.message,
        severity: warning.level,
      })),
    );
  }
  notes.push({
    kind: "package-available-not-enabled",
    message:
      "Installing or registering a package only makes its pack available; this proposal represents explicit user-owned enablement.",
    severity: "warning",
  });
  return notes;
}

function packageEnablementWarnings(
  existing: readonly string[],
  entry: PackRegistryEntry,
): readonly string[] {
  const warnings = new Set<string>(existing);
  if (entry.availability.enabled) {
    warnings.add(`package pack ${entry.id} is already enabled`);
  } else {
    warnings.add(`package pack ${entry.id} is available but not enabled`);
  }
  for (const warning of entry.metadata.warnings) {
    warnings.add(`[${warning.level}][metadata] ${warning.message}`);
  }
  return [...warnings];
}

function packageEnablementSummary(
  baseSummary: string,
  entry: PackRegistryEntry,
): string {
  const packageLabel = entry.source.packageName
    ? `${entry.source.packageName}${entry.source.packageVersion ? `@${entry.source.packageVersion}` : ""}`
    : "package-contributed pack";
  return `${baseSummary} Source: ${packageLabel}; currently ${entry.availability.enabled ? "enabled" : "available but disabled"}.`;
}

function emptyEvidence(): ProposalEvidence {
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

function cloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPatchContainer(value: unknown): value is PatchContainer {
  return isRecord(value) || Array.isArray(value);
}
