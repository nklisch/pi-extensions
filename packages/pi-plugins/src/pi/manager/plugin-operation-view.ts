import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { NativeControlEnvelope } from "../../application/native-control-contract.js";
import { TrustedInstallActivationResultSchema } from "../../application/trusted-install-contract.js";
import { NativeControlFrameSchema, type NativeControlFrame } from "../../application/native-control-progress.js";
import { nativeControlHumanLines } from "../native-control-human.js";
import { plainLifecycleFailure } from "../plain-language.js";
import { styledNativeControlStatusLine } from "./plugin-manager-status.js";
import { projectTerminalText } from "./pi-terminal-text.js";

function safe(value: unknown, limit = 2_048): string {
  return projectTerminalText(typeof value === "string" ? value : String(value ?? ""), limit).text;
}

export class PluginOperationView implements Component {
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly height: () => number;
  private readonly title: string;
  private cancel: (() => void) | undefined;
  private close: (() => void) | undefined;
  private frames: NativeControlFrame[] = [];
  private envelope: NativeControlEnvelope | undefined;
  private offset = 0;
  private cancellationRequested = false;
  private disposed = false;
  private inline: Readonly<{ component: Component; finish(value?: unknown): void }> | undefined;
  private readonly tui: TUI | undefined;

  constructor(input: Readonly<{
    theme: Theme;
    keybindings: KeybindingsManager;
    height(): number;
    title?: string;
    cancel(): void;
    close?(): void;
    tui?: TUI;
  }>) {
    this.theme = input.theme;
    this.keybindings = input.keybindings;
    this.height = input.height;
    this.title = safe(input.title ?? "Plugin operation", 256);
    this.cancel = input.cancel;
    this.close = input.close;
    this.tui = input.tui;
  }

  /**
   * Mount a child inside this surface. Pi's ui.custom does not stack — a
   * nested custom would replace this view and never restore it — so input
   * custody collected mid-operation mounts inline and yields this slot back.
   */
  presentInline<T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (value?: T) => void) => Component): Promise<T | undefined> {
    const tui = this.tui;
    if (this.disposed || this.inline !== undefined || tui === undefined) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value?: unknown): void => {
        if (settled) return;
        settled = true;
        const current = this.inline;
        this.inline = undefined;
        (current?.component as (Component & { dispose?(): void }) | undefined)?.dispose?.();
        tui.requestRender();
        resolve(value as T | undefined);
      };
      const component = factory(tui, this.theme, this.keybindings, finish);
      this.inline = Object.freeze({ component, finish });
      tui.requestRender();
    });
  }

  push(frameInput: NativeControlFrame): void {
    if (this.disposed) return;
    const frame = NativeControlFrameSchema.parse(frameInput);
    this.frames.push(frame);
    if (this.frames.length > 200) this.frames.splice(0, this.frames.length - 200);
    if (frame.type === "result") this.envelope = frame.result;
  }

  finish(envelope: NativeControlEnvelope): void {
    if (this.disposed) return;
    // The schema-validated final envelope is stronger than any prior progress
    // or local cancellation request and is always rendered last.
    this.envelope = envelope;
  }

  private content(): string[] {
    const lines = [this.theme.fg("accent", this.theme.bold(this.title))];
    for (const frame of this.frames) {
      if (frame.type === "accepted") lines.push(`#${frame.sequence} accepted ${safe(frame.command)}`);
      else if (frame.type === "progress") lines.push(`#${frame.sequence} ${safe(frame.phase)} ${safe(frame.state)}${frame.code === undefined ? "" : ` ${safe(frame.code)}`}`);
    }
    if (this.cancellationRequested && this.envelope === undefined) {
      lines.push(this.theme.fg("warning", "Cancelling — waiting for the plugin host to confirm."));
    }
    if (this.envelope !== undefined) {
      // Plain status only: command ids and exit classes stay in machine
      // output, never in the terminal read-out.
      lines.push(this.theme.fg("accent", "Result"));
      lines.push(styledNativeControlStatusLine(this.theme, this.envelope.status));
      const install = TrustedInstallActivationResultSchema.safeParse(this.envelope.data);
      if (install.success) {
        lines.push(this.theme.fg("accent", "Activation result"));
        if (install.data.kind === "succeeded") {
          const components = install.data.components;
          const inventory = [
            `${components.skills} skill${components.skills === 1 ? "" : "s"}`,
            `${components.hooks} hook${components.hooks === 1 ? "" : "s"}`,
            `${components.mcpServers} MCP server${components.mcpServers === 1 ? "" : "s"}`,
          ].join(", ");
          lines.push(`${safe(install.data.plugin)} is ready to use — ${inventory}`);
        } else if (install.data.kind === "recovery-required") lines.push("setup didn't finish — restart pi and it finishes automatically (/plugins doctor shows what's pending)");
        else if (install.data.kind === "rolled-back") lines.push(`couldn't finish — ${plainLifecycleFailure(install.data.failure)} · ${install.data.restored ? "the change was undone" : "check /plugins → Health"}`);
        else if (install.data.kind === "stale" || install.data.kind === "conflict") lines.push("things changed — refresh and try again");
        if ("progress" in install.data) for (const event of install.data.progress) lines.push(`#${event.sequence} ${safe(event.phase)} ${safe(event.state)}${event.code === undefined ? "" : ` ${safe(event.code)}`}`);
        for (const diagnostic of this.envelope.diagnostics) lines.push(`${safe(diagnostic.severity)} ${safe(diagnostic.code)} · ${safe(diagnostic.action)}`);
      } else {
        lines.push(...nativeControlHumanLines(this.envelope).map((line) => safe(line)));
      }
    }
    lines.push(this.theme.fg("dim", this.envelope === undefined ? "Escape cancels once and waits" : "enter/esc close"));
    return lines;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.inline !== undefined) {
      this.inline.component.handleInput?.(data);
      this.tui?.requestRender();
      return;
    }
    if (this.envelope !== undefined && (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter))) {
      // A finished result is a read-out, not a dialog: Enter dismisses it
      // exactly like Escape and drops the user back at the terminal.
      this.close?.();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) {
      if (this.envelope !== undefined) this.close?.();
      else if (!this.cancellationRequested) {
        this.cancellationRequested = true;
        this.cancel?.();
      }
    }
    // No scroll keys: the view always shows the live tail (latest progress +
    // final result). The old bottom-anchored offset moved the window in a way
    // that read as "arrows push lines off the screen and nothing is selected".
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    if (this.inline !== undefined) {
      const height = Math.max(1, this.height());
      const child = this.inline.component.render(width).slice(0, Math.max(1, height - 2));
      return [
        this.theme.fg("accent", this.theme.bold(this.title)),
        ...child,
        this.theme.fg("dim", "esc back/cancel"),
      ].slice(0, height);
    }
    const wrapped = this.content().flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))
      .map((line) => truncateToWidth(line, Math.max(1, width), ""));
    const height = Math.max(1, this.height());
    if (wrapped.length <= height) return wrapped;
    const omitted = wrapped.length - height + 1;
    return [this.theme.fg("dim", `… ${omitted} earlier line${omitted === 1 ? "" : "s"} omitted`), ...wrapped.slice(omitted)];
  }

  invalidate(): void {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inline?.finish();
    this.inline = undefined;
    this.cancel = undefined;
    this.close = undefined;
    this.frames = [];
    this.envelope = undefined;
  }
}
