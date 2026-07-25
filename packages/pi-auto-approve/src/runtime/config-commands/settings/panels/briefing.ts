import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ReviewNoteMode } from "../../../../config/schema.ts";
import { detectReviewDecisionDisplayCapability } from "../../../review-decision-display.ts";
import type { SettingsPanel, SettingsRow } from "../panels.ts";
import type {
  SettingsBriefingFallbackSurface,
  SettingsBriefingRow,
  SettingsReadModel,
} from "../read-model.ts";

const REVIEW_NOTE_MODE_COPY = {
  "reason+accent": {
    label: "Reason + accent",
    preview: "Auto-reviewer: model allowed — installs dev deps",
    meaning: "Reason text plus the warm model-review accent on the call.",
  },
  "accent-only": {
    label: "Accent only",
    preview: "Gold accent on the tool call; no reason text.",
    meaning:
      "Shows only the visual model-review accent when the runtime can render it.",
  },
  "reason+model": {
    label: "Reason + model",
    preview: "Auto-reviewer: model allowed — installs dev deps (zai/glm-5.2)",
    meaning: "Reason text plus the resolved reviewer model label.",
  },
  off: {
    label: "Off",
    preview: "No inline note or accent.",
    meaning: "Audit, model review, and human prompts are unaffected.",
  },
} as const satisfies Record<
  ReviewNoteMode,
  { readonly label: string; readonly preview: string; readonly meaning: string }
>;

export const BRIEFING_PANEL: SettingsPanel = {
  id: "briefing",
  title: "Briefing display",
  rows: briefingRows,
  actions: ["briefing.open"],
};

export function briefingRows(model: SettingsReadModel): readonly SettingsRow[] {
  return [
    {
      label: "Stream briefing mode",
      value: formatReviewNoteModeLabel(model.briefing.mode),
      meaning: model.briefing.note,
    },
    {
      label: "Show reviewer model",
      value: yesNo(model.briefing.showModelLabel),
      meaning:
        "Include the reviewer model in the note detail; toggles write global.json after confirmation.",
    },
    {
      label: "Stream accent",
      value: yesNo(model.briefing.accent),
      meaning:
        "Gold accent on model-allowed calls where the Pi host supports it; toggles write global.json after confirmation.",
    },
  ];
}

export function renderBriefingPanel(
  model: SettingsReadModel,
  ctx?: ExtensionContext,
): string {
  return renderBriefingRowPanel(model.briefing, ctx);
}

export function renderBriefingRowPanel(
  briefing: SettingsBriefingRow,
  ctx?: ExtensionContext,
): string {
  return renderBriefingExplanationMarkdown({
    briefing: withRuntimeFallback(briefing, ctx),
  });
}

export function renderBriefingExplanationMarkdown(input: {
  readonly briefing: SettingsBriefingRow;
}): string {
  const lines = [
    "# Stream briefing",
    "",
    `- Current mode: **${formatReviewNoteModeLabel(input.briefing.mode)}**`,
    `- Show reviewer model: **${yesNo(input.briefing.showModelLabel)}**`,
    `- Stream accent: **${yesNo(input.briefing.accent)}**`,
    `- Fallback surface: **${formatFallbackSurface(input.briefing.fallbackSurface)}**`,
    "- Status: **configurable now**",
    `- Meaning: ${input.briefing.note}`,
    "",
    "## Mode previews",
    ...modePreviewLines(input.briefing.mode),
  ];

  const fallbackNote = fallbackSurfaceNote(input.briefing.fallbackSurface);
  if (fallbackNote !== undefined) {
    lines.push("", fallbackNote);
  }

  lines.push(
    "",
    "`briefing.open` only renders this panel; the briefing actions write user-owned global.json after confirmation.",
  );

  return lines.join("\n");
}

export function formatReviewNoteModeLabel(mode: ReviewNoteMode): string {
  return REVIEW_NOTE_MODE_COPY[mode].label;
}

export function formatBriefingStyle(mode: ReviewNoteMode): string {
  return formatReviewNoteModeLabel(mode);
}

function withRuntimeFallback(
  briefing: SettingsBriefingRow,
  ctx: ExtensionContext | undefined,
): SettingsBriefingRow {
  if (ctx === undefined) return briefing;
  return {
    ...briefing,
    fallbackSurface: detectReviewDecisionDisplayCapability(ctx),
  };
}

function modePreviewLines(activeMode: ReviewNoteMode): readonly string[] {
  return (Object.keys(REVIEW_NOTE_MODE_COPY) as readonly ReviewNoteMode[]).map(
    (mode) => {
      const copy = REVIEW_NOTE_MODE_COPY[mode];
      const defaultSuffix = mode === "reason+accent" ? " *(default)*" : "";
      const currentSuffix = mode === activeMode ? " *(current)*" : "";
      return `- **${copy.label}** — \`${copy.preview}\` — ${copy.meaning}${defaultSuffix}${currentSuffix}`;
    },
  );
}

function fallbackSurfaceNote(
  surface: SettingsBriefingFallbackSurface,
): string | undefined {
  if (surface === "tool-call-accent" || surface === "unknown") {
    return undefined;
  }
  return `Pi does not expose a tool-call accent hook in this build; the accent intent is rendered via \`${surface}\` instead.`;
}

function formatFallbackSurface(
  surface: SettingsBriefingFallbackSurface,
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
    case "unknown":
      return "unknown";
  }
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}
