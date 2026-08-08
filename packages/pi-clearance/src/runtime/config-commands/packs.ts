import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  PackEnablementAction,
  PackEnablementPlan,
  PackEnablementScope,
  PackEnablementSubject,
  PackEnablementWarning,
} from "../../packs/enablement.ts";
import {
  applyPackEnablementCommand,
  type PackEnablementCommandApplyResult,
  type PackEnablementCommandPreviewReport,
  previewPackEnablementCommandReport,
} from "../../packs/enablement-command.ts";
import type { PackageRegistrationSnapshot } from "../../packs/package-registration.ts";
import {
  PACK_EFFECT_SUMMARIES,
  PACK_SOURCE_KINDS,
  type PackEffectSummary,
  type PackRegistryEntry,
  type PackRegistryFilter,
  type PackSourceKind,
  SHIPPED_PACK_DEFINITIONS,
} from "../../packs/registry.ts";
import type { JsonPatchOperation } from "../../replay/proposal-schema.ts";
import {
  type AutoReviewerPackExplorerListView,
  type AutoReviewerPackExplorerView,
  type AutoReviewerPackView,
  buildPackExplorerListView,
  buildPackExplorerView,
  getAutoReviewerPack,
  type PackExplorerFilter,
} from "../auto-reviewer-read-models.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import { createConfigCommandWriterDependencies } from "./post-write-validation.ts";
import {
  type AutoReviewerAutocompleteItem,
  type AutoReviewerCommandDependencies,
  type CommandReport,
  completion,
  filterCompletions,
  resolvePolicyReport,
  refreshOperatorStatus,
  stableUnique,
  usageReport,
} from "./types.ts";

export type PackCommandAction = PackEnablementAction;
export type PackCommandScope = PackEnablementScope;

export interface PackMutationRequest {
  readonly action: PackCommandAction;
  readonly packId: string;
  readonly scope?: PackCommandScope;
}

interface PackMutationTarget {
  readonly entry: PackRegistryEntry;
  readonly scope: PackEnablementScope;
  readonly subject: PackEnablementSubject;
}

interface PackMutationSuccessDetails {
  readonly request: PackMutationRequest;
  readonly source: PackSourceKind;
  readonly subject: PackEnablementSubject;
  readonly scope: PackEnablementScope;
  readonly preview: PackEnablementCommandPreviewReport;
  readonly apply: PackEnablementCommandApplyResult;
  readonly effectivePack?: AutoReviewerPackView;
  readonly effectiveWarnings: readonly string[];
}

const PACK_MUTATION_ACTIONS = ["enable", "disable"] as const;
const PACK_SCOPE_FLAGS = {
  "--global": "global",
  "--project": "project",
} as const satisfies Record<string, PackEnablementScope>;

const PACK_FILTER_COMPLETIONS = [
  completion("enable", "Enable an available package or config pack"),
  completion("disable", "Disable an available package or config pack"),
  completion("show", "Show one pack by id"),
  completion("--enabled", "List enabled packs"),
  completion("--disabled", "List disabled packs"),
  completion("--source", "Filter by source"),
  completion("--tag", "Filter by pack tag"),
  completion("--effect", "Filter by derived effect"),
  completion(
    "--search",
    "Search pack titles, docs, tags, examples, tools, and ids",
  ),
  completion("--query", "Alias for --search"),
  completion("--ids", "Show technical ids as the primary label"),
  completion("--verbose", "Print a full dossier for every listed pack"),
] as const;

const PACK_SCOPE_COMPLETIONS = [
  completion("--global", "Write the global user config"),
  completion("--project", "Write the project overlay config"),
] as const;

export async function handlePacksCommand(
  tokens: readonly string[],
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  if (tokens[0] === "show") {
    if (tokens.length !== 2) {
      return usageReport("Expected `packs show <pack-id>`.");
    }

    const policy = await resolvePolicyReport(ctx, deps);
    if (!policy.ok) {
      return policy.report;
    }

    return handlePackShowCommand(tokens.slice(1), policy.policy);
  }

  if (isPackCommandAction(tokens[0])) {
    const parsed = parsePackMutationTokens(tokens);
    if (!parsed.ok) {
      return packMutationRefusalReport({
        action: tokens[0],
        packId: tokens[1] ?? "",
        reason: parsed.reason,
        markdownLines: ["- No config changes were written."],
      });
    }

    return await handlePackMutationCommand({
      request: parsed.request,
      ctx,
      deps,
    });
  }

  const parsed = parsePackListFilters(tokens);
  if (!parsed.ok) {
    return usageReport(parsed.reason);
  }

  const policy = await resolvePolicyReport(ctx, deps);
  if (!policy.ok) {
    return policy.report;
  }

  return buildDefaultPackListingReport({
    policy: policy.policy,
    filter: parsed.filter,
    explorerFilter: parsed.explorerFilter,
    idsPrimary: parsed.idsPrimary,
    verbose: parsed.verbose,
  });
}

export interface DefaultPackListingDetails
  extends AutoReviewerPackExplorerListView {
  readonly filter: PackRegistryFilter;
  readonly explorerFilter: PackExplorerFilter;
  readonly idsPrimary: boolean;
  readonly verbose: boolean;
}

/**
 * Human-facing default pack listing used by `/clearance packs` and
 * settings drill-downs. Titles are the primary labels; stable pack ids stay as
 * secondary metadata so humans do not have to scan dot/colon-path identifiers.
 */
export function buildDefaultPackListingReport(input: {
  readonly policy: ResolvedPolicy;
  readonly filter?: PackRegistryFilter;
  readonly explorerFilter?: PackExplorerFilter;
  readonly idsPrimary?: boolean;
  readonly verbose?: boolean;
}): CommandReport<DefaultPackListingDetails> {
  const filter = input.filter ?? {};
  const explorerFilter = input.explorerFilter ?? {};
  const idsPrimary = input.idsPrimary === true;
  const verbose = input.verbose === true;
  const list = buildPackExplorerListView(input.policy, filter, explorerFilter);
  const details: DefaultPackListingDetails = {
    ...list,
    filter,
    explorerFilter,
    idsPrimary,
    verbose,
  };

  return {
    title: "Policy dossiers",
    summary: `${list.packs.length} pack(s) listed; ${list.warnings.length} warning(s).`,
    markdown: formatPackListMarkdown(details),
    details,
    level: list.warnings.length === 0 ? "info" : "warning",
  };
}

export async function handlePackMutationCommand(input: {
  readonly request: PackMutationRequest;
  readonly ctx: ExtensionCommandContext;
  readonly deps: AutoReviewerCommandDependencies;
}): Promise<CommandReport> {
  const { request, ctx, deps } = input;
  const packId = request.packId.trim();
  if (packId.length === 0) {
    return packMutationRefusalReport({
      action: request.action,
      packId,
      reason: `Expected a pack id after \`packs ${request.action}\`.`,
      markdownLines: ["- No config changes were written."],
    });
  }

  if (!ctx.hasUI) {
    return packMutationRefusalReport({
      action: request.action,
      packId,
      reason:
        "Pack enable/disable requires interactive Pi UI confirmation; no config changes were written.",
      markdownLines: [
        "- Mutating `/clearance packs enable|disable` commands require Pi UI confirmation.",
        "- No config changes were written.",
      ],
    });
  }

  const policy = await resolvePolicyReport(ctx, deps);
  if (!policy.ok) {
    return policy.report;
  }

  const target = await derivePackMutationTarget({
    request: { ...request, packId },
    ctx,
    policy: policy.policy,
  });
  if (!target.ok) {
    return target.report;
  }

  const preview = previewPackEnablementCommandReport({
    resolvedPolicy: policy.policy,
    action: request.action,
    scope: target.target.scope,
    subject: target.target.subject,
    packId,
  });

  if (!preview.result.ok) {
    return packMutationRefusalReport({
      action: request.action,
      packId,
      source: target.target.entry.source.kind,
      subject: target.target.subject,
      scope: target.target.scope,
      reason: preview.result.reason,
      warnings: preview.result.warnings,
      availabilityWarnings: preview.availabilityReport.warnings,
      markdownLines: [
        `- Source: ${target.target.entry.source.kind}`,
        `- Subject: ${target.target.subject}`,
        `- Scope: ${target.target.scope}`,
        "- The planner refused this pack enablement change.",
        "- No config changes were written.",
      ],
    });
  }

  const plan = preview.result.plan;
  const confirmed = await confirmPackEnablementPlan(ctx, plan, preview);
  if (!confirmed) {
    return {
      title: "Pack enablement cancelled",
      summary:
        "The pack enablement change was not confirmed; no config changes were written.",
      markdown: [
        "# Pack enablement cancelled",
        "",
        `- Pack: \`${packId}\``,
        `- Action: ${request.action}`,
        `- Target file: \`${plan.targetPath}\``,
        "- The confirmation prompt was declined or dismissed.",
        "- No config changes were written.",
      ].join("\n"),
      details: {
        request,
        source: target.target.entry.source.kind,
        subject: target.target.subject,
        scope: target.target.scope,
        preview,
      },
      level: "warning",
    };
  }

  const apply = await applyPackEnablementCommand(
    {
      plan,
      acknowledgement: acknowledgementForPlan(plan),
    },
    {
      ...createConfigCommandWriterDependencies(ctx, deps),
      invalidatePolicyCache: () => deps.policyResolver.invalidate(ctx.cwd),
    },
  );

  if (!apply.ok) {
    return packMutationApplyFailureReport({
      request,
      source: target.target.entry.source.kind,
      subject: target.target.subject,
      scope: target.target.scope,
      plan,
      apply,
    });
  }

  const refreshed = await resolvePolicyReport(ctx, deps);
  if (refreshed.ok) refreshOperatorStatus(ctx, deps, refreshed.policy);
  const effectivePack = refreshed.ok
    ? getAutoReviewerPack(refreshed.policy, packId)?.pack
    : undefined;
  const effectiveWarnings = stableUnique([
    ...apply.warnings,
    ...(refreshed.ok ? refreshed.policy.warnings : [refreshed.report.summary]),
  ]);
  const details: PackMutationSuccessDetails = {
    request: { ...request, packId },
    source: target.target.entry.source.kind,
    subject: target.target.subject,
    scope: target.target.scope,
    preview,
    apply,
    ...(effectivePack === undefined ? {} : { effectivePack }),
    effectiveWarnings,
  };

  return {
    title: "Pi Clearance pack enablement updated",
    summary: `${packId} ${request.action} planned for ${target.target.scope}; effective state ${formatEffectiveState(effectivePack)}.`,
    markdown: formatPackMutationSuccessMarkdown(details),
    details,
    level: effectiveWarnings.length === 0 ? "info" : "warning",
  };
}

export function getPackArgumentCompletions(
  completed: readonly string[],
  current: string,
  deps: AutoReviewerCommandDependencies,
): AutoReviewerAutocompleteItem[] | null {
  const pendingValueFlag = completed.at(-1);
  if (pendingValueFlag === "--source") {
    return filterCompletions(
      PACK_SOURCE_KINDS.map((source) => completion(source, "Pack source")),
      current,
    );
  }
  if (pendingValueFlag === "--tag") {
    return filterCompletions(tagCompletions(deps), current);
  }
  if (pendingValueFlag === "--effect") {
    return filterCompletions(effectCompletions(), current);
  }
  if (pendingValueFlag === "--search" || pendingValueFlag === "--query") {
    return null;
  }

  if (completed[0] === "show") {
    return completed.length === 1
      ? filterCompletions(packIdCompletions(deps), current)
      : null;
  }

  if (isPackCommandAction(completed[0])) {
    if (completed.length === 1) {
      return filterCompletions(packIdCompletions(deps), current);
    }
    if (completed.length === 2) {
      return filterCompletions(PACK_SCOPE_COMPLETIONS, current);
    }
    return null;
  }

  return filterCompletions(PACK_FILTER_COMPLETIONS, current);
}

function handlePackShowCommand(
  tokens: readonly string[],
  policy: ResolvedPolicy,
): CommandReport {
  if (tokens.length !== 1) {
    return usageReport("Expected `packs show <pack-id>`.");
  }

  const packId = tokens[0];
  if (packId === undefined || packId.length === 0) {
    return usageReport("Expected `packs show <pack-id>`.");
  }

  return buildPackDossierReport({ policy, packId });
}

/**
 * Read-only report builder shared by the CLI show path and future settings
 * drills. It deliberately consumes the pack explorer read model instead of
 * re-reading registry internals so Unit 3/5 surfaces can reuse the same dossier.
 */
export function buildPackDossierReport(input: {
  readonly policy: ResolvedPolicy;
  readonly packId: string;
}): CommandReport {
  const packId = input.packId.trim();
  const matches = input.policy.registry.entries.filter(
    (entry) => entry.id === packId,
  );
  const result = buildPackExplorerView(input.policy, packId);
  if (result === undefined) {
    const reason =
      matches.length > 1
        ? `Pack id "${packId}" is ambiguous across ${matches.length} registry entries.`
        : `Pack id "${packId}" was not found.`;
    const warnings = input.policy.registry.warnings.filter((warning) =>
      warning.includes(`"${packId}"`),
    );
    return {
      title: "Pack lookup failed",
      summary: reason,
      markdown: ["# Pack lookup failed", "", `- ${reason}`].join("\n"),
      details: { packId, reason, warnings },
      level: "error",
    };
  }

  return {
    title: `Policy dossier: ${result.pack.title}`,
    summary: `${result.pack.title} (${result.pack.id})`,
    markdown: formatPackDossierMarkdown(result.pack, result.warnings),
    details: result,
    level:
      result.warnings.length === 0 && result.pack.metadataComplete
        ? "info"
        : "warning",
  };
}

function parsePackMutationTokens(
  tokens: readonly string[],
):
  | { readonly ok: true; readonly request: PackMutationRequest }
  | { readonly ok: false; readonly reason: string } {
  const action = tokens[0];
  if (!isPackCommandAction(action)) {
    return {
      ok: false,
      reason: "Expected `packs enable` or `packs disable`.",
    };
  }

  const packId = tokens[1];
  if (packId === undefined || packId.length === 0 || packId.startsWith("--")) {
    return {
      ok: false,
      reason: `Expected a pack id after \`packs ${action}\`.`,
    };
  }

  let scope: PackEnablementScope | undefined;
  for (const token of tokens.slice(2)) {
    if (!(token in PACK_SCOPE_FLAGS)) {
      return {
        ok: false,
        reason: `Unknown packs ${action} argument: ${token}. Expected --global or --project.`,
      };
    }
    if (scope !== undefined) {
      return {
        ok: false,
        reason: "Use only one of `--global` or `--project`.",
      };
    }
    scope = PACK_SCOPE_FLAGS[token as keyof typeof PACK_SCOPE_FLAGS];
  }

  return {
    ok: true,
    request: {
      action,
      packId,
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

async function derivePackMutationTarget(input: {
  readonly request: PackMutationRequest;
  readonly ctx: ExtensionCommandContext;
  readonly policy: ResolvedPolicy;
}): Promise<
  | { readonly ok: true; readonly target: PackMutationTarget }
  | { readonly ok: false; readonly report: CommandReport }
> {
  const matches = input.policy.registry.entries.filter(
    (entry) => entry.id === input.request.packId,
  );

  if (matches.length === 0) {
    return {
      ok: false,
      report: packMutationRefusalReport({
        action: input.request.action,
        packId: input.request.packId,
        reason: `Pack id "${input.request.packId}" was not found.`,
        markdownLines: ["- No config changes were written."],
      }),
    };
  }

  if (matches.length > 1) {
    const warnings = input.policy.registry.warnings.filter((warning) =>
      warning.includes(`"${input.request.packId}"`),
    );
    return {
      ok: false,
      report: packMutationRefusalReport({
        action: input.request.action,
        packId: input.request.packId,
        reason: `Pack id "${input.request.packId}" is ambiguous across ${matches.length} registry entries.`,
        availabilityWarnings: warnings,
        markdownLines: [
          "- Resolve the duplicate pack id before changing enablement.",
          "- No config changes were written.",
        ],
      }),
    };
  }

  const entry = matches[0];
  if (entry === undefined) {
    throw new Error("unreachable unique pack match missing");
  }

  switch (entry.source.kind) {
    case "package": {
      const scope =
        input.request.scope ??
        (await selectPackagePackScope(input.ctx, input.request, entry));
      if (scope === undefined) {
        return {
          ok: false,
          report: packMutationRefusalReport({
            action: input.request.action,
            packId: input.request.packId,
            source: entry.source.kind,
            reason:
              "Package pack enablement needs a target scope. Re-run with `--global` or `--project`, or use an interactive Pi UI with selection support.",
            markdownLines: [
              "- Package-contributed packs are enabled by writing user-owned global or project config.",
              "- No config changes were written.",
            ],
          }),
        };
      }
      return {
        ok: true,
        target: { entry, scope, subject: "package" },
      };
    }
    case "user-global":
      return configPackTarget(input.request, entry, "global");
    case "user-project":
      return configPackTarget(input.request, entry, "project");
    case "shipped":
      return {
        ok: false,
        report: packMutationRefusalReport({
          action: input.request.action,
          packId: input.request.packId,
          source: entry.source.kind,
          reason:
            "Shipped baseline packs are built in, not direct pack enablement. They cannot be toggled.",
          markdownLines: [
            "- Shipped baseline packs are always active and cannot be toggled through `packs enable|disable`.",
            "- The sealed floor and baseline membership are not user-editable.",
            "- Add your own rules in user config instead.",
            "- No config changes were written.",
          ],
        }),
      };
    case "trusted-repo":
      return {
        ok: false,
        report: packMutationRefusalReport({
          action: input.request.action,
          packId: input.request.packId,
          source: entry.source.kind,
          reason:
            "Repository policy packs are governed by the Pi project-trust and composition boundary, not user pack enablement. Adjust the repository policy or Pi project trust instead.",
          markdownLines: [
            "- Repository packs are project-owned policy and remain tighten-only unless the repository is explicitly trusted.",
            "- User-owned `disabledConfigPacks` does not apply to repository policy packs.",
            "- No config changes were written.",
          ],
        }),
      };
  }
}

function configPackTarget(
  request: PackMutationRequest,
  entry: PackRegistryEntry,
  inferredScope: PackEnablementScope,
):
  | { readonly ok: true; readonly target: PackMutationTarget }
  | { readonly ok: false; readonly report: CommandReport } {
  if (request.scope !== undefined && request.scope !== inferredScope) {
    return {
      ok: false,
      report: packMutationRefusalReport({
        action: request.action,
        packId: request.packId,
        source: entry.source.kind,
        reason: `Config pack "${request.packId}" is owned by ${inferredScope} config; remove the conflicting --${request.scope} flag or use --${inferredScope}.`,
        markdownLines: [
          "- User-authored config-pack scope is inferred from the pack's registry source.",
          "- No config changes were written.",
        ],
      }),
    };
  }

  return {
    ok: true,
    target: { entry, scope: inferredScope, subject: "config-pack" },
  };
}

type UiSelect = (
  title: string,
  options: string[],
  opts?: unknown,
) => Promise<string | undefined> | string | undefined;

interface SelectCapableCommandContext {
  readonly hasUI?: boolean;
  readonly ui?: {
    readonly select?: UiSelect;
  };
}

async function selectPackagePackScope(
  ctx: ExtensionCommandContext,
  request: PackMutationRequest,
  entry: PackRegistryEntry,
): Promise<PackEnablementScope | undefined> {
  const maybeContext = ctx as ExtensionCommandContext &
    SelectCapableCommandContext;
  const select = maybeContext.ui?.select;
  if (maybeContext.hasUI !== true || typeof select !== "function") {
    return undefined;
  }

  try {
    const selection = await select.call(
      maybeContext.ui,
      `Choose ${request.action} scope for ${entry.id}`,
      ["global", "project"],
    );
    return isPackScope(selection) ? selection : undefined;
  } catch {
    return undefined;
  }
}

async function confirmPackEnablementPlan(
  ctx: ExtensionCommandContext,
  plan: PackEnablementPlan,
  preview: PackEnablementCommandPreviewReport,
): Promise<boolean> {
  try {
    return await ctx.ui.confirm(
      packConfirmationTitle(plan),
      formatPackConfirmationMarkdown(plan, preview),
    );
  } catch {
    return false;
  }
}

function acknowledgementForPlan(plan: PackEnablementPlan) {
  return {
    confirmedPlanId: plan.id,
    acknowledgedWarningCodes: plan.requiredAcknowledgementCodes,
  };
}

function packMutationApplyFailureReport(input: {
  readonly request: PackMutationRequest;
  readonly source: PackSourceKind;
  readonly subject: PackEnablementSubject;
  readonly scope: PackEnablementScope;
  readonly plan: PackEnablementPlan;
  readonly apply: Extract<
    PackEnablementCommandApplyResult,
    { readonly ok: false }
  >;
}): CommandReport {
  return {
    title: "Pack enablement failed",
    summary: input.apply.reason,
    markdown: [
      "# Pack enablement failed",
      "",
      `- Pack: \`${input.request.packId}\``,
      `- Action: ${input.request.action}`,
      `- Source: ${input.source}`,
      `- Subject: ${input.subject}`,
      `- Scope: ${input.scope}`,
      `- Target file: \`${input.plan.targetPath}\``,
      `- Reason: ${input.apply.reason}`,
      `- Wrote before failure: ${input.apply.wrote ? "yes" : "no"}`,
      `- Restored previous file: ${input.apply.restored ? "yes" : "no"}`,
      "",
      "## Errors",
      ...input.apply.errors.map((error) => `- ${error}`),
    ].join("\n"),
    details: input,
    level: "error",
  };
}

function packMutationRefusalReport(input: {
  readonly action: PackEnablementAction;
  readonly packId: string;
  readonly reason: string;
  readonly source?: PackSourceKind;
  readonly subject?: PackEnablementSubject;
  readonly scope?: PackEnablementScope;
  readonly warnings?: readonly PackEnablementWarning[];
  readonly availabilityWarnings?: readonly string[];
  readonly markdownLines?: readonly string[];
}): CommandReport {
  const warnings = stableUnique([
    ...(input.availabilityWarnings ?? []),
    ...(input.warnings ?? []).map((warning) => warning.message),
  ]);
  const lines = [
    "# Pack enablement refused",
    "",
    `- Pack: ${input.packId.length === 0 ? "(missing)" : `\`${input.packId}\``}`,
    `- Action: ${input.action}`,
    ...(input.source === undefined ? [] : [`- Source: ${input.source}`]),
    ...(input.subject === undefined ? [] : [`- Subject: ${input.subject}`]),
    ...(input.scope === undefined ? [] : [`- Scope: ${input.scope}`]),
    `- Reason: ${input.reason}`,
    ...(input.markdownLines ?? []),
  ];

  if (warnings.length > 0) {
    lines.push("", "## Warnings", ...warnings.map((warning) => `- ${warning}`));
  }

  return {
    title: "Pack enablement refused",
    summary: input.reason,
    markdown: lines.join("\n"),
    details: {
      request: { action: input.action, packId: input.packId },
      reason: input.reason,
      source: input.source,
      subject: input.subject,
      scope: input.scope,
      warnings,
    },
    level: "error",
  };
}

function parsePackListFilters(tokens: readonly string[]):
  | {
      readonly ok: true;
      readonly filter: PackRegistryFilter;
      readonly explorerFilter: PackExplorerFilter;
      readonly idsPrimary: boolean;
      readonly verbose: boolean;
    }
  | { readonly ok: false; readonly reason: string } {
  const filter: {
    source?: PackSourceKind;
    enabled?: boolean;
    tag?: string;
  } = {};
  const explorerFilter: {
    effect?: PackEffectSummary;
    search?: string;
  } = {};
  let idsPrimary = false;
  let verbose = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    switch (token) {
      case "--enabled":
        if (filter.enabled === false) {
          return {
            ok: false,
            reason: "Use only one of `--enabled` or `--disabled`.",
          };
        }
        filter.enabled = true;
        break;
      case "--disabled":
        if (filter.enabled === true) {
          return {
            ok: false,
            reason: "Use only one of `--enabled` or `--disabled`.",
          };
        }
        filter.enabled = false;
        break;
      case "--source": {
        const source = tokens[index + 1];
        if (source === undefined || source.startsWith("--")) {
          return { ok: false, reason: "Expected a source after `--source`." };
        }
        if (!isPackSourceKind(source)) {
          return {
            ok: false,
            reason: `Unknown source "${source}". Expected one of: ${PACK_SOURCE_KINDS.join(", ")}.`,
          };
        }
        filter.source = source;
        index += 1;
        break;
      }
      case "--tag": {
        const tag = tokens[index + 1];
        if (tag === undefined || tag.startsWith("--")) {
          return { ok: false, reason: "Expected a tag after `--tag`." };
        }
        filter.tag = tag;
        index += 1;
        break;
      }
      case "--effect": {
        const effect = tokens[index + 1];
        if (effect === undefined || effect.startsWith("--")) {
          return { ok: false, reason: "Expected an effect after `--effect`." };
        }
        const normalized = normalizeEffectFilterToken(effect);
        if (normalized === undefined) {
          return {
            ok: false,
            reason: `Unknown effect "${effect}". Expected one of: ${PACK_EFFECT_SUMMARIES.join(", ")}, review.`,
          };
        }
        explorerFilter.effect = normalized;
        index += 1;
        break;
      }
      case "--search":
      case "--query": {
        const search = tokens[index + 1];
        if (search === undefined || search.startsWith("--")) {
          return { ok: false, reason: `Expected text after \`${token}\`.` };
        }
        explorerFilter.search = search;
        index += 1;
        break;
      }
      case "--ids":
        idsPrimary = true;
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--": {
        const search = tokens
          .slice(index + 1)
          .join(" ")
          .trim();
        if (search.length === 0) {
          return { ok: false, reason: "Expected search text after `--`." };
        }
        explorerFilter.search = search;
        index = tokens.length;
        break;
      }
      default:
        return {
          ok: false,
          reason: `Unknown packs argument: ${token}.`,
        };
    }
  }

  return { ok: true, filter, explorerFilter, idsPrimary, verbose };
}

function effectCompletions(): AutoReviewerAutocompleteItem[] {
  return [
    ...PACK_EFFECT_SUMMARIES.map((effect) => completion(effect, "Pack effect")),
    completion("review", "Alias for review-gate"),
  ];
}

function normalizeEffectFilterToken(
  value: string,
): PackEffectSummary | undefined {
  if (value === "review") {
    return "review-gate";
  }
  return isPackEffectSummary(value) ? value : undefined;
}

function isPackEffectSummary(value: string): value is PackEffectSummary {
  return (PACK_EFFECT_SUMMARIES as readonly string[]).includes(value);
}

function packIdCompletions(
  deps: AutoReviewerCommandDependencies,
): AutoReviewerAutocompleteItem[] {
  return stableUnique([
    ...SHIPPED_PACK_DEFINITIONS.map((definition) => definition.pack.id),
    ...safePackageRegistration(deps).packs.map((pack) => pack.pack.id),
  ]).map((id) => completion(id, "Policy pack id"));
}

function tagCompletions(
  deps: AutoReviewerCommandDependencies,
): AutoReviewerAutocompleteItem[] {
  return stableUnique([
    ...SHIPPED_PACK_DEFINITIONS.flatMap(
      (definition) => definition.metadata.tags ?? [],
    ),
    ...safePackageRegistration(deps).packs.flatMap(
      (pack) => pack.pack.metadata?.tags ?? [],
    ),
  ]).map((tag) => completion(tag, "Pack tag"));
}

function safePackageRegistration(
  deps: AutoReviewerCommandDependencies,
): PackageRegistrationSnapshot {
  try {
    return deps.packageRegistration();
  } catch {
    return {
      requestId: null,
      packs: [],
      issues: [],
    };
  }
}

function isPackCommandAction(
  value: string | undefined,
): value is PackCommandAction {
  return PACK_MUTATION_ACTIONS.some((action) => action === value);
}

function isPackScope(value: string | undefined): value is PackEnablementScope {
  return value === "global" || value === "project";
}

function isPackSourceKind(value: string): value is PackSourceKind {
  return (PACK_SOURCE_KINDS as readonly string[]).includes(value);
}

export function formatPackListMarkdown(
  details: DefaultPackListingDetails,
): string {
  const lines = [
    "# Policy dossiers",
    "",
    `- Packs listed: ${details.packs.length}`,
    `- Filters: ${formatFilterSummary(details.filter, details.explorerFilter)}`,
    `- Warnings: ${details.warnings.length}`,
  ];

  if (details.verbose) {
    if (details.packs.length === 0) {
      return lines.join("\n");
    }
    return [
      ...lines,
      "",
      ...details.packs.flatMap((pack, index) => [
        ...(index === 0 ? [] : ["", "---", ""]),
        formatPackDossierMarkdown(pack, details.warnings),
      ]),
    ].join("\n");
  }

  if (details.packs.length > 0) {
    lines.push("", "| State | Name | Scope | Risk |", "|---|---|---|---|");
    for (const pack of details.packs) {
      lines.push(
        `| ${escapeCell(formatPackExplorerState(pack))} | ${formatPackExplorerNameCell(pack, details.idsPrimary)} | ${escapeCell(formatPackExplorerScope(pack))} | ${escapeCell(pack.effectSummary)} |`,
      );
    }
  }

  return lines.join("\n");
}

function formatPackExplorerState(pack: AutoReviewerPackExplorerView): string {
  switch (pack.availabilityState) {
    case "sealed-floor":
      return "Always";
    case "baseline-included":
    case "enabled-global":
    case "enabled-project":
      return "On";
    case "disabled-global":
    case "disabled-project":
      return "Disabled";
    case "available":
      return "Available";
    case "missing":
      return "Missing";
    case "ambiguous":
      return "Ambiguous";
    case "unavailable":
      return "Unavailable";
  }
}

function formatPackExplorerNameCell(
  pack: AutoReviewerPackExplorerView,
  idsPrimary: boolean,
): string {
  const primary = idsPrimary
    ? `\`${escapeCell(pack.id)}\``
    : escapeCell(pack.title);
  const secondary = idsPrimary
    ? escapeCell(pack.title)
    : `\`${escapeCell(pack.id)}\``;
  return `${primary} — ${secondary}`;
}

function formatPackExplorerScope(pack: AutoReviewerPackExplorerView): string {
  if (pack.availabilityState === "sealed-floor") {
    return "sealed floor";
  }
  if (pack.inBaseline) {
    return "baseline";
  }
  switch (pack.availabilityState) {
    case "enabled-global":
      return "global config";
    case "enabled-project":
      return "project config";
    case "disabled-global":
      return "disabled globally";
    case "disabled-project":
      return "disabled by project";
    case "missing":
    case "ambiguous":
    case "unavailable":
      return "package config";
    case "available":
      return pack.source === "package" ? "package pack" : pack.source;
    case "baseline-included":
      return "baseline";
  }
}

export function formatPackDossierMarkdown(
  pack: AutoReviewerPackExplorerView,
  warnings: readonly string[] = [],
): string {
  const lines = [
    `# ${pack.title}`,
    "",
    pack.description,
    "",
    "## Summary",
    `- Technical id: \`${pack.id}\``,
    `- Source: ${formatSourceKind(pack)}`,
    ...formatPackageProvenanceLines(pack),
    `- Availability: ${formatAvailabilityState(pack)}`,
    `- Enabled by: ${formatEnabledByHumanCopy(pack)}`,
    `- Baseline: ${pack.inBaseline ? "included" : "not included"}`,
    `- Effect: ${pack.effectSummary} — ${pack.effectCopy}`,
    ...(pack.activationNote.length === 0
      ? []
      : [`- Activation: ${pack.activationNote}`]),
    `- Rule count: ${pack.ruleCount}`,
    `- Tags: ${formatInlineList(pack.tags)}`,
  ];

  if (pack.source === "shipped" && pack.inBaseline) {
    lines.push(
      "- Baseline note: this shipped pack is active by default; mode changes only review dispatch.",
    );
  }

  if (!pack.metadataComplete) {
    lines.push(
      "",
      "## Missing explorer metadata",
      "- Severity: warning",
      `- Missing fields: ${formatMissingMetadataFields(pack)}`,
    );
  }

  lines.push("", "## What it does", "", pack.description);

  lines.push("", "## Examples");
  if (pack.examples.length === 0) {
    lines.push("", "No examples provided for this pack.");
  } else {
    lines.push(
      "",
      ...pack.examples.map(
        (example) =>
          `- ${exampleMarker(example.outcome)} ${example.shape}${
            example.note === undefined ? "" : ` — ${example.note}`
          }`,
      ),
    );
  }

  if (pack.docs.length > 0) {
    lines.push(
      "",
      "## Docs",
      ...pack.docs.map(
        (doc) => `- [${doc.label}](${resolvePackDocHref(pack, doc.href)})`,
      ),
    );
  }

  if (pack.warnings.length > 0) {
    lines.push(
      "",
      "## Pack warnings",
      ...pack.warnings.map(
        (warning) => `- ${warning.level}: ${warning.message}`,
      ),
    );
  }

  if (warnings.length > 0) {
    lines.push(
      "",
      "## Registry warnings",
      ...warnings.map((warning) => `- ${warning}`),
    );
  }

  return lines.join("\n");
}

function formatSourceKind(pack: AutoReviewerPackExplorerView): string {
  return pack.synthetic ? `${pack.source} (synthetic)` : pack.source;
}

function formatPackageProvenanceLines(
  pack: AutoReviewerPackExplorerView,
): readonly string[] {
  const provenance = pack.packageProvenance;
  if (provenance === undefined) {
    return [];
  }

  const lines = [
    `- Package: ${formatPackageName(provenance.name, provenance.version)}`,
  ];
  if (provenance.installKind !== undefined) {
    lines.push(`- Package install: ${provenance.installKind}`);
  }
  if (provenance.sourceSpec !== undefined) {
    lines.push(`- Package source: ${provenance.sourceSpec}`);
  }
  if (provenance.packagePath !== undefined) {
    lines.push(`- Package path: \`${provenance.packagePath}\``);
  }
  if (provenance.entrypointPath !== undefined) {
    lines.push(`- Package entrypoint: \`${provenance.entrypointPath}\``);
  }
  return lines;
}

function formatPackageName(
  name: string | undefined,
  version: string | undefined,
): string {
  if (name === undefined) {
    return version === undefined ? "unknown package" : `unknown@${version}`;
  }
  return version === undefined ? name : `${name}@${version}`;
}

function formatAvailabilityState(pack: AutoReviewerPackExplorerView): string {
  switch (pack.availabilityState) {
    case "sealed-floor":
      return "Always on (sealed floor)";
    case "baseline-included":
      return "On via built-in baseline";
    case "enabled-global":
      return "On from global config";
    case "enabled-project":
      return "On from project config";
    case "available":
      return "Available — not enabled";
    case "disabled-global":
      return "Disabled by global config";
    case "disabled-project":
      return "Disabled by project config";
    case "missing":
      return "Missing enabled package pack";
    case "ambiguous":
      return "Ambiguous enabled package pack";
    case "unavailable":
      return "Package registry unavailable";
  }
}

export function formatEnabledByHumanCopy(
  pack: AutoReviewerPackExplorerView,
): string {
  if (pack.enabledBy.length === 0) {
    if (pack.availabilityState === "disabled-global") {
      return "Disabled by global config";
    }
    if (pack.availabilityState === "disabled-project") {
      return "Disabled by project config";
    }
    return "Available — not enabled";
  }

  return pack.enabledBy.map(formatPackEnablementHumanCopy).join(", ");
}

function formatPackEnablementHumanCopy(
  enablement: AutoReviewerPackView["enabledBy"][number],
): string {
  switch (enablement.kind) {
    case "sealed-floor":
      return "Always on (sealed floor)";
    case "baseline":
      return "On (built-in baseline)";
    case "global-config":
      return "On (global config)";
    case "project-config":
      return "On (project config)";
    case "repo-policy":
      return "On (repository policy)";
    case "package-config":
      return "On (enabled package)";
  }
}

function formatMissingMetadataFields(
  pack: AutoReviewerPackExplorerView,
): string {
  const missing = [...pack.metadataCompleteness.missingFields];
  if (
    pack.effectSummary === "deny-floor" &&
    !pack.examples.some((example) => example.outcome === "deny") &&
    !missing.includes("examples")
  ) {
    missing.push("examples");
  }
  return missing.length === 0 ? "unknown metadata gap" : missing.join(", ");
}

function exampleMarker(
  outcome: AutoReviewerPackExplorerView["examples"][number]["outcome"],
): string {
  switch (outcome) {
    case "allow":
      return "✓";
    case "review":
      return "?";
    case "deny":
      return "✗";
  }
}

function resolvePackDocHref(
  pack: AutoReviewerPackExplorerView,
  href: string,
): string {
  if (pack.source !== "package" || isHttpUrl(href) || path.isAbsolute(href)) {
    return href;
  }

  const root = packageDocsRoot(pack);
  if (root === undefined) {
    return href;
  }
  return path.resolve(root, href);
}

function packageDocsRoot(
  pack: AutoReviewerPackExplorerView,
): string | undefined {
  const provenance = pack.packageProvenance;
  if (provenance === undefined) {
    return undefined;
  }
  if (provenance.packagePath !== undefined) {
    return provenance.packagePath;
  }
  if (provenance.entrypointPath !== undefined) {
    return path.dirname(provenance.entrypointPath);
  }
  return undefined;
}

function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function formatPackConfirmationMarkdown(
  plan: PackEnablementPlan,
  preview: PackEnablementCommandPreviewReport,
): string {
  const lines = [
    `${capitalize(plan.request.action)} \`${plan.request.packId}\` as ${plan.request.subject} in ${plan.request.scope} config.`,
    "",
    `Target file: ${plan.targetPath}`,
    "",
    "## Patch summary",
    ...formatPatchLines(plan.patch),
    "",
    "## Availability and validation",
    ...formatAvailabilityLines(preview),
    "",
    "## Current state",
    `- Enabled in target scope: ${yesNo(preview.current.enabledInScope)}`,
    `- Disabled in target scope: ${yesNo(preview.current.disabledInScope)}`,
    `- Effectively enabled package: ${yesNo(preview.current.effectivelyEnabledPackage)}`,
    `- Disabled config pack: ${yesNo(preview.current.disabledConfigPack)}`,
  ];

  const warnings = stableUnique([
    ...preview.availabilityReport.warnings,
    ...plan.warnings.map(formatPackEnablementWarning),
  ]);
  if (warnings.length > 0) {
    lines.push("", "## Warnings", ...warnings.map((warning) => `- ${warning}`));
  }

  lines.push(
    "",
    "## Required acknowledgements",
    ...formatAcknowledgementLines(plan.requiredAcknowledgementCodes),
    "",
    "Confirm to write this user-owned pack enablement change.",
  );

  return lines.join("\n");
}

function formatPackMutationSuccessMarkdown(
  details: PackMutationSuccessDetails,
): string {
  const lines = [
    "# Pi Clearance pack enablement updated",
    "",
    `- Pack: \`${details.request.packId}\``,
    `- Action: ${details.request.action}`,
    `- Source: ${details.source}`,
    `- Subject: ${details.subject}`,
    `- Scope: ${details.scope}`,
    `- Target file: \`${details.preview.result.ok ? details.preview.result.plan.targetPath : "unknown"}\``,
    `- Changed: ${details.apply.ok && details.apply.changed ? "yes" : "no"}`,
    `- Cache invalidated: ${details.apply.cacheInvalidated ? "yes" : "no"}`,
    `- Effective state: ${formatEffectiveState(details.effectivePack)}`,
  ];

  if (details.apply.ok && details.apply.backupPath !== undefined) {
    lines.push(`- Backup: \`${details.apply.backupPath}\``);
  }

  if (details.effectivePack !== undefined) {
    lines.push(
      `- Effective enabled by: ${formatEnabledBy(details.effectivePack)}`,
    );
  }

  if (details.effectiveWarnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      ...details.effectiveWarnings.map((warning) => `- ${warning}`),
    );
  }

  return lines.join("\n");
}

function formatAvailabilityLines(
  preview: PackEnablementCommandPreviewReport,
): readonly string[] {
  const candidate = preview.candidate;
  if (candidate === undefined) {
    return ["- Candidate: not uniquely available in validation report."];
  }

  const validation = candidate.validation;
  const lines = [
    `- Candidate: \`${candidate.candidateId}\``,
    `- Registry source: ${candidate.registryEntry?.source.kind ?? validation.source.kind}`,
    `- Validation kind: ${validation.kind}`,
    `- Can enable: ${yesNo(validation.canEnable)}`,
    `- Can affect policy: ${yesNo(validation.canAffectPolicy)}`,
    `- Validation issues: ${validation.issues.length}`,
  ];

  if (candidate.replayImpact !== undefined) {
    lines.push(
      `- Replay impact: ${candidate.replayImpact.status}; changed calls ${candidate.replayImpact.changedCalls}; review→allow ${candidate.replayImpact.reviewToAllow}`,
    );
  } else {
    lines.push("- Replay impact: not provided for this command flow.");
  }

  for (const issue of validation.issues) {
    lines.push(`  - ${issue.severity} ${issue.code}: ${issue.message}`);
  }

  return lines;
}

function formatAcknowledgementLines(
  codes: readonly string[],
): readonly string[] {
  if (codes.length === 0) {
    return ["- None."];
  }

  return codes.map((code) => `- ${code}`);
}

function formatPatchLines(
  patch: readonly JsonPatchOperation[],
): readonly string[] {
  if (patch.length === 0) {
    return ["- No-op: target enablement already has the requested value."];
  }

  return patch.map((operation) => {
    const before =
      "before" in operation ? ` from ${formatJson(operation.before)}` : "";
    const value =
      "value" in operation ? ` to ${formatJson(operation.value)}` : "";
    return `- ${operation.op} ${operation.path}${before}${value}`;
  });
}

function formatPackEnablementWarning(warning: PackEnablementWarning): string {
  const acknowledgement = warning.requiresAcknowledgement
    ? " (requires acknowledgement)"
    : "";
  return `${warning.level} ${warning.code}: ${warning.message}${acknowledgement}`;
}

function formatEffectiveState(pack: AutoReviewerPackView | undefined): string {
  if (pack === undefined) {
    return "unknown after recomposition";
  }

  return pack.enabled ? "enabled" : "disabled";
}

function formatFilterSummary(
  filter: PackRegistryFilter,
  explorerFilter: PackExplorerFilter,
): string {
  const parts: string[] = [];
  if (filter.source !== undefined) {
    parts.push(`source=${filter.source}`);
  }
  if (filter.enabled !== undefined) {
    parts.push(`enabled=${filter.enabled}`);
  }
  if (filter.tag !== undefined) {
    parts.push(`tag=${filter.tag}`);
  }
  if (explorerFilter.effect !== undefined) {
    parts.push(`effect=${explorerFilter.effect}`);
  }
  if (explorerFilter.search !== undefined) {
    parts.push(`search=${explorerFilter.search}`);
  }
  if (parts.length === 0) {
    return "none";
  }
  return parts.join(", ");
}

function formatEnabledBy(pack: AutoReviewerPackView): string {
  if (pack.enabledBy.length === 0) {
    return "none";
  }

  return pack.enabledBy.map((enablement) => enablement.kind).join(", ");
}

function formatInlineList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function packConfirmationTitle(plan: PackEnablementPlan): string {
  return `${capitalize(plan.request.action)} Pi Clearance pack?`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function formatJson(value: unknown): string {
  return `\`${JSON.stringify(value)}\``;
}
