import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { NativeInspectionDetailResultSchema, type NativeInspectionDetail } from "../../application/native-inspection-contract.js";
import type { NativeControlEnvelope } from "../../application/native-control-contract.js";
import { presentControlFailure } from "../../application/native-failure-presenter.js";
import { plainLifecyclePhase } from "../plain-language.js";
import { projectTerminalText } from "./pi-terminal-text.js";
import {
  PluginManagerActionRegistry,
  pluginManagerMenuActions,
  pluginManagerVisibleRows,
  rowKeyIdentity,
  type PluginManagerRow,
  type PluginManagerState,
  type PluginManagerView,
} from "./plugin-manager-model.js";
import { styledNativeControlStatusLine, styledStatus } from "./plugin-manager-status.js";

const VIEW_LABELS: Readonly<Record<PluginManagerView, string>> = Object.freeze({
  installed: "Plugins",
  marketplaces: "Marketplaces",
});

function plain(value: unknown, limit = 2_048): string {
  return projectTerminalText(typeof value === "string" ? value : String(value ?? ""), limit).text;
}

function finish(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "");
}

function wrap(line: string, width: number): readonly string[] {
  return wrapTextWithAnsi(line, Math.max(1, width)).map((entry) => finish(entry, width));
}

function frame(theme: Theme, width: number): string {
  return theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
}

function selectedRow(state: PluginManagerState): PluginManagerRow | undefined {
  const rows = pluginManagerVisibleRows(state);
  if (state.focus.row === undefined) return rows[0];
  return rows.find((row) => rowKeyIdentity(row.key) === rowKeyIdentity(state.focus.row!)) ?? rows[0];
}

function selectedIndex(state: PluginManagerState): number {
  const row = selectedRow(state);
  return row === undefined ? -1 : pluginManagerVisibleRows(state).findIndex((candidate) => rowKeyIdentity(candidate.key) === rowKeyIdentity(row.key));
}

function boundedWindow(lines: readonly string[], selected: number, height: number): readonly string[] {
  const size = Math.max(1, height);
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, lines.length - size)));
  return lines.slice(start, start + size);
}

function emptyMessage(view: PluginManagerView): string {
  if (view === "installed") return "No plugins available · press a to add a marketplace";
  return "No marketplaces configured · press a to add a GitHub marketplace";
}

function queryLine(state: PluginManagerState, theme: Theme, focused: boolean): string {
  const active = state.focus.pane === "query";
  const marker = active && focused ? CURSOR_MARKER : "";
  return `${theme.fg(active ? "accent" : "muted", "/ search")}  ${plain(state.query, 256)}${marker}${active ? "_" : ""}`;
}

function listLines(state: PluginManagerState, theme: Theme, focused: boolean, bodyHeight: number): readonly string[] {
  // The heading stays quiet unless something needs attention: health only
  // appears when the host is not ready, the update count only when nonzero.
  const health = state.health.status === "ready" ? "" : state.health.status === "loading" ? " · checking host…" : ` · host ${state.health.status}`;
  const updates = state.updateCounts.unresolved > 0 ? ` · ${state.updateCounts.unresolved} updates` : "";
  const policySurface = state.view === "installed" && state.filter === "updates";
  const policy = policySurface && state.updatesPolicy !== undefined
    ? state.updatesPolicy.application === "automatic" ? ` · auto on · ${state.updatesPolicy.cadence}` : " · auto off"
    : "";
  const heading = `${theme.fg("accent", theme.bold(VIEW_LABELS[state.view]))}${theme.fg("muted", `${health}${updates}${policy}`)}`;
  const rows = pluginManagerVisibleRows(state).map((row) => {
    const selected = selectedRow(state) !== undefined && rowKeyIdentity(selectedRow(state)!.key) === rowKeyIdentity(row.key);
    // The scope badge keeps the same plugin installed in both scopes from
    // rendering as indistinguishable duplicates.
    const badge = row.scope === undefined ? "" : theme.fg(row.scope === "project" ? "accent" : "muted", ` [${row.scope}]`);
    const line = `${selected ? "→" : " "} ${plain(row.title, 256)}${badge}  ${styledStatus(theme, row.status, row.statusTone)}`;
    return selected ? theme.bg("selectedBg", line) : line;
  });
  const available = Math.max(1, bodyHeight - (state.view === "installed" ? 10 : 8));
  const visible = boundedWindow(rows, Math.max(0, selectedIndex(state)), available);
  if (bodyHeight <= 5) return [
    heading,
    ...(state.page.errorCode === undefined ? [] : [theme.fg("error", `! ${plain(state.page.errorCode, 64)}`)]),
    ...boundedWindow(rows, Math.max(0, selectedIndex(state)), Math.max(1, bodyHeight - 1)),
  ];
  const row = selectedRow(state);
  // While the first page is in flight there is no authority yet; showing the
  // empty-state guidance would flash a false "nothing here, add a source".
  const description = row !== undefined
    ? `${plain(row.subtitle, 512)}${row.availableScopes === undefined || row.availableScopes.length < 2 ? "" : ` · ${row.availableScopes.join(" + ")}`}`
    : state.page.loading ? "Loading the current catalog…" : emptyMessage(state.view);
  return [
    heading,
    "",
    ...(state.view === "installed" ? [
      (["all", "installed", "available", "updates"] as const).map((filter) => filter === state.filter ? theme.fg("accent", `[${filter}]`) : theme.fg("muted", filter)).join("  "),
      "",
    ] : []),
    queryLine(state, theme, focused),
    "",
    ...(state.page.errorCode === undefined ? [] : [theme.fg("error", `! ${plain(state.page.errorCode, 64)}`)]),
    ...visible,
    ...(state.page.loading ? [theme.fg("accent", "… loading current state")] : []),
    ...(state.page.next === undefined ? [] : [theme.fg("muted", "Page Down loads more")]),
    "",
    theme.fg("muted", description),
  ];
}

/**
 * Turn a requirement's registry explanation ("Bash is available
 * (unavailable)") into a name the user recognizes. Falls back to the
 * capability id when the description has no availability phrasing.
 */
function requirementName(explanation: string, capability: string): string {
  const description = explanation.replace(/\s*\((?:available|unavailable)\)\s*$/u, "");
  const name = description.replace(/\s+(?:is|are) available$/u, "");
  if (name.length > 0) return name;
  return description.length > 0 ? description : capability;
}

/**
 * Red states lead with named reasons, never counts. Diagnostics that only
 * restate the status line or the named requirements are not repeated.
 */
function compatibilityLines(detail: NativeInspectionDetail, theme: Theme): readonly string[] {
  const lines: string[] = [theme.fg("accent", "Compatibility / health")];
  const trustNote = ["not-applicable", "authorized"].includes(detail.trust) ? "" : ` · trust ${plain(detail.trust)}`;
  lines.push(`  ${styledStatus(theme, detail.compatibility.status)}${trustNote}`);

  const unavailable = detail.compatibility.requirements.filter((requirement) => requirement.status === "unavailable");
  for (const requirement of unavailable.slice(0, 4)) {
    lines.push(theme.fg("error", `  ! ${plain(requirementName(requirement.explanation.text, requirement.capability.text), 128)} — unavailable`));
  }
  if (unavailable.length > 4) lines.push(theme.fg("muted", `  … ${unavailable.length - 4} more unavailable`));

  const restated = new Set(["COMPATIBILITY_INCOMPATIBLE", "RUNTIME_REQUIREMENT_UNAVAILABLE"]);
  const errors = detail.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const named = errors.filter((diagnostic) => !restated.has(diagnostic.code));
  const source = named.length > 0 ? named : unavailable.length === 0 ? errors : [];
  // Dedupe before slicing so the overflow count reflects distinct reasons.
  const distinct: typeof source = [];
  const seen = new Set<string>();
  for (const diagnostic of source) {
    if (seen.has(diagnostic.summary.text)) continue;
    seen.add(diagnostic.summary.text);
    distinct.push(diagnostic);
  }
  for (const diagnostic of distinct.slice(0, 3)) {
    lines.push(theme.fg("error", `  ! ${plain(diagnostic.summary.text, 256)}`));
  }
  if (distinct.length > 3) lines.push(theme.fg("muted", `  … ${distinct.length - 3} more`));

  if (unavailable.length === 0 && errors.length === 0) {
    const warnings = detail.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").slice(0, 2);
    for (const diagnostic of warnings) lines.push(theme.fg("muted", `  △ ${plain(diagnostic.summary.text, 256)}`));
  }
  return lines;
}

function sourceSummary(value: unknown): string {
  if (value === null || typeof value !== "object") return "unavailable";
  const source = value as Record<string, unknown>;
  const kind = plain(source.kind, 64);
  for (const key of ["location", "package"] as const) {
    const field = source[key];
    if (field !== null && typeof field === "object" && "text" in field) return `${kind}: ${plain((field as { text?: unknown }).text)}`;
  }
  return kind || "unavailable";
}

function detailLines(state: PluginManagerState, theme: Theme, bodyHeight: number): readonly string[] {
  const row = selectedRow(state);
  const heading = `${theme.fg("accent", theme.bold("Plugin Manager"))} ${theme.fg("muted", `/ ${VIEW_LABELS[state.view]} / ${plain(row?.title ?? "Detail", 128)}`)}`;
  if (row === undefined) return [heading, "", theme.fg("muted", "No item selected")];
  if (state.detail.loading) return [heading, "", theme.fg("accent", "… loading exact details")];
  const lines: string[] = [heading, "", theme.bold(plain(row.plugin ?? row.title)), styledStatus(theme, row.status, row.statusTone), ""];
  const parsed = NativeInspectionDetailResultSchema.safeParse(state.detail.envelope?.data);
  if (parsed.success && parsed.data.kind === "found") {
    const detail = parsed.data.detail;
    lines.push(
      `Scope         ${row.scope ?? "unknown"}`,
      `Installed     ${plain(detail.summary.revision.installed?.text ?? "not installed")}`,
      `Available     ${plain(detail.summary.revision.available?.text ?? "not reported")}`,
      `Origin        ${sourceSummary(detail.source)}`,
      "",
      theme.fg("accent", "Runtime surface"),
      `  ${detail.compatibility.components.counts.skills} skills · ${detail.compatibility.components.counts.hooks} command hooks · ${detail.compatibility.components.counts.mcpServers} MCP servers`,
      "",
      ...compatibilityLines(detail, theme),
    );
  } else {
    lines.push(`Scope         ${row.scope ?? "unknown"}`, `Marketplace   ${plain(row.subtitle)}`, "", theme.fg("warning", "Exact detail is unavailable. Press R to retry."));
    if (state.detail.errorCode !== undefined) lines.push(theme.fg("error", state.detail.errorCode));
    else lines.push(...envelopeLines(state.detail.envelope, theme));
  }
  if (state.operation.state !== "idle") {
    lines.push("", styledStatus(theme, state.operation.state), ...(state.operation.state === "running" ? [theme.fg("accent", `… ${plain(state.operation.action ?? "working")}`)] : []));
    for (const item of state.operation.frames.slice(-3)) {
      if (item.type === "progress") lines.push(theme.fg("muted", `${plain(item.phase)} · ${plain(item.state)}`));
    }
    if (state.operation.envelope !== undefined) lines.push(...envelopeLines(state.operation.envelope, theme));
  }
  const actions = pluginManagerMenuActions(state);
  if (actions.length > 0 && state.operation.state !== "running" && state.operation.state !== "cancelling") {
    const selectedIndex = Math.max(0, actions.findIndex((action) => action === state.focus.action));
    const actionRows = actions.map((action, index) => {
      const selected = index === selectedIndex;
      const line = `${selected ? "→" : " "} ${PluginManagerActionRegistry[action].label}`;
      return selected ? theme.bg("selectedBg", theme.fg("accent", line)) : line;
    });
    const selected = actions[selectedIndex];
    if (bodyHeight <= 10) return [
      heading,
      styledStatus(theme, row.status, row.statusTone),
      "",
      ...boundedWindow(actionRows, selectedIndex, Math.max(1, bodyHeight - 5)),
      ...(selected === undefined ? [] : [theme.fg("muted", PluginManagerActionRegistry[selected].description)]),
    ];
    lines.push("", theme.fg("accent", "Actions"), ...actionRows);
    if (selected !== undefined) lines.push(theme.fg("muted", PluginManagerActionRegistry[selected].description));
  }
  return lines;
}

function actionLines(state: PluginManagerState, theme: Theme, bodyHeight: number): readonly string[] {
  const row = selectedRow(state);
  const actions = pluginManagerMenuActions(state);
  const selected = Math.max(0, actions.findIndex((action) => action === state.focus.action));
  const rows = actions.map((action, index) => {
    const line = `${index === selected ? "→" : " "} ${PluginManagerActionRegistry[action].label}`;
    return index === selected ? theme.bg("selectedBg", theme.fg("accent", line)) : line;
  });
  const action = actions[selected];
  return [
    `${theme.fg("accent", theme.bold("Plugin Manager"))} ${theme.fg("muted", `/ ${VIEW_LABELS[state.view]} / ${plain(row?.title ?? "Item")} / Actions`)}`,
    "",
    ...boundedWindow(rows, selected, Math.max(1, bodyHeight - 4)),
    "",
    theme.fg("muted", action === undefined ? "No actions available" : PluginManagerActionRegistry[action].description),
  ];
}

function envelopeLines(envelope: NativeControlEnvelope | undefined, theme: Theme): readonly string[] {
  if (envelope === undefined) return [];
  const lines = [styledNativeControlStatusLine(theme, envelope.status)];
  for (const field of envelope.human.slice(0, 4)) lines.push(plain(field.text));
  for (const diagnostic of envelope.diagnostics.slice(0, 3)) {
    const friendly = presentControlFailure(diagnostic.code);
    lines.push(friendly === undefined
      ? theme.fg("muted", `${diagnostic.code} · ${plain(diagnostic.action)}`)
      : theme.fg(diagnostic.severity === "error" ? "error" : "warning", plain(friendly.text)));
  }
  return lines;
}

function operationLines(state: PluginManagerState, theme: Theme): readonly string[] {
  const lines = [theme.fg("accent", theme.bold(`Plugin operation / ${plain(state.operation.action ?? "result")}`)), "", styledStatus(theme, state.operation.state)];
  for (const item of state.operation.frames) {
    if (item.type === "accepted") lines.push(theme.fg("muted", `#${item.sequence} accepted`));
    else if (item.type === "progress") lines.push(`#${item.sequence} ${plainLifecyclePhase(item.phase)} · ${plain(item.state)}`);
  }
  lines.push(...envelopeLines(state.operation.envelope, theme));
  if (state.operation.state === "cancelling") lines.push(theme.fg("warning", "Cancellation requested; waiting for the owner result."));
  return lines;
}

function footer(state: PluginManagerState, theme: Theme, keybindings: KeybindingsManager, width: number): string {
  const key = (id: Parameters<KeybindingsManager["getKeys"]>[0], fallback: string) => plain(keybindings.getKeys(id)[0] ?? fallback, 32);
  const move = `${key("tui.select.up", "up")}/${key("tui.select.down", "down")} navigate`;
  if (state.operation.state !== "idle" || state.screen === "operation-result") {
    const dismiss = state.operation.state === "running" || state.operation.state === "cancelling"
      ? `${key("app.interrupt", "escape")} cancel`
      : `${key("tui.select.confirm", "enter")}/${key("app.interrupt", "escape")} back`;
    return theme.fg("dim", `${move} · ${dismiss}`);
  }
  if (state.focus.pane === "detail") {
    const actionHint = pluginManagerMenuActions(state).length === 0 ? "" : `${key("tui.select.confirm", "enter")} run · `;
    return theme.fg("dim", width < 70
      ? `${key("tui.select.confirm", "enter")} run · r refresh · esc back`
      : `${move} · ${actionHint}r refresh · ${key("app.interrupt", "escape")} back`);
  }
  const confirm = key("tui.select.confirm", "enter");
  const interrupt = key("app.interrupt", "escape");
  if (state.view === "marketplaces") {
    if (width < 60) return theme.fg("dim", "a add · r refresh · x remove · esc close");
    return theme.fg("dim", `${move} · a add · r refresh catalog · x remove · ${confirm} details · ${interrupt} close`);
  }
  if (state.view === "installed" && state.filter === "updates") {
    if (width < 60) return theme.fg("dim", "ctrl+u all · p auto updates · esc close");
    return theme.fg("dim", `${move} · ←/→ lens · u update · ctrl+u all · p auto updates · ${confirm} details · ${interrupt} close`);
  }
  if (width < 60) return theme.fg("dim", `a add · m marketplaces · x remove · ${confirm} details · esc close`);
  if (width < 90) return theme.fg("dim", `a add · m marketplaces · d disable · x remove · u update · ${confirm} details · ${interrupt} close`);
  return theme.fg("dim", `${move} · ←/→ lens · a add · d disable · x remove · u update · ctrl+u all · m marketplaces · ${confirm} details · ${interrupt} close`);
}

export function renderPluginManager(input: Readonly<{
  state: PluginManagerState;
  width: number;
  height: number;
  theme: Theme;
  keybindings: KeybindingsManager;
  focused?: boolean;
}>): readonly string[] {
  const width = Math.max(1, Math.floor(input.width));
  const height = Math.max(4, Math.floor(input.height));
  const bodyHeight = Math.max(1, height - 3);
  let content: readonly string[];
  if (input.state.focus.pane === "detail") content = detailLines(input.state, input.theme, bodyHeight);
  else if (input.state.screen === "operation-result" || input.state.operation.state !== "idle") content = operationLines(input.state, input.theme);
  else content = listLines(input.state, input.theme, input.focused === true, bodyHeight);
  const wrapped = content.flatMap((line) => wrap(line, width));
  const offset = input.state.operation.state !== "idle" || input.state.screen === "operation-result" ? input.state.scroll.operation : input.state.focus.pane === "detail" ? input.state.scroll.detail : 0;
  const body = wrapped.slice(offset, offset + bodyHeight);
  if (input.state.help) body.unshift(input.theme.fg("warning", "One list at a time: enter opens · escape returns one level · a adds · r refreshes."));
  return Object.freeze([
    frame(input.theme, width),
    ...body.slice(0, bodyHeight).map((line) => finish(line, width)),
    finish(footer(input.state, input.theme, input.keybindings, width), width),
    frame(input.theme, width),
  ].slice(0, height));
}
