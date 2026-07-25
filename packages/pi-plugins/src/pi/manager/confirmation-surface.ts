import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { projectTerminalText } from "./pi-terminal-text.js";

export type ConfirmationSurfaceRequest = Readonly<{
  title: string;
  lines: readonly string[];
  disclosure?: readonly string[];
}>;

export class ConfirmationSurface implements Component {
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly title: string;
  private readonly lines: readonly string[];
  private readonly disclosure: readonly string[];
  private readonly height: () => number;
  private disclosed = false;
  private offset = 0;
  private maxOffset = 0;
  private done: ((confirmed: boolean) => void) | undefined;
  private disposed = false;

  constructor(input: Readonly<{
    theme: Theme;
    keybindings: KeybindingsManager;
    title: string;
    lines: readonly string[];
    disclosure?: readonly string[];
    height?(): number;
    done(confirmed: boolean): void;
  }>) {
    this.theme = input.theme;
    this.keybindings = input.keybindings;
    this.title = projectTerminalText(input.title, 256).text;
    this.lines = Object.freeze(input.lines.map((line) => projectTerminalText(line, 2_048).text));
    this.disclosure = Object.freeze((input.disclosure ?? []).map((line) => projectTerminalText(line, 4_096).text));
    this.height = input.height ?? (() => 20);
    this.done = input.done;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const page = Math.max(1, this.height() - 3);
    // Accept is one keystroke. The exact disclosure stays one Space away for
    // review, but reading it is the user's choice — gating confirm on
    // "expand, then scroll to the exact end" read as a broken dialog.
    if (data === "y" || data === "Y" || this.keybindings.matches(data, "tui.select.confirm")) this.finish(true);
    else if (data === "n" || data === "N" || this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) this.finish(false);
    else if (data === " " && this.disclosure.length > 0) {
      this.disclosed = !this.disclosed;
      this.offset = 0;
    } else if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) this.offset = Math.min(this.maxOffset, this.offset + 1);
    else if (this.keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - page);
    else if (this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) this.offset = Math.min(this.maxOffset, this.offset + page);
  }

  private finish(value: boolean): void {
    const done = this.done;
    if (done === undefined) return;
    this.done = undefined;
    this.disposed = true;
    done(value);
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const height = Math.max(4, this.height());
    const innerWidth = Math.max(1, width - 2);
    const content = [
      this.theme.fg("warning", this.theme.bold(this.title)),
      "",
      ...this.lines,
      ...(this.disclosure.length === 0 ? [] : this.disclosed
        ? [this.theme.fg("accent", "Exact executable disclosure"), ...this.disclosure]
        : [this.theme.fg("muted", "Space: show exact skills, hook commands, MCP process/tools, and requirements")]),
    ].flatMap((line) => wrapTextWithAnsi(line, innerWidth))
      .map((line) => truncateToWidth(line, innerWidth, ""));
    const bodyHeight = Math.max(1, height - 3);
    this.maxOffset = Math.max(0, content.length - bodyHeight);
    this.offset = Math.min(this.offset, this.maxOffset);
    const hints = ["y confirm", "n cancel"];
    if (this.disclosure.length > 0) hints.push(this.disclosed ? "space hide details" : "space details");
    if (this.maxOffset > 0) hints.push("↑/↓ scroll");
    const confirm = hints.join(" · ");
    const boundedWidth = Math.max(1, width);
    const border = this.theme.fg("borderAccent", "─".repeat(boundedWidth));
    const indent = boundedWidth > 1 ? " " : "";
    const body = content.slice(this.offset, this.offset + bodyHeight)
      .map((line) => truncateToWidth(`${indent}${line}`, boundedWidth, ""));
    return [border, ...body, truncateToWidth(this.theme.fg("dim", `${indent}${confirm}`), boundedWidth, ""), border];
  }

  invalidate(): void {}
  dispose(): void { this.done = undefined; this.disposed = true; }
}

/** Open a fresh confirmation component; cancellation never implies approval. */
export async function presentConfirmationSurface(
  context: ExtensionCommandContext,
  request: ConfirmationSurfaceRequest,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  let settle: ((confirmed: boolean) => void) | undefined;
  const abort = () => settle?.(false);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await context.ui.custom<boolean>((tui, theme, keybindings, done) => {
      settle = done;
      return new ConfirmationSurface({ ...request, theme, keybindings, height: () => tui.terminal.rows, done });
    });
  } finally {
    signal.removeEventListener("abort", abort);
    settle = undefined;
  }
}
