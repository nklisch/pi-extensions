/** Pure presentation for the joined/detached launch result. */

import type { AgentDetails, Theme } from "#src/ui/display";
import { formatModelThinking, formatMs, formatTurns, SPINNER } from "#src/ui/display";

export function renderAgentResult(details: AgentDetails, resultText: string, expanded: boolean, isPartial: boolean, theme: Theme): string {
  if (isPartial || details.status === "running" || details.status === "queued") return renderRunning(details, theme);
  if (details.status === "completed") return renderCompleted(details, resultText, expanded, theme);
  if (details.status === "stopped") return renderStopped(details, theme);
  return renderFailed(details, theme);
}

export function renderRunning(details: AgentDetails, theme: Theme): string {
  const frame = SPINNER[details.spinnerFrame ?? 0];
  const stats = renderStats(details, theme);
  const duration = theme.fg("dim", formatMs(details.durationMs));
  return theme.fg("accent", frame) + (stats ? " " + stats : "") + " " + duration + "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
}

export function renderCompleted(details: AgentDetails, resultText: string, expanded: boolean, theme: Theme): string {
  let line = theme.fg("success", "✓") + " " + renderStats(details, theme) + " " + theme.fg("dim", "·") + " " + theme.fg("dim", formatMs(details.durationMs));
  if (expanded) {
    for (const item of resultText.split("\n").slice(0, 50)) line += "\n" + theme.fg("dim", `  ${item}`);
    if (resultText.split("\n").length > 50) line += "\n" + theme.fg("muted", "  ... (output truncated; use get_subagent_result for the bounded final output)");
  } else {
    line += "\n" + theme.fg("dim", `  ⎿  ${details.terminalReason === "turn_limit_graceful" ? "Completed (turn limit)" : "Done"}`);
  }
  return line;
}

export function renderStopped(details: AgentDetails, theme: Theme): string {
  return theme.fg("dim", "■") + " " + renderStats(details, theme) + " " + theme.fg("dim", "·") + " " + theme.fg("dim", formatMs(details.durationMs)) + "\n" + theme.fg("dim", `  ⎿  Stopped${details.terminalReason ? ` (${details.terminalReason.replaceAll("_", " ")})` : ""}`);
}

export function renderFailed(details: AgentDetails, theme: Theme): string {
  return theme.fg("error", "✗") + " " + renderStats(details, theme) + " " + theme.fg("dim", "·") + " " + theme.fg("dim", formatMs(details.durationMs)) + "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
}

export function renderStats(details: AgentDetails, theme: Theme): string {
  const parts: string[] = [formatModelThinking(details.modelName ?? "unknown model", details.thinkingLevel)];
  if (details.tags) parts.push(...details.tags.filter((tag) => !tag.startsWith("thinking: ")));
  if (details.turnCount != null && details.turnCount > 0) parts.push(formatTurns(details.turnCount, details.maxTurns));
  if (details.toolUses > 0) parts.push(`${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
  if (details.tokens) parts.push(details.tokens);
  return parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
}
