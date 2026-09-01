import { Text } from "@earendil-works/pi-tui";
import type { NotificationDetails } from "#src/observation/notification";
import { formatModelThinking, formatMs, formatTokens, formatTurns } from "#src/ui/display";

interface RendererTheme {
  fg(style: string, text: string): string;
  bold(text: string): string;
}
interface RendererMessage { details?: NotificationDetails; }
interface RenderOptions { expanded: boolean; }

export function createNotificationRenderer() {
  return (message: RendererMessage, { expanded }: RenderOptions, theme: RendererTheme): Text | undefined => {
    const d = message.details;
    if (!d) return undefined;
    const stopped = d.status === "stopped" || d.status === "error";
    const icon = stopped ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const statusText = d.status === "error"
      ? `Error: ${d.error ?? "unknown"}`
      : d.terminalReason === "turn_limit_graceful"
        ? "completed (turn limit)"
        : d.status === "stopped" && d.terminalReason
          ? `stopped (${d.terminalReason})`
          : d.status;
    let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;
    const parts: string[] = [formatModelThinking(d.modelLabel, d.thinkingLevel)];
    if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
    if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
    if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
    if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
    line += "\n  " + parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
    if (expanded) {
      for (const item of d.resultPreview.split("\n").slice(0, 30)) line += "\n" + theme.fg("dim", `  ${item}`);
    } else {
      line += "\n  " + theme.fg("dim", `⎿  ${d.resultPreview.split("\n")[0]?.slice(0, 80) ?? ""}`);
    }
    if (d.outputFile) line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
    return new Text(line, 0, 0);
  };
}
