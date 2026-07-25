import type {
  ResolvedProjectScope,
  ResolvedReviewNotePreference,
} from "../../../config/loader.ts";
import type { ClearanceMode } from "../../../config/schema.ts";
import type { AutoReviewerStatusView } from "../../auto-reviewer-read-models.ts";
import type { ReviewDecisionDisplayCapability } from "../../review-decision-display.ts";
import type { SettingsActionId } from "./actions.ts";

export interface SettingsModeCopy {
  readonly mode: ClearanceMode;
  readonly label: string;
  readonly description: string;
}

export type SettingsBriefingFallbackSurface =
  | ReviewDecisionDisplayCapability
  | "unknown";

export interface SettingsBriefingRow {
  readonly mode: ResolvedReviewNotePreference["mode"];
  readonly showModelLabel: boolean;
  readonly accent: boolean;
  readonly configurable: true;
  readonly fallbackSurface: SettingsBriefingFallbackSurface;
  readonly note: string;
}

export interface SettingsProjectScope extends ResolvedProjectScope {
  readonly safeHomeUseDefaults?: boolean;
  readonly agentSupportUseDefaults?: boolean;
}

/** A pack row for the settings pack explorer. */
export interface SettingsPackRow {
  readonly id: string;
  readonly title: string;
  readonly enabled: boolean;
  /** Only package packs can be toggled; baseline, floor, and config packs are fixed here. */
  readonly toggleable: boolean;
  readonly source: string;
  /** Enablement scopes from user-owned config; drives the toggle's target scope. */
  readonly enabledInGlobal: boolean;
  readonly enabledInProject: boolean;
}

/** A reviewer model option for the settings reviewer panel. */
export interface SettingsReviewerModelOption {
  /** Canonical provider/modelId spec written to config. */
  readonly spec: string;
  readonly label: string;
}

export interface SettingsPanelDescriptor {
  readonly id: "reviewer" | "scope" | "packs" | "briefing";
  readonly title: string;
  readonly summary: string;
  readonly drillActionId: SettingsActionId;
}

export interface SettingsReadModel {
  readonly modes: readonly SettingsModeCopy[];
  readonly currentMode: SettingsModeCopy;
  readonly status: AutoReviewerStatusView;
  readonly projectScope: SettingsProjectScope;
  readonly briefing: SettingsBriefingRow;
  readonly packs: readonly SettingsPackRow[];
  readonly reviewerModels: readonly SettingsReviewerModelOption[];
  readonly panels: readonly SettingsPanelDescriptor[];
}

export const SETTINGS_MODE_COPIES = [
  {
    mode: "off",
    label: "Off",
    description:
      "Nothing is asked or reviewed; catastrophic commands and your deny rules still block.",
  },
  {
    mode: "ask",
    label: "Ask",
    description:
      "Known-safe commands run automatically; anything else asks you. No model is called.",
  },
  {
    mode: "auto",
    label: "Auto",
    description:
      "Known-safe commands run automatically; a model reviews the rest before asking you.",
  },
] as const satisfies readonly SettingsModeCopy[];

export const DEFAULT_REVIEW_NOTE_PREFERENCE = {
  mode: "reason+accent",
  showModelLabel: false,
  accent: true,
} as const satisfies ResolvedReviewNotePreference;

export const DEFAULT_SETTINGS_BRIEFING_ROW = buildSettingsBriefingRow(
  DEFAULT_REVIEW_NOTE_PREFERENCE,
);

const SETTINGS_PANEL_DESCRIPTORS = [
  {
    id: "reviewer",
    title: "Reviewer",
    summary:
      "Configured model and prompt details (read-only except model selection).",
    drillActionId: "reviewer.open" as const,
  },
  {
    id: "scope",
    title: "Project scope",
    summary: "Safe Zones, writable project paths, temp paths, and No-Go Zones.",
    drillActionId: "scope.open" as const,
  },
  {
    id: "packs",
    title: "Pack explorer",
    summary: "Baseline and configured policy packs.",
    drillActionId: "packs.open" as const,
  },
  {
    id: "briefing",
    title: "Stream briefing",
    summary:
      "Inline review-note display preferences: reason text, model label, accent, or off.",
    drillActionId: "briefing.open" as const,
  },
] as const satisfies readonly SettingsPanelDescriptor[];

export function buildSettingsReadModel(input: {
  readonly status: AutoReviewerStatusView;
  readonly projectScope: SettingsProjectScope;
  readonly reviewNoteDisplay?: ResolvedReviewNotePreference;
  readonly packs?: readonly SettingsPackRow[];
  readonly reviewerModels?: readonly SettingsReviewerModelOption[];
}): SettingsReadModel {
  const currentMode = SETTINGS_MODE_COPIES.find(
    (mode) => mode.mode === input.status.mode,
  );
  if (currentMode === undefined)
    throw new Error(`unknown clearance mode: ${input.status.mode}`);
  return {
    modes: SETTINGS_MODE_COPIES.map((mode) => ({ ...mode })),
    currentMode: { ...currentMode },
    status: input.status,
    projectScope: input.projectScope,
    briefing: buildSettingsBriefingRow(
      input.reviewNoteDisplay ?? DEFAULT_REVIEW_NOTE_PREFERENCE,
    ),
    packs: input.packs ?? [],
    reviewerModels: input.reviewerModels ?? [],
    panels: SETTINGS_PANEL_DESCRIPTORS.map((panel) => ({ ...panel })),
  };
}

function buildSettingsBriefingRow(
  preference: ResolvedReviewNotePreference,
): SettingsBriefingRow {
  return {
    ...preference,
    configurable: true,
    fallbackSurface: "unknown",
    note: "Inline review-note display; changes write global.json after confirmation.",
  };
}
