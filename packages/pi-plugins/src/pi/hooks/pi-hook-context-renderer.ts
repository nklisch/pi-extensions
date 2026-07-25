import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { projectTerminalText } from "../manager/pi-terminal-text.js";

/**
 * Presentation metadata attached to each model-bound hook context message.
 * `content` stays the exact injected text (it is what the model receives);
 * details only drive how the transcript renders it.
 */
export type HookContextMessageDetails = Readonly<{
  plugin: string;
  event: string;
  presentation: "line" | "full";
}>;

function formatSize(chars: number): string {
  if (chars < 1_000) return `${chars} chars`;
  return `${(chars / 1_000).toFixed(1)}k chars`;
}

/**
 * Terminal-safe but structure-preserving: projectTerminalText flattens every
 * C0 scalar including LF, which would render multiline context as one
 * replacement-char stew. Lines are projected individually under a shared
 * budget sized to the aggregate hook-output limit, so accepted model context
 * is never cut by the transcript.
 */
const HOOK_CONTEXT_RENDER_BUDGET = 262_144;

function sanitizeMultiline(raw: string): string {
  const out: string[] = [];
  let remaining = HOOK_CONTEXT_RENDER_BUDGET;
  for (const line of raw.split("\n")) {
    if (remaining <= 0) break;
    const projected = projectTerminalText(line, remaining).text;
    out.push(projected);
    remaining -= projected.length + 1;
  }
  return out.join("\n");
}

/**
 * Collapsed: one attribution line per contribution. Expanded (or sent with
 * `full` presentation): the exact text the model received, sanitized for the
 * terminal — the transcript must never be a better injection channel than
 * the hook boundary itself.
 */
export const renderHookContextMessage: MessageRenderer<HookContextMessageDetails> = (message, options, theme) => {
  const details = message.details ?? { plugin: "unknown plugin", event: "hook", presentation: "line" as const };
  const plugin = projectTerminalText(details.plugin, 64).text;
  const event = projectTerminalText(details.event, 48).text;
  const raw = typeof message.content === "string"
    ? message.content
    : message.content.map((block) => block.type === "text" ? block.text : "[image]").join("");
  if (options.expanded || details.presentation === "full") {
    const content = sanitizeMultiline(raw);
    return new Text(`${theme.fg("accent", `⚙ ${plugin} · ${event} · hook added this to model context`)}\n${content}`, 0, 0);
  }
  return new Text(theme.fg("muted", `⚙ ${plugin} · ${event} → +${formatSize(raw.length)} to model context · expand to view`), 0, 0);
};
