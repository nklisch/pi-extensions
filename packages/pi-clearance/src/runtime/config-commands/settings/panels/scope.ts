import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  inferScopePreset,
  type ProjectScopeListField,
  SCOPE_PRESET_LABELS,
} from "../../../../config/config-command-plans.ts";
import type { CommandReport } from "../../types.ts";
import type { SettingsAction } from "../actions.ts";
import {
  dispatchSettingsAction,
  type SettingsDispatchDependencies,
  settingsUiRequiredReport,
} from "../dispatcher.ts";
import type { SettingsPanel, SettingsRow } from "../panels.ts";
import type { SettingsReadModel } from "../read-model.ts";

const SCOPE_FIELD_LABELS = {
  roots: "Project roots",
  writableDirectories: "Writable directories",
  tempDirectories: "Temp directories",
  deniedDirectories: "Denied paths",
  safeHomeDirectories: "Safe-home entries",
  agentSupportDirectories: "Agent-support directories",
} as const satisfies Record<ProjectScopeListField, string>;

export type ScopePathActionId = "scope.add-path" | "scope.remove-path";

export interface ScopePathActionDescriptor {
  readonly field: ProjectScopeListField;
  readonly label: string;
  readonly addAction: SettingsAction;
  readonly removeAction: SettingsAction;
}

export interface ScopePathInputRequest {
  readonly id: ScopePathActionId;
  readonly field: ProjectScopeListField;
}

export interface ScopePathInputAdapter {
  readonly inputPath: (
    request: ScopePathInputRequest,
  ) => Promise<ScopePathInputResult> | ScopePathInputResult;
}

type ScopePathInputResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "unavailable" | "cancelled" };

interface InputCapableCommandContext {
  readonly hasUI?: boolean;
  readonly ui?: {
    readonly input?: (
      title: string,
    ) => Promise<string | undefined> | string | undefined;
  };
}

export const SCOPE_PATH_ACTION_DESCRIPTORS = [
  descriptor("roots"),
  descriptor("writableDirectories"),
  descriptor("tempDirectories"),
  descriptor("deniedDirectories"),
  descriptor("safeHomeDirectories"),
  descriptor("agentSupportDirectories"),
] as const satisfies readonly ScopePathActionDescriptor[];

export const SCOPE_PANEL: SettingsPanel = {
  id: "scope",
  title: "Project scope",
  rows: scopeRows,
  actions: [
    "scope.open",
    "scope.preset",
    "scope.add-path",
    "scope.remove-path",
    "scope.unknown-path",
    "scope.safe-home-defaults",
    "scope.agent-support-defaults",
  ],
};

export function scopeRows(model: SettingsReadModel): readonly SettingsRow[] {
  const scope = model.projectScope;
  const preset = inferScopePreset(scope);

  return [
    {
      label: "Preset",
      value:
        preset === "custom"
          ? "Custom"
          : (SCOPE_PRESET_LABELS[preset] ?? preset),
      meaning:
        "Named bundle over the behavior fields below; choose with scope.preset. Custom means fields were mixed outside a preset.",
    },
    {
      label: "Project roots",
      value: formatPathList(scope.roots),
      meaning: "Safe Zones that read/search/list policy can prove.",
    },
    {
      label: "Writable directories",
      value: formatPathList(scope.writableDirectories),
      meaning:
        "Typed edit/write policy can clear inside proven writable scope.",
    },
    {
      label: "Temp directories",
      value: formatPathList(scope.tempDirectories),
      meaning: "Temp locations available to path-fact policy.",
    },
    {
      label: "Denied paths",
      value: formatPathList(scope.deniedDirectories),
      meaning: "No-Go Zones override other configured scopes.",
    },
    {
      label: "Safe-home entries",
      value: formatPathList(scope.safeHomeDirectories),
      meaning:
        "Home-relative safe locations used by the built-in baseline when path facts prove they are safe.",
    },
    {
      label: "Agent-support entries",
      value: formatPathList(scope.agentSupportDirectories ?? []),
      meaning:
        "Pi skill/plugin/docs/rules roots where typed read/search/list operations may fast-path; sensitive-home carveouts still win.",
    },
    {
      label: "Safe-home defaults",
      value: scope.safeHomeUseDefaults === false ? "Off" : "On",
      meaning:
        "Implicit developer-oriented home defaults are part of resolved safe-home scope when on.",
    },
    {
      label: "Home paths",
      value: scope.homePathBehavior === "review" ? "Review" : "Allow",
      meaning:
        "Review sends any command touching home paths to review (project-only preset); Allow keeps baseline home read auto-approvals.",
    },
    {
      label: "Sensitive home paths",
      value: scope.sensitivePathBehavior === "deny" ? "Deny" : "Review",
      meaning:
        "Credentials, keys, and auth files; Deny hard-blocks them (full-minus-danger preset).",
    },
    {
      label: "Unknown paths",
      value: formatUnknownPathBehavior(scope.unknownPathBehavior),
      meaning:
        "Dynamic or ambiguous paths never become an allow; this controls review-vs-deny intent.",
    },
  ];
}

export function renderScopePanel(model: SettingsReadModel): string {
  return [
    "# Project scope settings",
    "",
    markdownTable(scopeRows(model)),
    "",
    "## Preset action",
    "- `scope.preset` — apply a named preset bundle with `preset: project`, `home`, or `unrestricted`. Writes the behavior fields only, never path lists.",
    "",
    "## Path actions",
    ...SCOPE_PATH_ACTION_DESCRIPTORS.flatMap((descriptor) => [
      `- \`scope.add-path\` — add a path to ${descriptor.label} with \`field: ${descriptor.field}\`.`,
      `- \`scope.remove-path\` — remove a path from ${descriptor.label} with \`field: ${descriptor.field}\`.`,
    ]),
    "",
    "## Toggle actions",
    "- `scope.unknown-path` — set unknown-path behavior to `review` or `deny` through the dispatcher.",
    "- `scope.safe-home-defaults` — turn implicit safe-home defaults on or off through the dispatcher.",
    "- `scope.agent-support-defaults` — turn built-in Pi support roots on or off through the dispatcher.",
    "",
    [
      "Opening this panel is navigation only and writes no config.",
      "Path add/remove needs path input first, then `dispatchSettingsAction`",
      "materializes the existing project-scope planner and confirmation/write path.",
      "Selecting an action alone is not write approval.",
    ].join(" "),
  ].join("\n");
}

export async function dispatchScopePathInputAction(
  request: ScopePathInputRequest,
  ctx: ExtensionCommandContext,
  deps: SettingsDispatchDependencies,
  inputAdapter: ScopePathInputAdapter = createPiScopePathInputAdapter(ctx),
): Promise<CommandReport> {
  const baseAction: SettingsAction = {
    id: request.id,
    args: { field: request.field },
  };

  if (ctx.hasUI !== true) {
    return settingsUiRequiredReport(baseAction);
  }

  const input = await inputAdapter.inputPath(request);
  if (!input.ok) {
    return pathInputRefusedReport(baseAction, input.reason);
  }

  const pathValue = input.path.trim();
  if (pathValue.length === 0) {
    return pathInputRefusedReport(baseAction, "cancelled");
  }

  return await dispatchSettingsAction(
    { id: request.id, args: { field: request.field, path: pathValue } },
    ctx,
    deps,
  );
}

export function createPiScopePathInputAdapter(
  ctx: ExtensionCommandContext,
): ScopePathInputAdapter {
  return {
    async inputPath(request) {
      const input = (ctx as unknown as InputCapableCommandContext).ui?.input;
      if (typeof input !== "function") {
        return { ok: false, reason: "unavailable" };
      }

      const value = await input(
        `${request.id === "scope.add-path" ? "Add" : "Remove"} ${SCOPE_FIELD_LABELS[request.field]} path`,
      );
      if (value === undefined) {
        return { ok: false, reason: "cancelled" };
      }
      return { ok: true, path: value };
    },
  };
}

function descriptor(field: ProjectScopeListField): ScopePathActionDescriptor {
  return {
    field,
    label: SCOPE_FIELD_LABELS[field],
    addAction: { id: "scope.add-path", args: { field } },
    removeAction: { id: "scope.remove-path", args: { field } },
  };
}

function pathInputRefusedReport(
  action: SettingsAction,
  reason: "unavailable" | "cancelled",
): CommandReport {
  const summary =
    reason === "unavailable"
      ? "Path input is not available in this Pi UI host; no config changes were written."
      : "Path input was cancelled or empty; no config changes were written.";

  return {
    title: "Project scope path input required",
    summary,
    markdown: [
      "# Project scope path input required",
      "",
      `- Action: \`${action.id}\``,
      `- Field: \`${String(action.args.field)}\``,
      `- Reason: ${summary}`,
      "- No config changes were written.",
    ].join("\n"),
    details: { reason: `path-input-${reason}`, action },
    level: reason === "unavailable" ? "error" : "warning",
  };
}

function formatPathList(paths: readonly string[]): string {
  if (paths.length === 0) return "none configured";
  return paths.map((entry) => `\`${entry}\``).join("\n");
}

function formatUnknownPathBehavior(
  behavior: SettingsReadModel["projectScope"]["unknownPathBehavior"],
): string {
  switch (behavior) {
    case "review":
      return "Review";
    case "deny":
      return "Deny";
  }
}

function markdownTable(rows: readonly SettingsRow[]): string {
  return [
    "| Setting | Value | Meaning |",
    "|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${escapeCell(row.label)} | ${escapeCell(row.value)} | ${escapeCell(row.meaning ?? "")} |`,
    ),
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "; ");
}
