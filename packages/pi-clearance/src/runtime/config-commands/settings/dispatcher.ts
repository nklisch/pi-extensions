import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  type ProjectScopeListField,
  planModeCommandChange,
  planProjectScopeCommandChange,
  planReviewerCommandChange,
  planReviewNoteDisplayCommandChange,
  type ReviewerCommandChange,
  type ReviewNoteDisplayCommandChange,
  type ScopeCommandChange,
} from "../../../config/config-command-plans.ts";
import {
  applyConfigCommandPlan,
  type ConfigCommandApplyResult,
  type ConfigCommandPlan,
} from "../../../config/config-command-writer.ts";
import type { ClearanceMode } from "../../../config/schema.ts";
import type { JsonPatchOperation } from "../../../replay/proposal-schema.ts";
import { detectReviewDecisionDisplayCapability } from "../../review-decision-display.ts";
import {
  handlePackMutationCommand,
  type PackMutationRequest,
} from "../packs.ts";
import { createConfigCommandWriterDependencies } from "../post-write-validation.ts";
import {
  type AutoReviewerCommandDependencies,
  type CommandReport,
  resolvePolicyReport,
  stableUnique,
} from "../types.ts";
import {
  isDrillAction,
  isWriteAction,
  type SettingsAction,
  type SettingsActionId,
} from "./actions.ts";
import { renderPacksOpenDrill, renderPacksShowDrill } from "./panels/packs.ts";

export interface SettingsDispatchDependencies
  extends AutoReviewerCommandDependencies {}

type SettingsDispatchDetails =
  | {
      readonly reason: "navigation";
      readonly action: SettingsAction;
      readonly panel: string;
      readonly fallbackSurface?: ReturnType<
        typeof detectReviewDecisionDisplayCapability
      >;
    }
  | { readonly reason: "ui-required"; readonly action: SettingsAction }
  | { readonly reason: "invalid-action"; readonly action: SettingsAction }
  | { readonly reason: "plan-refused"; readonly action: SettingsAction }
  | {
      readonly reason: "cancelled";
      readonly action: SettingsAction;
      readonly plan: ConfigCommandPlan;
    }
  | {
      readonly reason: "applied";
      readonly action: SettingsAction;
      readonly plan: ConfigCommandPlan;
      readonly apply: Extract<ConfigCommandApplyResult, { readonly ok: true }>;
      readonly warnings: readonly string[];
    }
  | {
      readonly reason: "apply-failed";
      readonly action: SettingsAction;
      readonly plan: ConfigCommandPlan;
      readonly apply: Extract<ConfigCommandApplyResult, { readonly ok: false }>;
    };

/**
 * Single mutation entry point for settings panels.
 *
 * Selecting an option in a panel only chooses a SettingsAction. Every write here
 * still runs planner -> confirmation -> applyConfigCommandPlan, matching the
 * direct command path and keeping user-owned config writes auditable.
 */
export async function dispatchSettingsAction(
  action: SettingsAction,
  ctx: ExtensionCommandContext,
  deps: SettingsDispatchDependencies,
): Promise<CommandReport<SettingsDispatchDetails | unknown>> {
  if (isDrillAction(action.id)) {
    if (action.id === "packs.open") {
      return await renderPacksOpenDrill({ action, ctx, deps });
    }
    if (action.id === "packs.show") {
      return await renderPacksShowDrill({ action, ctx, deps });
    }
    return drillReport(action, ctx);
  }

  if (isPackMutationSettingsAction(action.id)) {
    const request = materializePackMutationRequest(action);
    if (!request.ok) {
      return invalidActionReport(action, request.reason);
    }
    return await handlePackMutationCommand({
      request: request.request,
      ctx,
      deps,
    });
  }

  if (!isWriteAction(action.id)) {
    return invalidActionReport(
      action,
      `Unknown settings action: ${action.id}.`,
    );
  }

  if (ctx.hasUI !== true) {
    return settingsUiRequiredReport(action);
  }

  const policy = await resolvePolicyReport(ctx, deps);
  if (!policy.ok) {
    return policy.report;
  }

  const change = materializeSettingsAction(action);
  if (!change.ok) {
    return invalidActionReport(action, change.reason);
  }

  const planned = (() => {
    switch (change.kind) {
      case "mode":
        return planModeCommandChange({
          mode: change.mode,
          resolvedConfig: policy.policy.config,
        });
      case "reviewer":
        return planReviewerCommandChange({
          change: change.change,
          resolvedConfig: policy.policy.config,
          cwd: ctx.cwd,
        });
      case "scope":
        return planProjectScopeCommandChange({
          change: change.change,
          resolvedConfig: policy.policy.config,
          cwd: ctx.cwd,
        });
      case "display":
        return planReviewNoteDisplayCommandChange({
          change: change.change,
          resolvedConfig: policy.policy.config,
          cwd: ctx.cwd,
        });
    }
  })();

  if (!planned.ok) {
    return planRefusedReport(action, planned.reason);
  }

  const confirmed = await confirmSettingsPlan(ctx, planned.plan);
  if (!confirmed) {
    return {
      title: "Settings change cancelled",
      summary:
        "The settings change was not confirmed; no config changes were written.",
      markdown: [
        "# Settings change cancelled",
        "",
        `- Action: \`${action.id}\``,
        `- Target file: \`${planned.plan.target.path}\``,
        "- The confirmation prompt was declined or dismissed.",
        "- No config changes were written.",
      ].join("\n"),
      details: { reason: "cancelled", action, plan: planned.plan },
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
    return applyFailureReport(action, planned.plan, apply);
  }

  if (apply.changed) {
    deps.policyResolver.invalidate(ctx.cwd);
  }

  const refreshed = await resolvePolicyReport(ctx, deps);
  const warnings = stableUnique([
    ...planned.plan.warnings.map((warning) => warning.message),
    ...apply.warnings,
    ...(refreshed.ok ? refreshed.policy.warnings : [refreshed.report.summary]),
  ]);

  return {
    title: "Settings updated",
    summary: `${planned.plan.title}; changed ${apply.changed ? "yes" : "no"}.`,
    markdown: formatApplySuccessMarkdown(action, planned.plan, apply, warnings),
    details: {
      reason: "applied",
      action,
      plan: planned.plan,
      apply,
      warnings,
    },
    level: warnings.length === 0 ? "info" : "warning",
  };
}

/** Shared no-UI refusal report for settings writes. */
export function settingsUiRequiredReport(
  action: SettingsAction,
): CommandReport<Extract<SettingsDispatchDetails, { reason: "ui-required" }>> {
  return {
    title: "Settings change requires UI",
    summary:
      "Settings changes require an interactive confirmation; no config changes were written.",
    markdown: [
      "# Settings change requires UI",
      "",
      `- Action: \`${action.id}\``,
      "- Mutating settings actions require Pi UI confirmation.",
      "- No config changes were written.",
    ].join("\n"),
    details: { reason: "ui-required", action },
    level: "error",
  };
}

type MaterializedSettingsChange =
  | { readonly ok: true; readonly kind: "mode"; readonly mode: ClearanceMode }
  | {
      readonly ok: true;
      readonly kind: "reviewer";
      readonly change: ReviewerCommandChange;
    }
  | {
      readonly ok: true;
      readonly kind: "scope";
      readonly change: ScopeCommandChange;
    }
  | {
      readonly ok: true;
      readonly kind: "display";
      readonly change: ReviewNoteDisplayCommandChange;
    }
  | { readonly ok: false; readonly reason: string };

function materializeSettingsAction(
  action: SettingsAction,
): MaterializedSettingsChange {
  switch (action.id) {
    case "mode.set": {
      const mode = stringArg(action, "mode");
      if (mode !== "off" && mode !== "ask" && mode !== "auto") {
        return invalidArg(action, "mode", "off, ask, or auto");
      }
      return { ok: true, kind: "mode", mode };
    }
    case "reviewer.model": {
      const model = nullableStringArg(action, "model");
      if (!model.ok) return { ok: false, reason: model.reason };
      return {
        ok: true,
        kind: "reviewer",
        change: { kind: "reviewer-model", model: model.value },
      };
    }
    case "scope.add-path":
    case "scope.remove-path": {
      const field = scopeFieldArg(action);
      if (!field.ok) return { ok: false, reason: field.reason };
      const rawPath = stringArg(action, "path");
      if (rawPath === undefined || rawPath.trim().length === 0) {
        return invalidArg(action, "path", "a non-empty path");
      }
      return {
        ok: true,
        kind: "scope",
        change: {
          kind: action.id === "scope.add-path" ? "add-path" : "remove-path",
          field: field.value,
          path: rawPath,
        },
      };
    }
    case "scope.unknown-path": {
      const behavior = stringArg(action, "behavior");
      if (behavior !== "review" && behavior !== "deny") {
        return invalidArg(action, "behavior", "review or deny");
      }
      return {
        ok: true,
        kind: "scope",
        change: { kind: "unknown-path-behavior", behavior },
      };
    }
    case "scope.safe-home-defaults": {
      const enabled = booleanArg(action, "enabled");
      if (enabled === undefined) {
        return invalidArg(action, "enabled", "true or false");
      }
      return {
        ok: true,
        kind: "scope",
        change: { kind: "safe-home-defaults", enabled },
      };
    }
    case "scope.agent-support-defaults": {
      const enabled = booleanArg(action, "enabled");
      if (enabled === undefined) {
        return invalidArg(action, "enabled", "true or false");
      }
      return {
        ok: true,
        kind: "scope",
        change: { kind: "agent-support-defaults", enabled },
      };
    }
    case "scope.preset": {
      const preset = stringArg(action, "preset");
      if (
        preset !== "project" &&
        preset !== "home" &&
        preset !== "unrestricted"
      ) {
        return invalidArg(action, "preset", "project, home, or unrestricted");
      }
      return {
        ok: true,
        kind: "scope",
        change: { kind: "preset", preset },
      };
    }
    case "briefing.mode": {
      const mode = stringArg(action, "mode");
      if (
        mode !== "reason+accent" &&
        mode !== "accent-only" &&
        mode !== "reason+model" &&
        mode !== "off"
      ) {
        return invalidArg(
          action,
          "mode",
          "reason+accent, accent-only, reason+model, or off",
        );
      }
      return {
        ok: true,
        kind: "display",
        change: { kind: "mode", mode },
      };
    }
    case "briefing.model-label": {
      const enabled = booleanArg(action, "enabled");
      if (enabled === undefined) {
        return invalidArg(action, "enabled", "true or false");
      }
      return {
        ok: true,
        kind: "display",
        change: { kind: "show-model-label", enabled },
      };
    }
    case "briefing.accent": {
      const enabled = booleanArg(action, "enabled");
      if (enabled === undefined) {
        return invalidArg(action, "enabled", "true or false");
      }
      return {
        ok: true,
        kind: "display",
        change: { kind: "accent", enabled },
      };
    }
    case "reviewer.open":
    case "scope.open":
    case "packs.open":
    case "packs.show":
    case "packs.enable":
    case "packs.disable":
    case "briefing.open":
      return {
        ok: false,
        reason: "Drill actions are handled before mutation planning.",
      };
    default:
      return { ok: false, reason: `Unsupported settings action: ${action.id}` };
  }
}

function isPackMutationSettingsAction(
  id: SettingsActionId,
): id is "packs.enable" | "packs.disable" {
  return id === "packs.enable" || id === "packs.disable";
}

function materializePackMutationRequest(
  action: SettingsAction,
):
  | { readonly ok: true; readonly request: PackMutationRequest }
  | { readonly ok: false; readonly reason: string } {
  const packId = stringArg(action, "packId");
  if (packId === undefined || packId.trim().length === 0) {
    return invalidArg(action, "packId", "a non-empty pack id");
  }
  const scope = optionalStringArg(action, "scope");
  if (scope !== undefined && scope !== "global" && scope !== "project") {
    return invalidArg(action, "scope", "global or project");
  }
  return {
    ok: true,
    request: {
      action: action.id === "packs.enable" ? "enable" : "disable",
      packId,
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

function drillReport(
  action: SettingsAction,
  ctx: ExtensionCommandContext,
): CommandReport<Extract<SettingsDispatchDetails, { reason: "navigation" }>> {
  const panel = panelTitleForDrill(action.id);
  const fallbackSurface =
    action.id === "briefing.open"
      ? detectReviewDecisionDisplayCapability(ctx)
      : undefined;
  const markdown =
    action.id === "briefing.open"
      ? renderBriefingNavigationDrill(panel, action, fallbackSurface)
      : renderGenericNavigationDrill(panel, action);

  return {
    title: `${panel} settings`,
    summary: `Open the ${panel} settings panel; no config changes were written.`,
    markdown,
    details: {
      reason: "navigation",
      action,
      panel,
      ...(fallbackSurface === undefined ? {} : { fallbackSurface }),
    },
    level: "info",
  };
}

function renderGenericNavigationDrill(
  panel: string,
  action: SettingsAction,
): string {
  return [
    `# ${panel} settings`,
    "",
    `- Action: \`${action.id}\``,
    "- Navigation only; no config changes were written.",
  ].join("\n");
}

function renderBriefingNavigationDrill(
  panel: string,
  action: SettingsAction,
  fallbackSurface:
    | ReturnType<typeof detectReviewDecisionDisplayCapability>
    | undefined,
): string {
  const lines = [`# ${panel} settings`, "", `- Action: \`${action.id}\``];

  if (fallbackSurface !== undefined) {
    lines.push(
      `- Fallback surface: **${formatBriefingFallbackSurface(fallbackSurface)}**`,
    );
  }

  lines.push("- Navigation only; no config changes were written.");

  const note =
    fallbackSurface === undefined
      ? undefined
      : briefingFallbackSurfaceNote(fallbackSurface);
  if (note !== undefined) {
    lines.push("", note);
  }

  return lines.join("\n");
}

function briefingFallbackSurfaceNote(
  surface: ReturnType<typeof detectReviewDecisionDisplayCapability>,
): string | undefined {
  if (surface === "tool-call-accent") return undefined;
  return `Pi does not expose a tool-call accent hook in this build; the accent intent is rendered via \`${surface}\` instead.`;
}

function formatBriefingFallbackSurface(
  surface: ReturnType<typeof detectReviewDecisionDisplayCapability>,
): string {
  switch (surface) {
    case "tool-call-accent":
      return "tool-call accent";
    case "stream-widget":
      return "stream widget";
    case "status-notify":
      return "status/notification";
    case "none":
      return "none";
  }
}

function invalidActionReport(
  action: SettingsAction,
  reason: string,
): CommandReport {
  return {
    title: "Settings action refused",
    summary: reason,
    markdown: [
      "# Settings action refused",
      "",
      `- Action: \`${action.id}\``,
      `- Reason: ${reason}`,
      "- No config changes were written.",
    ].join("\n"),
    details: { reason: "invalid-action", action },
    level: "error",
  };
}

function planRefusedReport(
  action: SettingsAction,
  reason: string,
): CommandReport {
  return {
    title: "Settings change refused",
    summary: reason,
    markdown: [
      "# Settings change refused",
      "",
      `- Action: \`${action.id}\``,
      `- Reason: ${reason}`,
      "- No config changes were written.",
    ].join("\n"),
    details: { reason: "plan-refused", action },
    level: "error",
  };
}

function applyFailureReport(
  action: SettingsAction,
  plan: ConfigCommandPlan,
  apply: Extract<ConfigCommandApplyResult, { readonly ok: false }>,
): CommandReport<Extract<SettingsDispatchDetails, { reason: "apply-failed" }>> {
  return {
    title: "Settings change failed",
    summary: apply.reason,
    markdown: [
      "# Settings change failed",
      "",
      `- Action: \`${action.id}\``,
      `- Target file: \`${plan.target.path}\``,
      `- Reason: ${apply.reason}`,
      `- Wrote before failure: ${yesNo(apply.wrote)}`,
      `- Restored previous file: ${yesNo(apply.restored)}`,
      "",
      "## Errors",
      ...apply.errors.map((error) => `- ${error}`),
    ].join("\n"),
    details: { reason: "apply-failed", action, plan, apply },
    level: "error",
  };
}

async function confirmSettingsPlan(
  ctx: ExtensionCommandContext,
  plan: ConfigCommandPlan,
): Promise<boolean> {
  try {
    return await ctx.ui.confirm(plan.title, formatConfirmationMarkdown(plan));
  } catch {
    return false;
  }
}

function formatConfirmationMarkdown(plan: ConfigCommandPlan): string {
  const lines = [
    plan.summary,
    "",
    `Target file: ${plan.target.path}`,
    "",
    "## Patch summary",
    ...formatPatchLines(plan.patch),
  ];

  const modeLines = modeConfirmationLines(plan);
  if (modeLines.length > 0) {
    lines.push("", "## Effect", ...modeLines);
  }

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

  lines.push("", "Confirm to write this user-owned settings config change.");
  return lines.join("\n");
}

function formatApplySuccessMarkdown(
  action: SettingsAction,
  plan: ConfigCommandPlan,
  apply: Extract<ConfigCommandApplyResult, { readonly ok: true }>,
  warnings: readonly string[],
): string {
  const lines = [
    "# Settings updated",
    "",
    `- Action: \`${action.id}\``,
    `- Change: ${plan.title}`,
    `- Target file: \`${plan.target.path}\``,
    `- Changed: ${yesNo(apply.changed)}`,
    `- Cache invalidated: ${yesNo(apply.changed)}`,
  ];

  if (apply.backupPath !== undefined) {
    lines.push(`- Backup: \`${apply.backupPath}\``);
  }

  const autoLines = modeConfirmationLines(plan);
  if (autoLines.length > 0) {
    lines.push("", "## Effect", ...autoLines);
  }

  if (warnings.length > 0) {
    lines.push("", "## Warnings", ...warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatPatchLines(
  patch: readonly JsonPatchOperation[],
): readonly string[] {
  if (patch.length === 0) {
    return ["- No-op: target config already has the requested value."];
  }
  return patch.map((operation) => {
    const before =
      "before" in operation ? ` from ${formatJson(operation.before)}` : "";
    const value =
      "value" in operation ? ` to ${formatJson(operation.value)}` : "";
    return `- ${operation.op} ${operation.path}${before}${value}`;
  });
}

function reviewerDisclosureDetails(plan: ConfigCommandPlan): string {
  if (!("reviewer" in plan.after)) {
    return "the active session reviewer configuration is used";
  }
  const reviewer = plan.after.reviewer;
  return `reviewer model/provider is ${reviewer.model ?? "the active session model (fallback)"}; prompt posture is ${reviewer.promptPosture}; context mode is ${reviewer.contextMode}`;
}

function modeConfirmationLines(plan: ConfigCommandPlan): readonly string[] {
  const modeChange = plan.patch.find((operation) => operation.path === "/mode");
  if (modeChange === undefined || !("value" in modeChange)) return [];
  switch (modeChange.value) {
    case "off":
      return [
        "- Off passes review-bucket calls through with an audit entry but deterministic denies still block.",
      ];
    case "ask":
      return [
        "- Ask sends review-bucket calls to the human path and never calls a model.",
      ];
    case "auto":
      return [
        "- Auto uses model review first, then human review or block-and-log fallback.",
        `- Disclosure: ${reviewerDisclosureDetails(plan)}`,
        "- The current tool call and parsed shape are sent for review. Recent context, when configured, is bounded and sent as untrusted intent context only; it never changes deterministic policy.",
      ];
    default:
      return [];
  }
}

function panelTitleForDrill(id: SettingsActionId): string {
  switch (id) {
    case "reviewer.open":
      return "Reviewer";
    case "scope.open":
      return "Project scope";
    case "packs.open":
    case "packs.show":
      return "Pack explorer";
    case "packs.enable":
    case "packs.disable":
      return "Settings";
    case "briefing.open":
      return "Stream briefing";
    default:
      return "Settings";
  }
}

function scopeFieldArg(
  action: SettingsAction,
):
  | { readonly ok: true; readonly value: ProjectScopeListField }
  | { readonly ok: false; readonly reason: string } {
  const field = stringArg(action, "field");
  switch (field) {
    case "roots":
    case "root":
      return { ok: true, value: "roots" };
    case "writable":
    case "writableDirectories":
      return { ok: true, value: "writableDirectories" };
    case "temp":
    case "tempDirectories":
      return { ok: true, value: "tempDirectories" };
    case "denied":
    case "deniedDirectories":
    case "no-go":
      return { ok: true, value: "deniedDirectories" };
    case "safe-home":
    case "safeHomeDirectories":
      return { ok: true, value: "safeHomeDirectories" };
    case "agent-support":
    case "agentSupportDirectories":
      return { ok: true, value: "agentSupportDirectories" };
    default:
      return {
        ok: false,
        reason:
          "Settings action `scope.add-path`/`scope.remove-path` requires field roots, writable, temp, denied, safe-home, or agent-support.",
      };
  }
}

function invalidArg(
  action: SettingsAction,
  name: string,
  expected: string,
): { readonly ok: false; readonly reason: string } {
  return {
    ok: false,
    reason: `Settings action \`${action.id}\` requires ${name}: ${expected}.`,
  };
}

function stringArg(action: SettingsAction, name: string): string | undefined {
  const value = action.args[name];
  return typeof value === "string" ? value : undefined;
}

function optionalStringArg(
  action: SettingsAction,
  name: string,
): string | undefined {
  const value = stringArg(action, name);
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function booleanArg(action: SettingsAction, name: string): boolean | undefined {
  const value = action.args[name];
  return typeof value === "boolean" ? value : undefined;
}

function nullableStringArg(
  action: SettingsAction,
  name: string,
):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly reason: string } {
  const value = action.args[name];
  if (value === null) return { ok: true, value: null };
  if (typeof value === "string" && value.trim().length > 0) {
    return { ok: true, value };
  }
  return {
    ok: false,
    reason: `Settings action \`${action.id}\` requires ${name}: a non-empty string or null.`,
  };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatJson(value: unknown): string {
  return `\`${JSON.stringify(value)}\``;
}
