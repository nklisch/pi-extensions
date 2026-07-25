import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { projectTerminalText } from "./pi-terminal-text.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (value: string): string[] => [...segmenter.segment(value)].map((part) => part.segment);

function pastedText(data: string): string | undefined {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  if (data.startsWith(start) && data.endsWith(end)) return data.slice(start.length, -end.length);
  return undefined;
}

function ordinaryText(data: string): string | undefined {
  if (data.length === 0 || data.includes("\u001b") || /[\u0000-\u001f\u007f-\u009f]/u.test(data)) return undefined;
  const projected = projectTerminalText(data, 512);
  return projected.escaped ? undefined : projected.text;
}

/**
 * Plaintext field editor for custom-component surfaces. Pi's own `ui.input`
 * cannot receive keystrokes while a custom component owns the keyboard, so
 * configuration values are edited inline like every other manager surface.
 */
export class TextInputSurface implements Component, Focusable {
  focused = false;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly label: string;
  private readonly description: string | undefined;
  private done: ((result: string | undefined) => void) | undefined;
  private buffer: string[];
  private cursor: number;
  private disposed = false;

  constructor(input: Readonly<{
    theme: Theme;
    keybindings: KeybindingsManager;
    label: string;
    description?: string;
    initial?: string;
    done(result: string | undefined): void;
  }>) {
    this.theme = input.theme;
    this.keybindings = input.keybindings;
    this.label = input.label;
    this.description = input.description;
    this.done = input.done;
    this.buffer = graphemes(input.initial ?? "");
    this.cursor = this.buffer.length;
  }

  private finish(result: string | undefined): void {
    const done = this.done;
    if (done === undefined) return;
    this.done = undefined;
    this.disposed = true;
    done(result);
  }

  private insert(value: string): void {
    const incoming = graphemes(value);
    this.buffer.splice(this.cursor, 0, ...incoming);
    this.cursor += incoming.length;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) {
      this.finish(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      this.finish(this.buffer.join(""));
      return;
    }
    if (matchesKey(data, Key.left)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.right)) this.cursor = Math.min(this.buffer.length, this.cursor + 1);
    else if (matchesKey(data, Key.home)) this.cursor = 0;
    else if (matchesKey(data, Key.end)) this.cursor = this.buffer.length;
    else if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) {
        this.buffer.splice(this.cursor - 1, 1);
        this.cursor -= 1;
      }
    } else if (matchesKey(data, Key.delete)) {
      if (this.cursor < this.buffer.length) this.buffer.splice(this.cursor, 1);
    } else if (matchesKey(data, Key.ctrl("u"))) {
      this.buffer.splice(0, this.cursor);
      this.cursor = 0;
    } else {
      const paste = pastedText(data);
      const text = paste ?? ordinaryText(data);
      if (text !== undefined) this.insert(text);
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const before = this.buffer.slice(0, this.cursor).join("");
    const at = this.cursor < this.buffer.length ? this.buffer[this.cursor]! : " ";
    const after = this.buffer.slice(this.cursor + 1).join("");
    const cursor = this.focused ? `${CURSOR_MARKER}${this.theme.bg("selectedBg", at)}` : at;
    return [
      truncateToWidth(this.theme.fg("accent", this.theme.bold(this.label)), Math.max(1, width), ""),
      ...(this.description === undefined ? [] : [truncateToWidth(this.theme.fg("muted", this.description), Math.max(1, width), "")]),
      truncateToWidth(`${before}${cursor}${after}`, Math.max(1, width), ""),
      truncateToWidth(this.theme.fg("dim", "enter submit · escape cancel"), Math.max(1, width), ""),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.done = undefined;
    this.buffer = [];
    this.cursor = 0;
    this.disposed = true;
  }
}
