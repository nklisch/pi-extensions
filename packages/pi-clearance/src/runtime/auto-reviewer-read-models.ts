import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  ResolvedConfig,
  ResolvedReviewerConfig,
} from "../config/loader.ts";
import {
  DEFAULT_PROJECT_SCOPE_BEHAVIOR,
  DEFAULT_REVIEWER_CONTEXT_MODE,
  DEFAULT_REVIEWER_ESCALATION,
  DEFAULT_REVIEWER_PROMPT_POSTURE,
  DEFAULT_REVIEWER_RECENT_CONTEXT,
  DEFAULT_REVIEWER_TOKEN_BUDGET,
  DEFAULT_REVIEW_NOTE_DISPLAY,
  DEFAULT_UNKNOWN_TOOL_POSTURE,
} from "../config/defaults.ts";
import { shippedPackActivationCondition } from "../packs/activation.ts";
import type { PackageRegistrationSnapshot } from "../packs/package-registration.ts";
import {
  deriveEffectSummary,
  getPackRegistryEntry,
  listPackRegistryEntries,
  type PackEffectSummary,
  type PackEnablement,
  type PackMetadataCompleteness,
  type PackRegistryEntry,
  type PackRegistryFilter,
  type PackSourceInfo,
  type PackSourceKind,
} from "../packs/registry.ts";
import type {
  PolicyPack,
  PolicyPackDocLink,
  PolicyPackExample,
  PolicyPackWarning,
} from "../policy/core.ts";
import type { ResolvedPolicy } from "./policy-cache.ts";
import type { RatchetModeStatus } from "./ratchet-mode.ts";
import {
  formatReviewerModel,
  isHighCostReviewerModel,
  type ReviewerModelRegistry,
  type ReviewerModelSource,
  resolveReviewerModel,
} from "./reviewer-model.ts";

/**
 * Shared read models for human-facing slash commands and ratchet-mode tools.
 *
 * The functions here are deliberately pure over an already-resolved policy. That
 * keeps persistent commands from importing temporary ratchet tool adapters while
 * preserving one source of truth for status and pack display normalization.
 */
export interface AutoReviewerStatusView {
  readonly ratchet: RatchetModeStatus;
  readonly project: {
    readonly trusted: boolean;
    readonly cwd: string;
  };
  readonly mode: ResolvedPolicy["config"]["mode"];
  readonly gatedTools?: readonly string[];
  /** Concise category labels for non-default user-owned settings. */
  readonly customizations?: readonly string[];
  readonly reviewer: {
    readonly promptPosture: string;
    readonly configuredModel: string | null;
    readonly resolvedModel: string | null;
    readonly resolvedModelSource: ReviewerModelSource;
    readonly resolvedModelNote?: string;
    readonly modelHighCost: boolean;
    readonly contextMode: ResolvedPolicy["config"]["reviewer"]["contextMode"];
    readonly tokenBudget?: ResolvedReviewerConfig["tokenBudget"];
    readonly escalation?: ResolvedReviewerConfig["escalation"];
    readonly promptAppends?: {
      readonly global: number;
      readonly globalProjectConfigured: number;
      readonly projectOverlayConfigured: number;
      readonly repositoryConfigured: number;
      readonly activeProject: number;
      /** Configured or active append count, whichever is more informative. */
      readonly total: number;
    };
    readonly promptOverrideConfigured?: boolean;
    /** Plain-language current reviewer path for gray-area calls. */
    readonly path: "model" | "human" | "passthrough" | "unattended-fallback";
    /** Plain-language consequence for status and settings surfaces. */
    readonly consequence: string;
  };
  readonly packs: {
    readonly total: number;
    readonly enabled: number;
  };
  readonly warnings: readonly string[];
}

export interface AutoReviewerPackView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly source: PackSourceKind;
  readonly enabled: boolean;
  readonly enabledBy: readonly PackEnablement[];
  readonly inBaseline: boolean;
  readonly tags: readonly string[];
  readonly docs: readonly PolicyPackDocLink[];
  readonly warnings: readonly PolicyPackWarning[];
  readonly examples: readonly PolicyPackExample[];
  readonly effectSummary: PackEffectSummary;
  readonly ruleCount: number;
}

export interface AutoReviewerPackListView {
  readonly packs: readonly AutoReviewerPackView[];
  readonly warnings: readonly string[];
}

export type AutoReviewerPackAvailabilityState =
  | "sealed-floor"
  | "baseline-included"
  | "enabled-global"
  | "enabled-project"
  | "available"
  | "disabled-global"
  | "disabled-project"
  | "missing"
  | "ambiguous"
  | "unavailable";

export interface AutoReviewerPackageProvenance {
  readonly name?: string;
  readonly version?: string;
  readonly installKind?: string;
  readonly sourceSpec?: string;
  readonly packagePath?: string;
  readonly entrypointPath?: string;
}

export interface AutoReviewerPackExplorerView extends AutoReviewerPackView {
  readonly effectCopy: string;
  readonly packageProvenance?: AutoReviewerPackageProvenance;
  readonly activationNote: string;
  readonly availabilityState: AutoReviewerPackAvailabilityState;
  readonly metadataCompleteness: PackMetadataCompleteness;
  readonly metadataComplete: boolean;
  readonly synthetic: boolean;
}

export interface AutoReviewerPackExplorerListView {
  readonly packs: readonly AutoReviewerPackExplorerView[];
  readonly warnings: readonly string[];
}

export interface PackExplorerFilter {
  readonly search?: string;
  readonly effect?: PackEffectSummary | "review";
}

export function buildAutoReviewerStatusView(input: {
  readonly ctx: ExtensionContext;
  readonly policy: ResolvedPolicy;
  readonly ratchet: RatchetModeStatus;
  readonly includeRegistryWarnings?: boolean;
}): AutoReviewerStatusView {
  const entries = input.policy.registry.entries;
  const enabled = entries.filter((entry) => entry.availability.enabled).length;
  const reviewer = input.policy.config.reviewer;
  const resolvedReviewerModel = resolveReviewerModel({
    registry: reviewerModelRegistry(input.ctx),
    spec: reviewer.model,
    fallback: contextModel(input.ctx),
  });
  const modelHighCost =
    resolvedReviewerModel.model !== undefined &&
    isHighCostReviewerModel(resolvedReviewerModel.model.id);
  const promptAppendCounts = reviewerPromptAppendCounts(input.policy.config);
  const reviewerPath = resolveReviewerPath({
    config: input.policy.config,
    hasUI: hasHumanReviewUi(input.ctx),
  });

  return {
    ratchet: input.ratchet,
    project: {
      trusted: projectTrusted(input.ctx, input.policy),
      cwd: projectCwd(input.ctx, input.policy),
    },
    mode: input.policy.config.mode,
    gatedTools: [...(input.policy.config.gatedTools ?? [])],
    customizations: customizationCategories(input.policy.config),
    reviewer: {
      promptPosture: reviewer.promptPosture,
      configuredModel: reviewer.model,
      resolvedModel:
        resolvedReviewerModel.model === undefined
          ? null
          : formatReviewerModel(resolvedReviewerModel.model),
      resolvedModelSource: resolvedReviewerModel.source,
      ...(resolvedReviewerModel.note === undefined
        ? {}
        : { resolvedModelNote: resolvedReviewerModel.note }),
      modelHighCost,
      contextMode: reviewer.contextMode,
      tokenBudget: { ...reviewer.tokenBudget },
      escalation: { ...reviewer.escalation },
      promptAppends: promptAppendCounts,
      promptOverrideConfigured: reviewer.promptOverride !== null,
      path: reviewerPath,
      consequence: reviewerConsequence(reviewerPath),
    },
    packs: {
      total: entries.length,
      enabled,
    },
    warnings: statusWarnings(
      input.policy,
      input.includeRegistryWarnings === true,
    ),
  };
}

export function formatReviewerPathLabel(
  path: AutoReviewerStatusView["reviewer"]["path"],
): string {
  switch (path) {
    case "model":
      return "model first";
    case "human":
      return "Pi UI";
    case "passthrough":
      return "mode off passthrough";
    case "unattended-fallback":
      return "unattended fallback";
  }
}

export function formatReviewerContextModeLabel(
  mode: AutoReviewerStatusView["reviewer"]["contextMode"],
): string {
  switch (mode) {
    case "minimal":
      return "minimal";
    case "recentContext":
      return "recent context";
  }
}

export function listAutoReviewerPacks(
  policy: ResolvedPolicy,
  filter?: PackRegistryFilter,
): AutoReviewerPackListView {
  return {
    packs: listPackRegistryEntries(policy.registry, filter).map(packView),
    warnings: stableUnique(policy.warnings),
  };
}

export function getAutoReviewerPack(
  policy: ResolvedPolicy,
  packId: string,
):
  | {
      readonly pack: AutoReviewerPackView;
      readonly warnings: readonly string[];
    }
  | undefined {
  const entry = getPackRegistryEntry(policy.registry, packId);
  if (entry === undefined) {
    return undefined;
  }

  return {
    pack: packView(entry),
    warnings: stableUnique(policy.warnings),
  };
}

export function buildPackExplorerView(
  policy: ResolvedPolicy,
  packId: string,
):
  | {
      readonly pack: AutoReviewerPackExplorerView;
      readonly warnings: readonly string[];
    }
  | undefined {
  const synthetic = syntheticPackageRows(policy).find(
    (pack) => pack.id === packId,
  );
  if (synthetic !== undefined) {
    return { pack: synthetic, warnings: stableUnique(policy.warnings) };
  }

  const entry = getPackRegistryEntry(policy.registry, packId);
  if (entry === undefined) {
    return undefined;
  }

  return {
    pack: packExplorerView(policy, entry),
    warnings: stableUnique(policy.warnings),
  };
}

export function buildPackExplorerListView(
  policy: ResolvedPolicy,
  registryFilter?: PackRegistryFilter,
  explorerFilter?: PackExplorerFilter,
): AutoReviewerPackExplorerListView {
  const effect = normalizePackExplorerEffectFilter(explorerFilter?.effect);
  const search = normalizeSearch(explorerFilter?.search);
  const packs = [
    ...listPackRegistryEntries(policy.registry, registryFilter).map(
      (entry) => ({
        pack: packExplorerView(policy, entry),
        matcherTerms: packMatcherSearchTerms(entry.pack),
      }),
    ),
    ...syntheticPackageRows(policy).map((pack) => ({
      pack,
      matcherTerms: [] as readonly string[],
    })),
  ]
    .filter(({ pack }) => effect === undefined || pack.effectSummary === effect)
    .filter(
      ({ pack, matcherTerms }) =>
        search === undefined || packMatchesSearch(pack, search, matcherTerms),
    )
    .map(({ pack }) => pack)
    .sort(comparePackExplorerViews);

  return {
    packs,
    warnings: stableUnique(policy.warnings),
  };
}

export function normalizePackExplorerEffectFilter(
  effect: PackExplorerFilter["effect"] | undefined,
): PackEffectSummary | undefined {
  if (effect === undefined) {
    return undefined;
  }
  if (effect === "review") {
    return "review-gate";
  }
  return effect;
}

export function packageRegistrationWarnings(
  snapshot: PackageRegistrationSnapshot,
): readonly string[] {
  return snapshot.issues.map(formatPackageRegistrationIssue);
}

function packView(entry: PackRegistryEntry): AutoReviewerPackView {
  return {
    id: entry.id,
    title: entry.metadata.title,
    description: entry.metadata.description,
    source: entry.source.kind,
    enabled: entry.availability.enabled,
    enabledBy: entry.availability.enabledBy.map((enablement) => ({
      ...enablement,
    })),
    inBaseline: entry.inBaseline,
    tags: [...entry.metadata.tags],
    docs: entry.metadata.docs.map((doc) => ({ ...doc })),
    warnings: entry.metadata.warnings.map((warning) => ({ ...warning })),
    examples: entry.metadata.examples.map((example) => ({ ...example })),
    effectSummary: deriveEffectSummary(entry),
    ruleCount: entry.pack.rules.length,
  };
}

function packExplorerView(
  policy: ResolvedPolicy,
  entry: PackRegistryEntry,
): AutoReviewerPackExplorerView {
  const base = packView(entry);
  const effectSummary = base.effectSummary;
  const metadataCompleteness = entry.metadataCompleteness;
  return {
    ...base,
    effectCopy: effectCopy(effectSummary),
    ...packageProvenance(entry.source),
    activationNote: activationNote(entry),
    availabilityState: availabilityState(policy, entry),
    metadataCompleteness: {
      ...metadataCompleteness,
      missingFields: [...metadataCompleteness.missingFields],
    },
    metadataComplete: metadataComplete(entry, effectSummary),
    synthetic: false,
  };
}

function syntheticPackageRows(
  policy: ResolvedPolicy,
): readonly AutoReviewerPackExplorerView[] {
  const rows: AutoReviewerPackExplorerView[] = [];
  for (const packId of new Set(
    policy.config.packEnablement.effectivePackagePackIds,
  )) {
    const matches = policy.packageRegistration.packs.filter(
      (pack) => pack.pack.id === packId,
    );
    if (matches.length === 1) {
      continue;
    }
    const state =
      matches.length > 1
        ? "ambiguous"
        : packageRegistryUnavailable(policy.packageRegistration)
          ? "unavailable"
          : "missing";
    rows.push(syntheticPackageRow(packId, state));
  }
  return rows;
}

function syntheticPackageRow(
  packId: string,
  state: "missing" | "ambiguous" | "unavailable",
): AutoReviewerPackExplorerView {
  const titlePrefix =
    state === "ambiguous"
      ? "Ambiguous package pack"
      : state === "unavailable"
        ? "Unavailable package pack"
        : "Missing package pack";
  const description =
    state === "ambiguous"
      ? `Enabled package pack "${packId}" matches multiple package registrations, so no package rules are active for this id.`
      : state === "unavailable"
        ? `Enabled package pack "${packId}" cannot be checked because package registration is unavailable.`
        : `Enabled package pack "${packId}" is not registered, so no package rules are active for this id.`;
  const metadataCompleteness: PackMetadataCompleteness = {
    hasTitle: false,
    hasDescription: false,
    hasDocs: false,
    hasTags: false,
    hasExamples: false,
    missingFields: ["title", "description", "docs", "tags", "examples"],
  };

  return {
    id: packId,
    title: `${titlePrefix}: ${packId}`,
    description,
    source: "package",
    enabled: false,
    enabledBy: [{ kind: "package-config" }],
    inBaseline: false,
    tags: [],
    docs: [],
    warnings: [
      {
        level: state === "ambiguous" ? "warning" : "danger",
        message: description,
      },
    ],
    examples: [],
    effectSummary: "unknown",
    ruleCount: 0,
    effectCopy: effectCopy("unknown"),
    activationNote: "",
    availabilityState: state,
    metadataCompleteness,
    metadataComplete: false,
    synthetic: true,
  };
}

function customizationCategories(
  config: ResolvedPolicy["config"],
): readonly string[] {
  const categories: string[] = [];
  const snapshots = config.sourceSnapshots;
  const reviewer = config.reviewer;
  const promptAppendCounts = reviewerPromptAppendCounts(config);

  if (reviewer.promptOverride !== null) categories.push("prompt override");
  if (promptAppendCounts.total > 0) {
    categories.push(`prompt appends (${promptAppendCounts.total})`);
  }
  if (reviewer.promptPosture !== DEFAULT_REVIEWER_PROMPT_POSTURE) {
    categories.push("posture");
  }
  if (reviewer.model !== null) categories.push("model pin");
  if (config.unknownToolPosture !== DEFAULT_UNKNOWN_TOOL_POSTURE) {
    categories.push("unknown-tool posture");
  }
  const recentContext = reviewer.recentContext;
  if (
    reviewer.contextMode !== DEFAULT_REVIEWER_CONTEXT_MODE ||
    recentContext.decisionLimit !== DEFAULT_REVIEWER_RECENT_CONTEXT.decisionLimit ||
    recentContext.decisionWindow !== DEFAULT_REVIEWER_RECENT_CONTEXT.decisionWindow ||
    (recentContext.conversationTurns ??
      DEFAULT_REVIEWER_RECENT_CONTEXT.conversationTurns) !==
      DEFAULT_REVIEWER_RECENT_CONTEXT.conversationTurns ||
    (recentContext.userTurns ?? DEFAULT_REVIEWER_RECENT_CONTEXT.userTurns) !==
      DEFAULT_REVIEWER_RECENT_CONTEXT.userTurns ||
    recentContext.conversationCharLimit !==
      DEFAULT_REVIEWER_RECENT_CONTEXT.conversationCharLimit
  ) {
    categories.push("context");
  }
  if (
    reviewer.tokenBudget.window !== DEFAULT_REVIEWER_TOKEN_BUDGET.window ||
    reviewer.tokenBudget.limit !== DEFAULT_REVIEWER_TOKEN_BUDGET.limit
  ) {
    categories.push("budget");
  }
  if (
    reviewer.escalation.enabled !== DEFAULT_REVIEWER_ESCALATION.enabled ||
    reviewer.escalation.denialLimit !==
      DEFAULT_REVIEWER_ESCALATION.denialLimit ||
    reviewer.escalation.window !== DEFAULT_REVIEWER_ESCALATION.window
  ) {
    categories.push("escalation");
  }
  const gatedTools = config.gatedTools ?? [];
  if (gatedTools.length > 0) {
    categories.push(`gated tools (${gatedTools.length})`);
  }
  if (scopeIsCustomized(snapshots?.project.projectScope)) {
    categories.push("scope");
  }
  const packCount = customizedPackCount(snapshots);
  if (packCount > 0) categories.push(`packs (${packCount})`);
  if (
    config.display.reviewNote.mode !== DEFAULT_REVIEW_NOTE_DISPLAY.mode ||
    config.display.reviewNote.showModelLabel !==
      DEFAULT_REVIEW_NOTE_DISPLAY.showModelLabel ||
    config.display.reviewNote.accent !== DEFAULT_REVIEW_NOTE_DISPLAY.accent
  ) {
    categories.push("display");
  }

  return categories;
}

function reviewerPromptAppendCounts(
  config: ResolvedPolicy["config"],
): NonNullable<AutoReviewerStatusView["reviewer"]["promptAppends"]> {
  const snapshots = config.sourceSnapshots;
  const global = config.reviewer.promptAppends.length;
  const globalProjectConfigured =
    snapshots?.global.reviewer.projectPromptAppends.length ?? 0;
  const projectOverlayConfigured = snapshots?.project.promptAppends.length ?? 0;
  const repositoryConfigured = snapshots?.repository.promptAppends.length ?? 0;
  const activeProject = config.reviewer.projectPromptAppends.length;
  const configuredTotal =
    global +
    globalProjectConfigured +
    projectOverlayConfigured +
    repositoryConfigured;
  const activeTotal = global + activeProject;

  return {
    global,
    globalProjectConfigured,
    projectOverlayConfigured,
    repositoryConfigured,
    activeProject,
    total: Math.max(configuredTotal, activeTotal),
  };
}

function scopeIsCustomized(scope: unknown): boolean {
  if (scope === undefined || typeof scope !== "object" || scope === null) {
    return false;
  }
  const value = scope as Record<string, unknown>;
  return (
    [
      "roots",
      "writableDirectories",
      "tempDirectories",
      "deniedDirectories",
      "safeHomeDirectories",
      "agentSupportDirectories",
    ].some((key) => Array.isArray(value[key]) && value[key].length > 0) ||
    (value.safeHomeUseDefaults !== undefined &&
      value.safeHomeUseDefaults !==
        DEFAULT_PROJECT_SCOPE_BEHAVIOR.safeHomeUseDefaults) ||
    (value.agentSupportUseDefaults !== undefined &&
      value.agentSupportUseDefaults !==
        DEFAULT_PROJECT_SCOPE_BEHAVIOR.agentSupportUseDefaults) ||
    (value.unknownPathBehavior !== undefined &&
      value.unknownPathBehavior !==
        DEFAULT_PROJECT_SCOPE_BEHAVIOR.unknownPathBehavior) ||
    (value.sensitivePathBehavior !== undefined &&
      value.sensitivePathBehavior !==
        DEFAULT_PROJECT_SCOPE_BEHAVIOR.sensitivePathBehavior) ||
    (value.homePathBehavior !== undefined &&
      value.homePathBehavior !== DEFAULT_PROJECT_SCOPE_BEHAVIOR.homePathBehavior)
  );
}

function customizedPackCount(
  snapshots: ResolvedPolicy["config"]["sourceSnapshots"],
): number {
  if (snapshots === undefined) return 0;
  const { global, project, repository } = snapshots;
  return [
    global.packs.length,
    project.packs.length,
    repository.packs.length,
    global.packEnablement.enabledPackagePacks.length,
    global.packEnablement.disabledPackagePacks.length,
    global.packEnablement.disabledConfigPacks.length,
    project.packEnablement.enabledPackagePacks.length,
    project.packEnablement.disabledPackagePacks.length,
    project.packEnablement.disabledConfigPacks.length,
  ].reduce((total, count) => total + count, 0);
}

function effectCopy(effect: PackEffectSummary): string {
  switch (effect) {
    case "deny-floor":
      return "Denies catastrophic and trust-boundary commands (sealed floor).";
    case "deny":
      return "Denies matching commands.";
    case "review-gate":
      return "Review-gates matching commands before they can run.";
    case "allow":
      return "Allows matching commands when higher-priority review or deny packs do not apply.";
    case "mixed":
      return "Combines allow, review, and/or deny rules in one pack.";
    case "unknown":
      return "No policy rules are declared; effect is unknown.";
  }
}

function packageProvenance(source: PackSourceInfo): {
  readonly packageProvenance?: AutoReviewerPackageProvenance;
} {
  if (source.kind !== "package") {
    return {};
  }
  return {
    packageProvenance: {
      ...(source.packageName === undefined ? {} : { name: source.packageName }),
      ...(source.packageVersion === undefined
        ? {}
        : { version: source.packageVersion }),
      ...(source.packageInstallKind === undefined
        ? {}
        : { installKind: source.packageInstallKind }),
      ...(source.packageSourceSpec === undefined
        ? {}
        : { sourceSpec: source.packageSourceSpec }),
      ...(source.packagePath === undefined
        ? {}
        : { packagePath: source.packagePath }),
      ...(source.packageEntrypointPath === undefined
        ? {}
        : { entrypointPath: source.packageEntrypointPath }),
    },
  };
}

function activationNote(entry: PackRegistryEntry): string {
  if (entry.source.kind !== "shipped") {
    return "";
  }
  const condition = shippedPackActivationCondition(entry.id);
  if (condition === undefined) {
    return "";
  }
  const warning = entry.metadata.warnings.find((candidate) =>
    /conditionally active|active only/i.test(candidate.message),
  );
  if (warning !== undefined) {
    return warning.message;
  }
  return `Active only when one of the covered extension tools is registered: ${condition.toolNames.join(", ")}.`;
}

function availabilityState(
  policy: ResolvedPolicy,
  entry: PackRegistryEntry,
): AutoReviewerPackAvailabilityState {
  if (
    entry.id === "floor.deny" ||
    entry.availability.enabledBy.some(
      (enablement) => enablement.kind === "sealed-floor",
    )
  ) {
    return "sealed-floor";
  }
  if (
    entry.availability.enabledBy.some(
      (enablement) => enablement.kind === "baseline",
    )
  ) {
    return "baseline-included";
  }
  if (entry.availability.enabled) {
    if (entry.source.kind === "user-global") {
      return "enabled-global";
    }
    if (
      entry.source.kind === "user-project" ||
      entry.source.kind === "trusted-repo"
    ) {
      return "enabled-project";
    }
    if (entry.source.kind === "package") {
      // Composer-selected package packs should also appear in the resolved enablement
      // scope lists. If older or defensive fixture data omits that scope, keep the
      // row enabled rather than downgrading it to "available".
      return packageEnablementScopeState(policy, entry.id) ?? "enabled-global";
    }
  }

  const disabled = disabledState(policy, entry.id);
  if (disabled !== undefined) {
    return disabled;
  }
  return "available";
}

function disabledState(
  policy: ResolvedPolicy,
  packId: string,
): "disabled-global" | "disabled-project" | undefined {
  if (
    policy.config.packEnablement.project.disabledConfigPacks.includes(packId) ||
    policy.config.packEnablement.project.disabledPackagePacks.includes(packId)
  ) {
    return "disabled-project";
  }
  if (
    policy.config.packEnablement.global.disabledConfigPacks.includes(packId) ||
    policy.config.packEnablement.global.disabledPackagePacks.includes(packId)
  ) {
    return "disabled-global";
  }
  return undefined;
}

function packageEnablementScopeState(
  policy: ResolvedPolicy,
  packId: string,
): "enabled-global" | "enabled-project" | undefined {
  if (
    policy.config.packEnablement.project.enabledPackagePacks.includes(packId)
  ) {
    return "enabled-project";
  }
  if (
    policy.config.packEnablement.global.enabledPackagePacks.includes(packId)
  ) {
    return "enabled-global";
  }
  return undefined;
}

function packageRegistryUnavailable(
  snapshot: PackageRegistrationSnapshot,
): boolean {
  return snapshot.issues.some((issue) => issue.code === "no-event-bus");
}

function metadataComplete(
  entry: PackRegistryEntry,
  effectSummary: PackEffectSummary,
): boolean {
  const raw = entry.metadataCompleteness;
  const baseComplete =
    raw.hasTitle && raw.hasDescription && raw.hasDocs && raw.hasTags;
  if (!baseComplete) {
    return false;
  }
  if (effectSummary === "deny-floor") {
    return entry.metadata.examples.some(
      (example) => example.outcome === "deny",
    );
  }
  if (
    entry.pack.rules.some(
      (rule) => rule.effect === "allow" || rule.effect === "review",
    )
  ) {
    return raw.hasExamples;
  }
  return true;
}

function normalizeSearch(search: string | undefined): string | undefined {
  const normalized = search?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function packMatchesSearch(
  pack: AutoReviewerPackExplorerView,
  search: string,
  matcherTerms: readonly string[],
): boolean {
  const haystack = [
    pack.id,
    pack.title,
    pack.description,
    pack.effectSummary,
    pack.effectCopy,
    pack.source,
    ...pack.tags,
    ...pack.docs.flatMap((doc) => [doc.label, doc.href]),
    ...pack.examples.flatMap((example) => [
      example.outcome,
      example.shape,
      example.note ?? "",
    ]),
    ...matcherTerms,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(search);
}

function packMatcherSearchTerms(pack: PolicyPack): readonly string[] {
  return stableUnique(
    pack.rules.flatMap((rule) => matcherSearchTerms(rule.match)),
  );
}

function matcherSearchTerms(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => matcherSearchTerms(item));
  }
  if (!isRecord(value)) {
    return [];
  }

  const directTerms = Object.entries(value).flatMap(([key, child]) => {
    switch (key) {
      case "tool":
      case "name":
        return typeof child === "string" ? [child] : [];
      case "tools":
      case "programs":
        return Array.isArray(child)
          ? child.filter((item): item is string => typeof item === "string")
          : [];
      default:
        return [];
    }
  });

  return stableUnique([
    ...directTerms,
    ...Object.values(value).flatMap((child) => matcherSearchTerms(child)),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function comparePackExplorerViews(
  a: AutoReviewerPackExplorerView,
  b: AutoReviewerPackExplorerView,
): number {
  return (
    packSortRank(a) - packSortRank(b) ||
    metadataSortRank(a) - metadataSortRank(b) ||
    a.title.toLowerCase().localeCompare(b.title.toLowerCase()) ||
    a.id.localeCompare(b.id)
  );
}

function packSortRank(pack: AutoReviewerPackExplorerView): number {
  switch (pack.availabilityState) {
    case "sealed-floor":
      return 0;
    case "baseline-included":
      return 10;
    case "enabled-global":
    case "enabled-project":
      return 20;
    case "available":
      return 30;
    case "disabled-global":
    case "disabled-project":
      return 40;
    case "missing":
    case "ambiguous":
    case "unavailable":
      return 50;
  }
}

function metadataSortRank(pack: AutoReviewerPackExplorerView): number {
  return pack.metadataComplete ? 0 : 1;
}

function resolveReviewerPath(input: {
  readonly config: ResolvedConfig;
  readonly hasUI: boolean;
}): AutoReviewerStatusView["reviewer"]["path"] {
  if (input.config.mode === "off") return "passthrough";
  if (input.config.mode === "auto") return "model";
  return input.hasUI ? "human" : "unattended-fallback";
}

function reviewerConsequence(
  path: AutoReviewerStatusView["reviewer"]["path"],
): string {
  switch (path) {
    case "model":
      return "Reviews gray-area calls with the model first.";
    case "human":
      return "Gray-area calls will ask you in Pi UI.";
    case "passthrough":
      return "Gray-area calls pass through with an audit record; deterministic denies still block.";
    case "unattended-fallback":
      return "Gray-area calls use the configured unattended fallback (block-and-log).";
  }
}

function hasHumanReviewUi(ctx: ExtensionContext): boolean {
  return (ctx as { readonly hasUI?: unknown }).hasUI === true;
}

function reviewerModelRegistry(ctx: ExtensionContext): ReviewerModelRegistry {
  const registry = (ctx as { readonly modelRegistry?: unknown }).modelRegistry;
  if (!isReviewerModelRegistry(registry)) return EMPTY_REVIEWER_MODEL_REGISTRY;
  return registry;
}

function contextModel(ctx: ExtensionContext): Model<Api> | undefined {
  const model = (ctx as { readonly model?: unknown }).model;
  return isModelLike(model) ? model : undefined;
}

const EMPTY_REVIEWER_MODEL_REGISTRY: ReviewerModelRegistry = {
  find: () => undefined,
  getAll: () => [],
  hasConfiguredAuth: () => false,
};

function isReviewerModelRegistry(
  value: unknown,
): value is ReviewerModelRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { find?: unknown }).find === "function" &&
    typeof (value as { getAll?: unknown }).getAll === "function" &&
    typeof (value as { hasConfiguredAuth?: unknown }).hasConfiguredAuth ===
      "function"
  );
}

function isModelLike(value: unknown): value is Model<Api> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { provider?: unknown }).provider === "string"
  );
}

function projectTrusted(
  ctx: ExtensionContext,
  policy: ResolvedPolicy,
): boolean {
  const maybeContext = ctx as Partial<
    Pick<ExtensionContext, "isProjectTrusted">
  >;
  if (typeof maybeContext.isProjectTrusted !== "function") {
    return policy.config.trustedProject.trusted;
  }

  try {
    return maybeContext.isProjectTrusted();
  } catch {
    return policy.config.trustedProject.trusted;
  }
}

function projectCwd(ctx: ExtensionContext, policy: ResolvedPolicy): string {
  const cwd = (ctx as { readonly cwd?: unknown }).cwd;
  return typeof cwd === "string" ? cwd : policy.config.cwd;
}

function statusWarnings(
  policy: ResolvedPolicy,
  includeRegistryWarnings: boolean,
): readonly string[] {
  const registryWarnings = policy.registry.warnings;
  const registryWarningSet = new Set(registryWarnings);
  const packageIssueWarnings = packageRegistrationWarnings(
    policy.packageRegistration,
  );
  const packageIssueWarningSet = new Set(packageIssueWarnings);

  const packageSelectionWarnings = policy.warnings.filter(
    isPackageSelectionWarning,
  );
  const packageSelectionWarningSet = new Set(packageSelectionWarnings);
  const policyWarnings = policy.warnings.filter(
    (warning) =>
      !registryWarningSet.has(warning) &&
      !packageIssueWarningSet.has(warning) &&
      !packageSelectionWarningSet.has(warning),
  );

  if (!includeRegistryWarnings) {
    return stableUnique(policyWarnings);
  }

  return stableUnique([
    ...policyWarnings,
    ...registryWarnings,
    ...packageIssueWarnings,
    ...packageSelectionWarnings,
  ]);
}

function isPackageSelectionWarning(warning: string): boolean {
  return warning.startsWith("Enabled package pack ");
}

function formatPackageRegistrationIssue(
  issue: PackageRegistrationSnapshot["issues"][number],
): string {
  const packageLabel =
    issue.packageName === undefined ? "" : ` package=${issue.packageName}`;
  const packLabel = issue.packId === undefined ? "" : ` pack=${issue.packId}`;
  const ruleLabel = issue.ruleId === undefined ? "" : ` rule=${issue.ruleId}`;
  return `Package registration ${issue.severity} ${issue.code} at ${issue.path}${packageLabel}${packLabel}${ruleLabel}: ${issue.message}`;
}

function stableUnique<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}
