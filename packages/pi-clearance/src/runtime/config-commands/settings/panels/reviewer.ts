import type { SettingsPanel, SettingsRow } from "../panels.ts";
import type { SettingsReadModel } from "../read-model.ts";

export const REVIEWER_PANEL: SettingsPanel = {
  id: "reviewer",
  title: "Reviewer",
  rows: reviewerRows,
  actions: ["reviewer.model", "reviewer.open"],
};

export function reviewerRows(model: SettingsReadModel): readonly SettingsRow[] {
  const reviewer = model.status.reviewer;
  return [
    {
      label: "Mode",
      value: model.currentMode.label,
      meaning: model.currentMode.description,
    },
    {
      label: "Reviewer path",
      value: reviewer.path,
      meaning: reviewer.consequence,
    },
    {
      label: "Configured model",
      value: reviewer.configuredModel ?? "not configured",
    },
    {
      label: "Resolved model",
      value: reviewer.resolvedModel ?? "not resolved",
      meaning: `source: ${reviewer.resolvedModelSource}${reviewer.resolvedModelNote === undefined ? "" : `; ${reviewer.resolvedModelNote}`}`,
    },
    {
      label: "Prompt posture",
      value: reviewer.promptPosture,
      meaning: "Edit advanced reviewer settings in global.json.",
    },
    {
      label: "Context mode",
      value: reviewer.contextMode,
      meaning: "Edit advanced reviewer settings in global.json.",
    },
    { label: "Token budget", value: formatTokenBudget(reviewer.tokenBudget) },
    { label: "Escalation", value: formatEscalation(reviewer.escalation) },
  ];
}

export function renderReviewerPanel(model: SettingsReadModel): string {
  return [
    "# Reviewer settings",
    "",
    markdownTable(reviewerRows(model)),
    "",
    "Model selection is interactive. Other reviewer settings are read-only here; edit global.json.",
  ].join("\n");
}

export function renderReviewerAdvancedPanel(model: SettingsReadModel): string {
  return renderReviewerPanel(model);
}

function formatTokenBudget(
  value: SettingsReadModel["status"]["reviewer"]["tokenBudget"],
): string {
  if (value === undefined) return "not available";
  return `${value.limit === null ? "unlimited" : value.limit} per ${value.window}`;
}
function formatEscalation(
  value: SettingsReadModel["status"]["reviewer"]["escalation"],
): string {
  if (value === undefined) return "not available";
  return `${value.enabled ? "on" : "off"}; denial limit ${value.denialLimit} per ${value.window}`;
}
function markdownTable(rows: readonly SettingsRow[]): string {
  return [
    "| Setting | Value | Meaning |",
    "|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.label.replaceAll("|", "\\|")} | ${row.value.replaceAll("|", "\\|")} | ${(row.meaning ?? "").replaceAll("|", "\\|")} |`,
    ),
  ].join("\n");
}
