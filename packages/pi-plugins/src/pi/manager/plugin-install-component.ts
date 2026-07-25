import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { TrustedInstallActivationResult } from "../../application/trusted-install-contract.js";
import { formatMcpEndpoint, projectTerminalText } from "./pi-terminal-text.js";
import { plainLifecycleFailure, plainLifecyclePhase } from "../plain-language.js";
import type { PluginInstallEvent, PluginInstallFocus, PluginInstallState } from "./plugin-install-flow.js";

function safe(value: unknown, limit = 2_048): string {
  return projectTerminalText(typeof value === "string" ? value : String(value ?? ""), limit).text;
}

function focused(state: PluginInstallState, value: PluginInstallFocus): boolean {
  if (typeof value === "string" || typeof state.focus === "string") return state.focus === value;
  return state.focus.field === value.field;
}

/** A render line tagged with the focus entry it belongs to, so the window can follow focus. */
type InstallLine = Readonly<{ text: string; focus?: PluginInstallFocus }>;

function plain(text: string): InstallLine {
  return { text };
}

function choice(state: PluginInstallState, value: PluginInstallFocus, text: string, theme: Theme): InstallLine {
  return { text: focused(state, value) ? theme.bg("selectedBg", `> ${text}`) : `  ${text}`, focus: value };
}

function progressLines(state: PluginInstallState, theme: Theme): string[] {
  if (state.frames.length === 0) return state.busy ? [theme.fg("warning", "Waiting for the plugin host…")] : [];
  const lines = [theme.fg("accent", "Progress")];
  for (const frame of state.frames) {
    if (frame.type === "accepted") lines.push(theme.fg("muted", `#${frame.sequence} accepted`));
    else if (frame.type === "progress") lines.push(`#${frame.sequence} ${plainLifecyclePhase(frame.phase)} · ${safe(frame.state)}`);
  }
  return lines;
}

function resultLines(result: TrustedInstallActivationResult, theme: Theme): string[] {
  const lines = [theme.fg(
    result.kind === "succeeded" || result.kind === "current-state" ? "success" :
      result.kind === "cancelled" || result.kind === "stale" || result.kind === "conflict" ? "warning" : "error",
    result.kind,
  )];
  if (result.kind === "succeeded") {
    lines.push(
      `${safe(result.plugin)} · ${safe(result.scope.kind)} · ${safe(result.revision)}`,
      `${result.components.skills} discoverable skills`,
      `${result.components.hooks} registered hooks`,
      `${result.components.mcpServers} MCP servers ready`,
      "Pi reload and activation observation completed after commit.",
    );
  } else if (result.kind === "current-state") {
    lines.push(`${safe(result.plugin)} already ${safe(result.activation)} · ${safe(result.reason)}`);
  } else if (result.kind === "recovery-required") {
    const culprit = "progress" in result
      ? [...result.progress].reverse().find((event) => event.state === "failed") ?? [...result.progress].reverse().find((event) => event.code !== undefined)
      : undefined;
    lines.push(
      "The plugin was installed, but Pi couldn't confirm it's working yet.",
      ...(culprit === undefined ? [] : [`It stopped during ${plainLifecyclePhase(culprit.phase)}.`]),
      result.action === "run-recovery"
        ? "Press enter to finish setting it up — this is safe to retry."
        : "Press enter to review its settings and finish setup.",
      result.session === undefined
        ? "If this keeps happening, /plugin → Health shows what's pending."
        : "Leaving this screen won't uninstall anything.",
    );
  } else if (result.kind === "rolled-back") {
    lines.push(`It couldn't be added — ${plainLifecycleFailure(result.failure)}. The change was undone${result.restored ? "" : "; check /plugin → Health"}.`);
  } else if (result.kind === "rejected" || result.kind === "failed") {
    lines.push(`It couldn't be added — ${plainLifecycleFailure(result.code)}.`);
  } else if (result.kind === "cancelled") {
    lines.push(`Cancelled during ${plainLifecyclePhase(result.phase)} — nothing was installed.`);
  } else if (result.kind === "stale" || result.kind === "conflict") {
    lines.push("Things changed while installing — go back and try again.");
  } else if (result.kind === "needs-input") {
    lines.push(...result.issues.map((issue) => `${plainLifecycleFailure(issue.code)}${issue.key === undefined ? "" : ` · ${safe(issue.key)}`}`));
  }
  // The live frames already showed progress while the operation ran, and
  // only recovery-required reaches this screen now; re-dumping the full
  // evidence list is the "long unreadable result" users bounce off.
  return lines;
}

function candidateDisclosure(state: PluginInstallState, theme: Theme): string[] {
  const detail = state.candidate;
  const lines = [theme.fg("accent", "Complete component inventory")];
  for (const component of [...detail.compatibility.components.skills, ...detail.compatibility.components.hooks, ...detail.compatibility.components.mcpServers, ...detail.compatibility.components.foreign]) {
    lines.push(`${safe(component.kind)} · ${safe(component.componentId)} · ${safe(component.verdict)}`);
  }
  for (const requirement of detail.compatibility.requirements) {
    lines.push(`requirement ${safe(requirement.capability.text)} · ${safe(requirement.status)} · ${safe(requirement.explanation.text)}`);
  }
  if (lines.length === 1) lines.push("No declared executable components or requirements");
  return lines;
}

function executableDisclosure(state: PluginInstallState, theme: Theme): string[] {
  const session = state.session;
  if (session === undefined) return [];
  const lines = [theme.fg("warning", "Exact executable disclosure")];
  for (const skill of session.consent.components.skills) lines.push(`skill ${safe(skill.name.text)} · ${safe(skill.root.text)} · ${safe(skill.verdict)}`);
  for (const hook of session.consent.components.hooks) {
    lines.push(`hook ${safe(hook.event.text)} · ${safe(hook.handler.command.text)}${hook.handler.kind === "exec" ? ` ${hook.handler.args.map((arg) => safe(arg.text)).join(" ")}` : ""} · ${safe(hook.verdict)}`);
  }
  for (const mcp of session.consent.components.mcpServers) {
    lines.push(`MCP ${safe(mcp.nativeKey.text)} · ${safe(mcp.transport ?? "unavailable")} · ${safe(mcp.command?.text ?? (mcp.url === undefined ? "remote endpoint" : formatMcpEndpoint(mcp.url)))} · ${safe(mcp.verdict)}`);
    lines.push(`  tools: ${mcp.toolPolicy.allowed.map((tool) => safe(tool.text)).join(", ") || "runtime discovery"}`);
  }
  for (const component of session.consent.components.foreign) lines.push(`foreign ${safe(component.nativeHost)} ${safe(component.nativeKind.text)} · ${safe(component.verdict)}`);
  for (const requirement of session.consent.requirements) lines.push(`requirement ${safe(requirement.capability.text)} · ${safe(requirement.status)} · ${safe(requirement.explanation.text)}`);
  if (session.consent.configurationEnvironmentNames.length > 0) lines.push(`configuration environment names: ${session.consent.configurationEnvironmentNames.map((name) => safe(name.text)).join(", ")}`);
  lines.push(`persistent data access: ${session.consent.persistentData ? "declared" : "not declared"}`);
  lines.push(`limitations: subagent interception ${safe(session.consent.subagentInterception)} · remote MCP discovery ${safe(session.consent.remoteMcpDiscovery)}`);
  return lines;
}

type InstallContent = Readonly<{ lines: readonly InstallLine[]; disclosureOffset: number; disclosureCount: number }>;

function installContent(state: PluginInstallState, theme: Theme): InstallContent {
  if (state.step === "choose-inspect") {
    const detail = state.candidate;
    const lines: InstallLine[] = [
      plain(theme.fg("accent", theme.bold("Add plugin"))),
      plain("Adding uses the details you just reviewed."),
      plain(""),
      plain(theme.bold(safe(detail.summary.plugin))),
      plain(`${safe(detail.summary.marketplace.text)} · ${safe(detail.summary.scope.kind)}`),
      plain(`Origin: ${safe(detail.source.kind)} · Revision: ${safe(detail.summary.revision.available?.text ?? detail.summary.revision.immutable ?? "unresolved")}`),
      plain(theme.fg(detail.compatibility.status === "activatable" ? "success" : "error", detail.compatibility.status)),
      plain(""),
      ...progressLines(state, theme).map(plain),
      ...(state.busy ? [plain(theme.fg("accent", "… opening the install session"))] : []),
      plain(""),
      choice(state, "back", "Cancel", theme),
    ];
    return { lines, disclosureOffset: 0, disclosureCount: 0 };
  }
  if (state.step === "configure-trust" && state.session !== undefined) {
    const session = state.session;
    const lines: InstallLine[] = [
      plain(theme.fg("accent", theme.bold("Step 1/2 · Configure and add"))),
      plain("Only required values stand between you and Add. The exact disclosure is optional."),
      plain(""),
      plain(theme.fg("accent", "Plugin configuration")),
    ];
    for (const field of session.fields) {
      const value = state.values[field.key];
      const status = field.sensitive ? "secret (masked custody at apply)" : value === undefined ? safe(field.state) : `set: ${safe(value)}`;
      if (state.editing?.key === field.key) {
        const editing = state.editing;
        const before = safe(editing.buffer.slice(0, editing.cursor));
        const at = editing.cursor < editing.buffer.length ? safe(editing.buffer[editing.cursor]) : " ";
        const after = safe(editing.buffer.slice(editing.cursor + 1));
        lines.push(
          { text: theme.fg("accent", `${safe(field.label.text)} · ${field.required ? "required" : "optional"} · editing`), focus: Object.freeze({ field: field.key }) },
          { text: theme.bg("selectedBg", `> ${before}${CURSOR_MARKER}${at}${after}`), focus: Object.freeze({ field: field.key }) },
          plain(theme.fg("dim", "enter commit · escape cancel")),
        );
        continue;
      }
      lines.push(choice(state, { field: field.key }, `${safe(field.label.text)} · ${field.required ? "required" : "optional"} · ${status}`, theme));
    }
    lines.push(
      plain(""),
      plain(theme.fg("accent", "Executable surface")),
      plain(safe(session.consent.statement.text)),
      plain(`${session.consent.components.counts.skills} skills · ${session.consent.components.counts.hooks} command hooks · ${session.consent.components.counts.mcpServers} MCP servers · persistent data access`),
      choice(state, "disclosure", state.disclosure.has("executable") ? "Collapse exact executable disclosure" : "Review exact executable disclosure (optional)", theme),
    );
    const disclosureOffset = lines.length;
    const disclosure = state.disclosure.has("executable") ? executableDisclosure(state, theme) : [];
    lines.push(...disclosure.map(plain));
    const reviewed = state.consentId === session.consent.consentId;
    lines.push(
      plain(""),
      ...progressLines(state, theme).map(plain),
      ...(state.busy ? [plain("")] : []),
      reviewed
        ? plain(theme.fg("success", "✓ complete executable disclosure reviewed"))
        : plain(theme.fg("muted", "Disclosure stays available above; it is not required to add.")),
      choice(state, "back", "Back", theme),
      choice(state, "continue", state.busy
        ? state.submission === "recover" ? "Finishing setup…" : "Adding…"
        : state.submission === "recover" ? "Finish setup" : "Add plugin", theme),
    );
    return { lines, disclosureOffset, disclosureCount: disclosure.length };
  }
  const recoverySession = state.result?.kind === "recovery-required" && state.result.action !== "run-recovery"
    ? state.result.session
    : undefined;
  return {
    lines: [
      plain(theme.fg("accent", theme.bold("Add plugin · Result"))),
      ...(state.result === undefined ? [plain(theme.fg("warning", "Activation result unavailable"))] : resultLines(state.result, theme).map(plain)),
      plain(""),
      choice(state, "continue", recoverySession === undefined ? "Return to installed plugins" : "Review recovery configuration", theme),
    ],
    disclosureOffset: 0,
    disclosureCount: 0,
  };
}

export function renderPluginInstall(input: Readonly<{
  state: PluginInstallState;
  width: number;
  height: number;
  theme: Theme;
}>): readonly string[] {
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const content = installContent(input.state, input.theme);
  const all: string[] = [];
  let focusLine = -1;
  for (const line of content.lines) {
    const wrapped = wrapTextWithAnsi(line.text, width);
    if (focusLine < 0 && line.focus !== undefined && focused(input.state, line.focus)) focusLine = all.length;
    all.push(...wrapped.map((entry) => truncateToWidth(entry, width, "")));
  }
  const max = Math.max(0, all.length - height);
  let start: number;
  if (input.state.focus === "disclosure" && content.disclosureCount > 0) {
    start = Math.max(0, Math.min(content.disclosureOffset + input.state.scroll.disclosure, max));
  } else {
    start = Math.max(0, Math.min(input.state.scroll.content, max));
  }
  // Keep the focused control on screen: a menu that requires scrolling to
  // reach its own buttons reads as broken navigation.
  if (focusLine >= 0) {
    if (focusLine < start) start = focusLine;
    else if (focusLine >= start + height) start = focusLine - height + 1;
  }
  return Object.freeze(all.slice(start, start + height));
}

export type PluginInstallComponentAction =
  | Readonly<{ type: "continue" | "back" | "cancel" }>
  | Readonly<{ type: "edit-field"; key: string; sensitive: boolean }>;

export class PluginInstallComponent implements Component {
  private state: PluginInstallState;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly onEvent: (event: PluginInstallEvent) => void;
  private readonly onAction: (action: PluginInstallComponentAction) => void;
  private readonly height: () => number;
  private disposed = false;

  constructor(input: Readonly<{
    state: PluginInstallState;
    theme: Theme;
    keybindings: KeybindingsManager;
    height(): number;
    onEvent(event: PluginInstallEvent): void;
    onAction(action: PluginInstallComponentAction): void;
  }>) {
    this.state = input.state;
    this.theme = input.theme;
    this.keybindings = input.keybindings;
    this.height = input.height;
    this.onEvent = input.onEvent;
    this.onAction = input.onAction;
  }

  update(state: PluginInstallState): void { this.state = state; }
  render(width: number): string[] {
    if (this.disposed) return [];
    return [...renderPluginInstall({ state: this.state, width, height: this.height(), theme: this.theme })];
  }

  private focusOrder(): readonly PluginInstallFocus[] {
    if (this.state.step === "choose-inspect") return ["back"];
    if (this.state.step === "activation-result") return ["continue"];
    return [
      ...(this.state.session?.fields.map((field) => Object.freeze({ field: field.key })) ?? []),
      "disclosure",
      "back",
      "continue",
    ];
  }

  private moveFocus(delta: number): void {
    const order = this.focusOrder();
    const current = order.findIndex((entry) => focused(this.state, entry));
    this.onEvent({ type: "focus", focus: order[(Math.max(0, current) + delta + order.length) % order.length]! });
  }

  private activate(): void {
    if (this.state.busy) return;
    const currentFocus = this.state.focus;
    if (typeof currentFocus !== "string") {
      const field = this.state.session?.fields.find((entry) => entry.key === currentFocus.field);
      if (field === undefined) return;
      // Non-sensitive values edit in place; secrets never enter flow state.
      if (field.sensitive) this.onAction({ type: "edit-field", key: field.key, sensitive: true });
      else this.onEvent({ type: "edit-start", key: field.key });
      return;
    }
    if (this.state.focus === "disclosure") {
      this.onEvent({ type: "toggle-disclosure", key: this.state.step === "choose-inspect" ? "candidate-components" : "executable" });
      return;
    }
    if (this.state.focus === "back") {
      this.onAction({ type: "back" });
      return;
    }
    if (this.state.step === "configure-trust" && this.state.session !== undefined) {
      // Consent is granted by the explicit Add action itself. The exact
      // disclosure above remains reviewable but is deliberately not a gate.
      this.onEvent({ type: "consent", consentId: this.state.session.consent.consentId });
    }
    this.onAction({ type: "continue" });
  }

  private editInput(data: string): boolean {
    const editing = this.state.editing;
    if (editing === undefined) return false;
    const buffer = [...editing.buffer];
    const commit = (): void => {
      this.onEvent({ type: "set-value", key: editing.key, value: editing.buffer });
      this.onEvent({ type: "edit-end" });
    };
    if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) this.onEvent({ type: "edit-end" });
    else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) commit();
    else if (matchesKey(data, Key.left)) this.onEvent({ type: "edit-buffer", buffer: editing.buffer, cursor: Math.max(0, editing.cursor - 1) });
    else if (matchesKey(data, Key.right)) this.onEvent({ type: "edit-buffer", buffer: editing.buffer, cursor: Math.min(buffer.length, editing.cursor + 1) });
    else if (matchesKey(data, Key.home)) this.onEvent({ type: "edit-buffer", buffer: editing.buffer, cursor: 0 });
    else if (matchesKey(data, Key.end)) this.onEvent({ type: "edit-buffer", buffer: editing.buffer, cursor: buffer.length });
    else if (matchesKey(data, Key.backspace)) {
      if (editing.cursor > 0) {
        buffer.splice(editing.cursor - 1, 1);
        this.onEvent({ type: "edit-buffer", buffer: buffer.join(""), cursor: editing.cursor - 1 });
      }
    } else if (matchesKey(data, Key.delete)) {
      if (editing.cursor < buffer.length) {
        buffer.splice(editing.cursor, 1);
        this.onEvent({ type: "edit-buffer", buffer: buffer.join(""), cursor: editing.cursor });
      }
    } else {
      const projected = projectTerminalText(data, 512);
      if (data.length > 0 && !data.includes("\u001b") && !/[\u0000-\u001f\u007f-\u009f]/u.test(data) && !projected.escaped) {
        buffer.splice(editing.cursor, 0, projected.text);
        this.onEvent({ type: "edit-buffer", buffer: buffer.join(""), cursor: editing.cursor + projected.text.length });
      }
    }
    return true;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.editInput(data)) return;
    const page = Math.max(1, this.height() - 4);
    if (matchesKey(data, Key.tab)) this.moveFocus(1);
    else if (matchesKey(data, Key.shift("tab"))) this.moveFocus(-1);
    else if (this.keybindings.matches(data, "tui.select.up")) this.moveFocus(-1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.moveFocus(1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.onEvent({ type: "scroll", region: this.state.focus === "disclosure" ? "disclosure" : "content", delta: -page });
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.onEvent({ type: "scroll", region: this.state.focus === "disclosure" ? "disclosure" : "content", delta: page });
    else if (this.keybindings.matches(data, "tui.select.confirm")) this.activate();
    else if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) this.onAction(this.state.busy ? { type: "cancel" } : { type: "back" });
  }
  invalidate(): void {}
  dispose(): void { this.disposed = true; }
}
