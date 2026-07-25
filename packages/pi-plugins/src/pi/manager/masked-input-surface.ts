import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { SensitiveValue } from "../../application/sensitive-value.js";

export type MaskedInputResult = Readonly<{ kind: "supplied"; value: SensitiveValue }> | Readonly<{ kind: "cancelled" }>;

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
  return data;
}

/** Fresh TUI-only secret editor with no plaintext rendering or value getter. */
export class MaskedInputSurface implements Component, Focusable {
  focused = false;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly label: string;
  private done: ((result: MaskedInputResult) => void) | undefined;
  private buffer: string[] = [];
  private cursor = 0;
  private disposed = false;

  constructor(input: Readonly<{
    theme: Theme;
    keybindings: KeybindingsManager;
    label: string;
    done(result: MaskedInputResult): void;
  }>) {
    this.theme = input.theme;
    this.keybindings = input.keybindings;
    this.label = input.label;
    this.done = input.done;
  }

  private finish(result: MaskedInputResult): void {
    const done = this.done;
    if (done === undefined) return;
    this.done = undefined;
    this.buffer.fill("");
    this.buffer = [];
    this.cursor = 0;
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
      this.finish(Object.freeze({ kind: "cancelled" }));
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const plaintext = this.buffer.join("");
      const value = SensitiveValue.fromUnknown(plaintext);
      this.finish(Object.freeze({ kind: "supplied", value }));
      return;
    }
    if (matchesKey(data, Key.left)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.right)) this.cursor = Math.min(this.buffer.length, this.cursor + 1);
    else if (matchesKey(data, Key.home)) this.cursor = 0;
    else if (matchesKey(data, Key.end)) this.cursor = this.buffer.length;
    else if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) {
        this.buffer[this.cursor - 1] = "";
        this.buffer.splice(this.cursor - 1, 1);
        this.cursor -= 1;
      }
    } else if (matchesKey(data, Key.delete)) {
      if (this.cursor < this.buffer.length) {
        this.buffer[this.cursor] = "";
        this.buffer.splice(this.cursor, 1);
      }
    } else {
      const paste = pastedText(data);
      const text = paste ?? ordinaryText(data);
      if (text !== undefined) this.insert(text);
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const before = "•".repeat(this.cursor);
    const at = this.cursor < this.buffer.length ? "•" : " ";
    const after = "•".repeat(Math.max(0, this.buffer.length - this.cursor - 1));
    const cursor = this.focused ? `${CURSOR_MARKER}${this.theme.bg("selectedBg", at)}` : at;
    return [
      truncateToWidth(this.theme.fg("accent", this.theme.bold(this.label)), Math.max(1, width), ""),
      truncateToWidth(`${before}${cursor}${after}`, Math.max(1, width), ""),
      truncateToWidth(this.theme.fg("dim", "Enter submit · Escape cancel · paste remains masked"), Math.max(1, width), ""),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.done = undefined;
    this.buffer.fill("");
    this.buffer = [];
    this.cursor = 0;
    this.disposed = true;
  }
}
