import { formatTuneCueStatus } from "../tune-cue.ts";
import type { SettingsActionId } from "./actions.ts";
import { BRIEFING_PANEL } from "./panels/briefing.ts";
import { PACKS_PANEL } from "./panels/packs.ts";
import { REVIEWER_PANEL } from "./panels/reviewer.ts";
import { SCOPE_PANEL } from "./panels/scope.ts";
import type {
  SettingsPanelDescriptor,
  SettingsReadModel,
} from "./read-model.ts";

export interface SettingsPanel {
  readonly id: SettingsPanelDescriptor["id"];
  readonly title: string;
  readonly rows: (model: SettingsReadModel) => readonly SettingsRow[];
  readonly actions: readonly SettingsActionId[];
}

export interface SettingsRow {
  readonly label: string;
  readonly value: string;
  readonly meaning?: string;
}

export const SETTINGS_PANELS = [
  REVIEWER_PANEL,
  SCOPE_PANEL,
  PACKS_PANEL,
  BRIEFING_PANEL,
] as const satisfies readonly SettingsPanel[];

export function renderControlCenter(model: SettingsReadModel): string {
  const rows: readonly SettingsRow[] = [
    {
      label: "Clearance mode",
      value: model.currentMode.label,
      meaning: model.currentMode.description,
    },
    {
      label: "Tune mode",
      value: formatTuneCueStatus(model.status.ratchet.active),
      meaning: "Temporary Tune tools are inactive unless enabled.",
    },
    {
      label: "Reviewer",
      value: model.status.reviewer.path,
      meaning: model.status.reviewer.consequence,
    },
    {
      label: "Built-in writes",
      value: "Project scope",
      meaning:
        "Typed edit/write can clear inside proven Safe Zones; No-Go Zones still block.",
    },
    ...BRIEFING_PANEL.rows(model),
  ];
  return [
    "# Clearance Desk settings",
    "",
    "## Current mode",
    markdownTable(rows),
    "",
    "## Mode choices",
    markdownTable(
      model.modes.map((mode) => ({
        label: mode.label,
        value: mode.mode,
        meaning: mode.description,
      })),
    ),
    "",
    "## Details",
    ...model.panels.map(
      (panel) =>
        `- ${panel.title}: ${panel.summary} (drill: \`${panel.drillActionId}\`)`,
    ),
  ].join("\n");
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
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
