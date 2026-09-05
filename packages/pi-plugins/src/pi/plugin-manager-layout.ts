import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function padManagerLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** A theme-native shell separates the custom manager from Pi's transcript/footer. */
export function framePluginManager(lines: readonly string[], width: number, theme: Theme): string[] {
  if (width < 1) return [];
  if (width < 4) {
    const border = theme.fg("borderAccent", "─".repeat(width));
    return [border, ...lines.map((line) => truncateToWidth(line, width, "")), border];
  }
  const inside = width - 2;
  const title = truncateToWidth("─ Plugins ", inside, "");
  const top = theme.fg("borderAccent", `╭${title}${"─".repeat(inside - visibleWidth(title))}╮`);
  const side = theme.fg("border", "│");
  return [
    top,
    ...lines.map((line) => `${side} ${padManagerLine(line, width - 4)} ${side}`),
    theme.fg("borderAccent", `╰${"─".repeat(inside)}╯`),
  ];
}
