import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  inferScopePreset,
  type ProjectScopeListField,
  planProjectScopeCommandChange,
  SCOPE_PRESET_LABELS,
  type ScopeCommandChange,
  type ScopePreset,
} from "../../config/config-command-plans.ts";
import {
  applyConfigCommandPlan,
  type ConfigCommandApplyResult,
  type ConfigCommandPlan,
} from "../../config/config-command-writer.ts";
import type {
  ConfigError,
  ConfigWarning,
  ResolvedConfig,
  ResolvedProjectScope,
} from "../../config/loader.ts";
import type { ProjectScopeConfig } from "../../config/schema.ts";
import type { JsonPatchOperation } from "../../replay/proposal-schema.ts";
import { createConfigCommandWriterDependencies } from "./post-write-validation.ts";
import {
  type AutoReviewerAutocompleteItem,
  type AutoReviewerCommandDependencies,
  type CommandReport,
  completion,
  filterCompletions,
  resolvePolicyReport,
  stableUnique,
  usageReport,
} from "./types.ts";

const SCOPE_LIST_FIELDS = {
  roots: "roots",
  writable: "writableDirectories",
  temp: "tempDirectories",
  denied: "deniedDirectories",
  "safe-home": "safeHomeDirectories",
  "agent-support": "agentSupportDirectories",
} as const satisfies Record<string, ProjectScopeListField>;

const SCOPE_TOP_LEVEL_COMPLETIONS = [
  completion("roots", "Add or remove configured project roots"),
  completion("writable", "Add or remove writable project directories"),
  completion("temp", "Add or remove configured temp directories"),
  completion("denied", "Add or remove denied directories"),
  completion("safe-home", "Add or remove safe-home directories"),
  completion("agent-support", "Add or remove Pi agent-support directories"),
  completion(
    "safe-home-defaults",
    "Enable or disable implicit safe-home defaults",
  ),
  completion(
    "agent-support-defaults",
    "Enable or disable implicit Pi agent-support defaults",
  ),
  completion("unknown-path", "Set unknown path behavior"),
  completion("preset", "Apply a named scope preset bundle"),
] as const;

const SCOPE_PRESET_COMPLETIONS = [
  completion("project", SCOPE_PRESET_LABELS.project),
  completion("home", SCOPE_PRESET_LABELS.home),
  completion("unrestricted", SCOPE_PRESET_LABELS.unrestricted),
] as const;

const SCOPE_ACTION_COMPLETIONS = [
  completion("add", "Add a raw configured path"),
  completion("remove", "Remove a raw configured path"),
] as const;

const UNKNOWN_PATH_BEHAVIOR_COMPLETIONS = [
  completion("review", "Review dynamic or ambiguous paths"),
  completion("deny", "Deny dynamic or ambiguous paths when policy consumes it"),
] as const;

const SAFE_HOME_DEFAULTS_COMPLETIONS = [
  completion("on", "Use implicit dev-oriented safe-home defaults"),
  completion("off", "Use only explicitly configured safe-home directories"),
] as const;

const AGENT_SUPPORT_DEFAULTS_COMPLETIONS = [
  completion("on", "Use built-in Pi support roots"),
  completion("off", "Use only explicitly configured agent-support roots"),
] as const;

const EMPTY_PROJECT_SCOPE: ProjectScopeConfig = {
  roots: [],
  writableDirectories: [],
  tempDirectories: [],
  deniedDirectories: [],
  safeHomeDirectories: [],
  safeHomeUseDefaults: true,
  agentSupportDirectories: [],
  agentSupportUseDefaults: true,
  unknownPathBehavior: "review",
  sensitivePathBehavior: "review",
  homePathBehavior: "allow",
};

interface ScopeStatusDetails {
  readonly raw: ProjectScopeConfig;
  readonly resolved: ResolvedProjectScope;
  readonly implicit: {
    readonly cwdRoot: string;
    readonly cwdWritable: string;
    readonly osTemp: string;
    readonly homeDirectory?: string;
  };
  readonly projectOverlayPath?: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface ScopeMutationSuccessDetails {
  readonly change: ScopeCommandChange;
  readonly plan: ConfigCommandPlan;
  readonly apply: Extract<ConfigCommandApplyResult, { readonly ok: true }>;
  readonly resolvedAfter: ResolvedProjectScope;
  readonly status?: ScopeStatusDetails;
  readonly warnings: readonly string[];
}

export async function handleScopeCommand(
  tokens: readonly string[],
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  if (tokens.length === 0) {
    return await handleScopeStatus(ctx, deps);
  }

  const parsed = parseScopeMutation(tokens);
  if (!parsed.ok) {
    return usageReport(parsed.reason);
  }

  if (!ctx.hasUI) {
    return scopeRefusalReport({
      title: "Project scope change requires UI",
      reason:
        "Project scope changes require interactive Pi UI confirmation; no config changes were written.",
      markdownLines: [
        "- Mutating `/clearance scope` commands require Pi UI confirmation.",
        "- No config changes were written.",
      ],
      change: parsed.change,
    });
  }

  const policy = await resolvePolicyReport(ctx, deps);
  if (!policy.ok) {
    return policy.report;
  }

  const planned = planProjectScopeCommandChange({
    change: parsed.change,
    resolvedConfig: policy.policy.config,
    cwd: ctx.cwd,
  });
  if (!planned.ok) {
    return scopeRefusalReport({
      title: "Project scope change refused",
      reason: planned.reason,
      markdownLines: ["- No config changes were written."],
      change: parsed.change,
    });
  }

  const confirmed = await confirmScopePlan(
    ctx,
    planned.plan,
    planned.resolvedAfter,
  );
  if (!confirmed) {
    return {
      title: "Project scope change cancelled",
      summary:
        "The project scope change was not confirmed; no config changes were written.",
      markdown: [
        "# Project scope change cancelled",
        "",
        `- Target file: \`${planned.plan.target.path}\``,
        "- The confirmation prompt was declined or dismissed.",
        "- No config changes were written.",
      ].join("\n"),
      details: { change: parsed.change, plan: planned.plan },
      level: "warning",
    };
  }

  const apply = await applyConfigCommandPlan(
    planned.plan,
    {
      confirmedPlanId: planned.plan.id,
      acknowledgedWarningCodes: planned.plan.requiredAcknowledgementCodes,
    },
    createConfigCommandWriterDependencies(ctx, deps),
  );

  if (!apply.ok) {
    return scopeApplyFailureReport(parsed.change, planned.plan, apply);
  }

  if (apply.changed) {
    deps.policyResolver.invalidate(ctx.cwd);
  }

  const refreshed = await resolvePolicyReport(ctx, deps);
  const status = refreshed.ok
    ? scopeStatusFromConfig(refreshed.policy.config)
    : undefined;
  const warnings = stableUnique([
    ...planned.plan.warnings.map((warning) => warning.message),
    ...apply.warnings,
    ...(status?.warnings ?? []),
    ...(status?.errors ?? []),
    ...(refreshed.ok ? [] : [refreshed.report.summary]),
  ]);
  const details: ScopeMutationSuccessDetails = {
    change: parsed.change,
    plan: planned.plan,
    apply,
    resolvedAfter: planned.resolvedAfter,
    ...(status === undefined ? {} : { status }),
    warnings,
  };

  return {
    title: "Pi Clearance project scope updated",
    summary: `${planned.plan.title}; changed ${apply.changed ? "yes" : "no"}.`,
    markdown: formatScopeMutationSuccessMarkdown(details),
    details,
    level: warnings.length === 0 ? "info" : "warning",
  };
}

export function getScopeArgumentCompletions(
  completed: readonly string[],
  current: string,
): AutoReviewerAutocompleteItem[] | null {
  if (completed.length === 0) {
    return filterCompletions(SCOPE_TOP_LEVEL_COMPLETIONS, current);
  }

  if (completed[0] === "preset") {
    return completed.length === 1
      ? filterCompletions(SCOPE_PRESET_COMPLETIONS, current)
      : null;
  }

  if (completed[0] === "unknown-path") {
    return completed.length === 1
      ? filterCompletions(UNKNOWN_PATH_BEHAVIOR_COMPLETIONS, current)
      : null;
  }

  if (completed[0] === "safe-home-defaults") {
    return completed.length === 1
      ? filterCompletions(SAFE_HOME_DEFAULTS_COMPLETIONS, current)
      : null;
  }

  if (completed[0] === "agent-support-defaults") {
    return completed.length === 1
      ? filterCompletions(AGENT_SUPPORT_DEFAULTS_COMPLETIONS, current)
      : null;
  }

  if (isScopeFieldCommand(completed[0])) {
    return completed.length === 1
      ? filterCompletions(SCOPE_ACTION_COMPLETIONS, current)
      : null;
  }

  return null;
}

async function handleScopeStatus(
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  const policy = await resolvePolicyReport(ctx, deps);
  if (!policy.ok) {
    return policy.report;
  }

  const details = scopeStatusFromConfig(policy.policy.config);
  return {
    title: "Pi Clearance project scope",
    summary: `Project scope has ${details.raw.roots.length} configured root(s), ${details.raw.writableDirectories.length} configured writable path(s), and unknown paths ${details.raw.unknownPathBehavior}.`,
    markdown: formatScopeStatusMarkdown(details),
    details,
    level: details.errors.length === 0 ? "info" : "error",
  };
}

function parseScopeMutation(
  tokens: readonly string[],
):
  | { readonly ok: true; readonly change: ScopeCommandChange }
  | { readonly ok: false; readonly reason: string } {
  const command = tokens[0];
  if (command === "preset") {
    if (tokens.length !== 2) {
      return {
        ok: false,
        reason: "Expected `scope preset <project|home|unrestricted>`.",
      };
    }
    const preset = tokens[1];
    if (
      preset !== "project" &&
      preset !== "home" &&
      preset !== "unrestricted"
    ) {
      return {
        ok: false,
        reason: "Expected scope preset: project, home, or unrestricted.",
      };
    }
    return { ok: true, change: { kind: "preset", preset } };
  }

  if (command === "unknown-path") {
    if (tokens.length !== 2) {
      return {
        ok: false,
        reason: "Expected `scope unknown-path <review|deny>`.",
      };
    }
    const behavior = tokens[1];
    if (behavior !== "review" && behavior !== "deny") {
      return {
        ok: false,
        reason:
          behavior === "allow"
            ? "`scope unknown-path` accepts only `review` or `deny`; `allow` is intentionally unsupported."
            : "Expected unknown path behavior: review or deny.",
      };
    }
    return {
      ok: true,
      change: { kind: "unknown-path-behavior", behavior },
    };
  }

  if (command === "safe-home-defaults") {
    if (tokens.length !== 2) {
      return {
        ok: false,
        reason: "Expected `scope safe-home-defaults <on|off>`.",
      };
    }
    const enabled = parseOnOff(tokens[1]);
    if (enabled === undefined) {
      return {
        ok: false,
        reason: "Expected safe-home-defaults value: on or off.",
      };
    }
    return {
      ok: true,
      change: { kind: "safe-home-defaults", enabled },
    };
  }

  if (command === "agent-support-defaults") {
    if (tokens.length !== 2) {
      return {
        ok: false,
        reason: "Expected `scope agent-support-defaults <on|off>`.",
      };
    }
    const enabled = parseOnOff(tokens[1]);
    if (enabled === undefined) {
      return {
        ok: false,
        reason: "Expected agent-support-defaults value: on or off.",
      };
    }
    return {
      ok: true,
      change: { kind: "agent-support-defaults", enabled },
    };
  }

  if (!isScopeFieldCommand(command)) {
    return {
      ok: false,
      reason:
        "Expected `scope`, `scope preset <project|home|unrestricted>`, `scope roots|writable|temp|denied|safe-home|agent-support add|remove <path>`, `scope safe-home-defaults <on|off>`, `scope agent-support-defaults <on|off>`, or `scope unknown-path <review|deny>`.",
    };
  }

  if (tokens.length !== 3) {
    return {
      ok: false,
      reason: `Expected \`scope ${command} add|remove <path>\`.`,
    };
  }

  const action = tokens[1];
  if (action !== "add" && action !== "remove") {
    return {
      ok: false,
      reason: `Expected \`add\` or \`remove\` after \`scope ${command}\`.`,
    };
  }

  const pathValue = tokens[2];
  if (pathValue === undefined || pathValue.length === 0) {
    return {
      ok: false,
      reason: `Expected a path after \`scope ${command} ${action}\`.`,
    };
  }

  return {
    ok: true,
    change: {
      kind: action === "add" ? "add-path" : "remove-path",
      field: SCOPE_LIST_FIELDS[command],
      path: pathValue,
    },
  };
}

async function confirmScopePlan(
  ctx: ExtensionCommandContext,
  plan: ConfigCommandPlan,
  resolvedAfter: ResolvedProjectScope,
): Promise<boolean> {
  try {
    return await ctx.ui.confirm(
      plan.title,
      formatScopeConfirmationMarkdown(plan, resolvedAfter),
    );
  } catch {
    return false;
  }
}

function scopeStatusFromConfig(config: ResolvedConfig): ScopeStatusDetails {
  const snapshots = config.sourceSnapshots;
  const raw = snapshots?.project.projectScope ?? EMPTY_PROJECT_SCOPE;
  const projectOverlayPath = snapshots?.paths.projectOverlayFile;
  const scopeErrors = config.errors
    .filter(isProjectScopeError)
    .map(formatConfigError);
  const scopeWarnings = config.warnings
    .filter(isProjectScopeWarning)
    .map(formatConfigWarning);

  return {
    raw,
    resolved: config.projectScope,
    implicit: {
      cwdRoot: path.resolve(config.cwd),
      cwdWritable: path.resolve(config.cwd),
      osTemp: path.resolve(tmpdir()),
      ...(config.homeDirectory === undefined
        ? {}
        : { homeDirectory: config.homeDirectory }),
    },
    ...(projectOverlayPath === undefined ? {} : { projectOverlayPath }),
    errors: scopeErrors,
    warnings: scopeWarnings,
  };
}

function formatScopeStatusMarkdown(details: ScopeStatusDetails): string {
  const lines = [
    "# Pi Clearance project scope",
    "",
    "Project scope is lexical-only: it normalizes strings but does not follow symlinks, check filesystem existence, or provide sandbox containment.",
    "",
    ...(details.projectOverlayPath === undefined
      ? []
      : [`- Project overlay: \`${details.projectOverlayPath}\``]),
    `- Preset: ${formatPreset(details.raw)}`,
    `- Unknown path behavior: ${details.raw.unknownPathBehavior}`,
    `- Sensitive home behavior: ${details.raw.sensitivePathBehavior}`,
    `- Home path behavior: ${details.raw.homePathBehavior}`,
    `- Safe-home defaults: ${details.raw.safeHomeUseDefaults ? "on" : "off"}`,
    `- Agent-support defaults: ${details.raw.agentSupportUseDefaults === false ? "off" : "on"}`,
    "",
    "## Raw configured projectScope",
    "",
    "### roots",
    ...formatRawPathList(details.raw.roots, details.implicit.cwdRoot),
    "",
    "### writableDirectories",
    ...formatRawPathList(
      details.raw.writableDirectories,
      details.implicit.cwdRoot,
    ),
    "",
    "### tempDirectories",
    ...formatRawPathList(details.raw.tempDirectories, details.implicit.cwdRoot),
    "",
    "### deniedDirectories",
    ...formatRawPathList(
      details.raw.deniedDirectories,
      details.implicit.cwdRoot,
    ),
    "",
    "### safeHomeDirectories",
    ...formatRawSafeHomePathList(
      details.raw.safeHomeDirectories,
      details.implicit.homeDirectory,
    ),
    "",
    "### agentSupportDirectories",
    ...formatRawAgentSupportPathList(
      details.raw.agentSupportDirectories ?? [],
      details.implicit.cwdRoot,
      details.implicit.homeDirectory,
    ),
    "",
    "## Resolved lexical scope",
    "",
    "### roots",
    ...formatResolvedPathList(details.resolved.roots, (value) =>
      value === details.implicit.cwdRoot ? "implicit cwd root" : undefined,
    ),
    "",
    "### writableDirectories",
    ...formatResolvedPathList(details.resolved.writableDirectories, (value) =>
      value === details.implicit.cwdWritable
        ? "implicit cwd writable"
        : undefined,
    ),
    "",
    "### tempDirectories",
    ...formatResolvedPathList(details.resolved.tempDirectories, (value) =>
      value === details.implicit.osTemp ? "implicit OS temp" : undefined,
    ),
    "",
    "### deniedDirectories",
    ...formatResolvedPathList(details.resolved.deniedDirectories),
    "",
    "### safeHomeDirectories",
    ...formatResolvedPathList(details.resolved.safeHomeDirectories),
    "",
    "### agentSupportDirectories",
    ...formatResolvedPathList(details.resolved.agentSupportDirectories ?? []),
    "",
    `- Resolved safe-home defaults: ${details.raw.safeHomeUseDefaults ? "on" : "off"}`,
    `- Resolved agent-support defaults: ${details.raw.agentSupportUseDefaults === false ? "off" : "on"}`,
    `- Resolved unknown path behavior: ${details.resolved.unknownPathBehavior}`,
  ];

  if (details.errors.length > 0) {
    lines.push("", "## Errors", ...details.errors.map((error) => `- ${error}`));
  }

  if (details.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      ...details.warnings.map((warning) => `- ${warning}`),
    );
  }

  return lines.join("\n");
}

function formatScopeConfirmationMarkdown(
  plan: ConfigCommandPlan,
  resolvedAfter: ResolvedProjectScope,
): string {
  const lines = [
    plan.summary,
    "",
    `Target file: ${plan.target.path}`,
    "",
    "## Patch summary",
    ...formatPatchLines(plan.patch),
  ];

  if (plan.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      ...plan.warnings.map(
        (warning) =>
          `- ${warning.message}${warning.requiresAcknowledgement ? " (requires acknowledgement)" : ""}`,
      ),
    );
  }

  lines.push(
    "",
    "## Resolved lexical scope after this change",
    `- Roots: ${formatInlineList(resolvedAfter.roots)}`,
    `- Writable directories: ${formatInlineList(resolvedAfter.writableDirectories)}`,
    `- Temp directories: ${formatInlineList(resolvedAfter.tempDirectories)}`,
    `- Denied directories: ${formatInlineList(resolvedAfter.deniedDirectories)}`,
    `- Safe-home directories: ${formatInlineList(resolvedAfter.safeHomeDirectories)}`,
    `- Agent-support directories: ${formatInlineList(resolvedAfter.agentSupportDirectories ?? [])}`,
    `- Unknown path behavior: ${resolvedAfter.unknownPathBehavior}`,
    `- Sensitive home behavior: ${resolvedAfter.sensitivePathBehavior}`,
    `- Home path behavior: ${resolvedAfter.homePathBehavior}`,
    "",
    "Confirm to write this user-owned project-scope config change.",
  );

  return lines.join("\n");
}

function formatScopeMutationSuccessMarkdown(
  details: ScopeMutationSuccessDetails,
): string {
  const lines = [
    "# Pi Clearance project scope updated",
    "",
    `- Change: ${details.plan.title}`,
    `- Target file: \`${details.plan.target.path}\``,
    `- Changed: ${details.apply.changed ? "yes" : "no"}`,
    `- Cache invalidated: ${details.apply.changed ? "yes" : "no"}`,
  ];

  if (details.apply.backupPath !== undefined) {
    lines.push(`- Backup: \`${details.apply.backupPath}\``);
  }

  const resolved = details.status?.resolved ?? details.resolvedAfter;
  lines.push(
    "",
    "## Resolved lexical scope",
    `- Roots: ${formatInlineList(resolved.roots)}`,
    `- Writable directories: ${formatInlineList(resolved.writableDirectories)}`,
    `- Temp directories: ${formatInlineList(resolved.tempDirectories)}`,
    `- Denied directories: ${formatInlineList(resolved.deniedDirectories)}`,
    `- Safe-home directories: ${formatInlineList(resolved.safeHomeDirectories)}`,
    `- Agent-support directories: ${formatInlineList(resolved.agentSupportDirectories ?? [])}`,
    `- Unknown path behavior: ${resolved.unknownPathBehavior}`,
    `- Sensitive home behavior: ${resolved.sensitivePathBehavior}`,
    `- Home path behavior: ${resolved.homePathBehavior}`,
  );

  if (details.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      ...details.warnings.map((warning) => `- ${warning}`),
    );
  }

  return lines.join("\n");
}

function scopeApplyFailureReport(
  change: ScopeCommandChange,
  plan: ConfigCommandPlan,
  apply: Extract<ConfigCommandApplyResult, { readonly ok: false }>,
): CommandReport {
  return {
    title: "Project scope change failed",
    summary: apply.reason,
    markdown: [
      "# Project scope change failed",
      "",
      `- Target file: \`${plan.target.path}\``,
      `- Reason: ${apply.reason}`,
      `- Wrote before failure: ${yesNo(apply.wrote)}`,
      `- Restored previous file: ${yesNo(apply.restored)}`,
      "",
      "## Errors",
      ...apply.errors.map((error) => `- ${error}`),
    ].join("\n"),
    details: { change, plan, apply },
    level: "error",
  };
}

function scopeRefusalReport(input: {
  readonly title: string;
  readonly reason: string;
  readonly markdownLines?: readonly string[];
  readonly change?: ScopeCommandChange;
}): CommandReport {
  return {
    title: input.title,
    summary: input.reason,
    markdown: [
      `# ${input.title}`,
      "",
      `- Reason: ${input.reason}`,
      ...(input.markdownLines ?? []),
    ].join("\n"),
    details: { reason: input.reason, change: input.change },
    level: "error",
  };
}

function formatRawPathList(
  values: readonly string[],
  baseDirectory: string | undefined,
  unavailableLabel = "base unavailable",
): readonly string[] {
  if (values.length === 0) {
    return ["- none"];
  }

  return values.map((value) =>
    baseDirectory === undefined
      ? `- \`${value}\` → ${unavailableLabel}`
      : `- \`${value}\` → \`${path.resolve(baseDirectory, value)}\``,
  );
}

function formatRawSafeHomePathList(
  values: readonly string[],
  homeDirectory: string | undefined,
): readonly string[] {
  if (values.length === 0) {
    return ["- none"];
  }

  return values.map((value) =>
    homeDirectory === undefined
      ? `- \`${value}\` → $HOME unavailable`
      : `- \`${value}\` → \`${resolveHomeRelativeDisplayPath(value, homeDirectory)}\``,
  );
}

function formatRawAgentSupportPathList(
  values: readonly string[],
  cwd: string,
  homeDirectory: string | undefined,
): readonly string[] {
  if (values.length === 0) {
    return ["- none"];
  }

  return values.map((value) => {
    const usesHomeExpression =
      value === "~" ||
      value.startsWith("~/") ||
      value === "$HOME" ||
      value.startsWith("$HOME/") ||
      value === "$" + "{HOME}" ||
      value.startsWith("$" + "{HOME}/");
    const resolved =
      usesHomeExpression && homeDirectory !== undefined
        ? resolveHomeRelativeDisplayPath(value, homeDirectory)
        : path.isAbsolute(value)
          ? path.resolve(value)
          : path.resolve(cwd, value);
    return `- \`${value}\` → \`${resolved}\``;
  });
}

function resolveHomeRelativeDisplayPath(
  value: string,
  homeDirectory: string,
): string {
  if (value === "~" || value.startsWith("~/")) {
    return path.resolve(homeDirectory, value.slice(2));
  }
  if (value === "$HOME" || value.startsWith("$HOME/")) {
    return path.resolve(homeDirectory, value.slice("$HOME".length + 1));
  }
  const homeExpression = ["$", "{HOME}"].join("");
  if (value === homeExpression || value.startsWith(`${homeExpression}/`)) {
    return path.resolve(homeDirectory, value.slice(homeExpression.length + 1));
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(homeDirectory, value);
}

function formatResolvedPathList(
  values: readonly string[],
  markerFor?: (value: string) => string | undefined,
): readonly string[] {
  if (values.length === 0) {
    return ["- none"];
  }

  return values.map((value) => {
    const marker = markerFor?.(value);
    return marker === undefined
      ? `- \`${value}\``
      : `- \`${value}\` (${marker})`;
  });
}

function formatPatchLines(
  patch: readonly JsonPatchOperation[],
): readonly string[] {
  if (patch.length === 0) {
    return ["- No-op: project scope already has the requested value."];
  }

  return patch.map((operation) => {
    const before =
      "before" in operation ? ` from ${formatJson(operation.before)}` : "";
    const value =
      "value" in operation ? ` to ${formatJson(operation.value)}` : "";
    return `- ${operation.op} ${operation.path}${before}${value}`;
  });
}

function formatInlineList(values: readonly string[]): string {
  return values.length === 0
    ? "none"
    : values.map((value) => `\`${value}\``).join(", ");
}

function formatConfigError(error: ConfigError): string {
  return `${error.path}: ${error.message}`;
}

function formatConfigWarning(warning: ConfigWarning): string {
  return `${warning.path}: ${warning.message}`;
}

function isProjectScopeError(error: ConfigError): boolean {
  return error.message.includes("projectScope");
}

function isProjectScopeWarning(warning: ConfigWarning): boolean {
  return warning.message.includes("projectScope");
}

function isScopeFieldCommand(
  value: string | undefined,
): value is keyof typeof SCOPE_LIST_FIELDS {
  return value !== undefined && value in SCOPE_LIST_FIELDS;
}

function parseOnOff(value: string | undefined): boolean | undefined {
  switch (value) {
    case "on":
    case "true":
      return true;
    case "off":
    case "false":
      return false;
    default:
      return undefined;
  }
}

function formatPreset(raw: ProjectScopeConfig): string {
  const preset = inferScopePreset(raw);
  return preset === "custom" ? "custom" : SCOPE_PRESET_LABELS[preset];
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatJson(value: unknown): string {
  return `\`${JSON.stringify(value)}\``;
}
