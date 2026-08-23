import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import {
  inferScopePreset,
  SCOPE_PRESET_LABELS,
  type ProjectScopeListField,
} from "../../../config/config-command-plans.ts";
import { handleScopeCommand } from "../scope.ts";
import type { CommandReport } from "../types.ts";
import type { SettingsAction, SettingsActionId } from "./actions.ts";
import {
  dispatchSettingsAction,
  type SettingsDispatchDependencies,
} from "./dispatcher.ts";
import {
  dispatchScopePathInputAction,
  type ScopePathActionId,
} from "./panels/scope.ts";
import {
  SETTINGS_PANELS,
  type SettingsPanel,
  type SettingsRow,
} from "./panels.ts";
import type { SettingsReadModel } from "./read-model.ts";

export interface SettingsNativeUiLoadResult {
  readonly ok: true;
  readonly model: SettingsReadModel;
}

export interface SettingsNativeUiDetails {
  readonly reason: "native-ui";
  readonly actionsHandled: readonly SettingsNativeUiHandledAction[];
}

export interface SettingsNativeUiHandledAction {
  readonly label: string;
  readonly reportTitle: string;
  readonly reportSummary: string;
  readonly level: "info" | "warning" | "error";
}

export type SettingsNativeUiResult =
  | {
      readonly ok: true;
      readonly details: SettingsNativeUiDetails;
      readonly level: "info" | "warning" | "error";
      readonly summary: string;
    }
  | { readonly ok: false; readonly report: CommandReport };

export type SettingsNativeUiSelection =
  | { readonly kind: "close" }
  | {
      readonly kind: "action";
      readonly label: string;
      readonly action: SettingsAction;
    }
  | {
      readonly kind: "input-action";
      readonly label: string;
      readonly actionId: SettingsActionId;
      readonly args: Readonly<Record<string, string | boolean | number | null>>;
      readonly prompt: string;
      readonly argName: string;
      readonly empty: "null" | "refuse";
      readonly placeholder?: string;
    }
  | {
      readonly kind: "scope-path";
      readonly label: string;
      readonly id: ScopePathActionId;
      readonly field: ProjectScopeListField;
    };

type SettingsNativeUiReload = () =>
  | Promise<
      | SettingsNativeUiLoadResult
      | { readonly ok: false; readonly report: CommandReport }
    >
  | SettingsNativeUiLoadResult
  | { readonly ok: false; readonly report: CommandReport };

type NativeSettingsScreen = "home" | SettingsPanel["id"] | "pack-dossier";

interface NativeSettingsUiInteraction {
  readonly selection: SettingsNativeUiSelection;
  readonly screen: NativeSettingsScreen;
  readonly selected: number;
  readonly dossierScroll: number;
}

interface SettingsNativeUiOptions {
  readonly ctx: ExtensionCommandContext;
  readonly deps: SettingsDispatchDependencies;
  readonly initialModel: SettingsReadModel;
  readonly initialPanel?: SettingsPanel["id"];
  readonly reload: SettingsNativeUiReload;
}

interface NativeSettingsActionItem {
  readonly kind: "selection";
  readonly label: string;
  readonly description: string;
  readonly selection: Exclude<
    SettingsNativeUiSelection,
    { readonly kind: "close" }
  >;
}

interface NativeSettingsPanelItem {
  readonly kind: "panel";
  readonly label: string;
  readonly description: string;
  readonly panel: SettingsPanel;
}

interface NativeSettingsCloseItem {
  readonly kind: "close";
  readonly label: string;
  readonly description: string;
}

interface NativeSettingsBackItem {
  readonly kind: "back";
  readonly label: string;
  readonly description: string;
}

export type NativeSettingsItem =
  | NativeSettingsActionItem
  | NativeSettingsPanelItem
  | NativeSettingsCloseItem
  | NativeSettingsBackItem;

interface MinimalTheme {
  readonly fg?: (color: string, text: string) => string;
  readonly bold?: (text: string) => string;
}

interface MinimalTui {
  readonly requestRender?: () => void;
}

const DOSSIER_VISIBLE_LINES = 12;

export function canOpenSettingsNativeUi(ctx: ExtensionCommandContext): boolean {
  try {
    const custom = (
      ctx as unknown as { readonly ui?: { readonly custom?: unknown } }
    ).ui?.custom;
    return ctx.hasUI === true && typeof custom === "function";
  } catch {
    return false;
  }
}

export async function openSettingsNativeUi(
  options: SettingsNativeUiOptions,
): Promise<SettingsNativeUiResult> {
  if (!canOpenSettingsNativeUi(options.ctx)) {
    return {
      ok: false,
      report: {
        title: "Settings UI unavailable",
        summary:
          "Pi Clearance settings require Pi's native custom UI; no markdown fallback was rendered and no config changes were written.",
        markdown:
          "Pi Clearance settings require Pi's native custom UI; no markdown fallback was rendered and no config changes were written.",
        details: { reason: "native-ui-unavailable" },
        level: "error",
      },
    };
  }

  let model = options.initialModel;
  let screen: NativeSettingsScreen = options.initialPanel ?? "home";
  let selected = 0;
  let dossierScroll = 0;
  let dossierOrigin: NativeSettingsScreen = "packs";
  let message: NativeSettingsMessage | undefined;
  const handled: SettingsNativeUiHandledAction[] = [];

  while (true) {
    let interaction: NativeSettingsUiInteraction;
    try {
      interaction = await presentSettingsNativeUi({
        ctx: options.ctx,
        model,
        screen,
        selected,
        dossierScroll,
        dossierOrigin,
        ...(message === undefined ? {} : { message }),
      });
    } catch (error) {
      return {
        ok: false,
        report: nativeSettingsFailureReport(
          "presentation",
          error,
          handled.length,
        ),
      };
    }
    const selection = interaction.selection;
    if (selection.kind === "close") {
      return {
        ok: true,
        summary:
          handled.length === 0
            ? "Opened the native Pi Clearance settings UI; no config changes were written."
            : `Closed the native Pi Clearance settings UI after ${handled.length} action${handled.length === 1 ? "" : "s"}.`,
        details: { reason: "native-ui", actionsHandled: handled },
        level: maxLevel(handled.map((entry) => entry.level)),
      };
    }

    let report: CommandReport;
    try {
      report = await dispatchNativeSettingsSelection(
        selection,
        options.ctx,
        options.deps,
      );
    } catch (error) {
      report = nativeSettingsFailureReport("action", error, handled.length);
    }
    const handledAction: SettingsNativeUiHandledAction = {
      label: selection.label,
      reportTitle: report.title,
      reportSummary: report.summary,
      level: report.level ?? "info",
    };
    handled.push(handledAction);
    const dossier =
      (selection.kind === "input-action" &&
        selection.actionId === "packs.show") ||
      (selection.kind === "action" && selection.action.id === "scope.open")
        ? report.markdown
        : undefined;
    message = {
      level: handledAction.level,
      text: `${report.title}: ${report.summary}`,
      ...(dossier === undefined ? {} : { dossier }),
    };
    if (dossier !== undefined) {
      // Remember which panel the dossier came from so Back returns there.
      dossierOrigin = interaction.screen;
    }
    screen = dossier === undefined ? interaction.screen : "pack-dossier";
    selected = dossier === undefined ? interaction.selected : 0;
    dossierScroll = dossier === undefined ? interaction.dossierScroll : 0;

    let reloaded: Awaited<ReturnType<SettingsNativeUiReload>>;
    try {
      reloaded = await options.reload();
    } catch (error) {
      return {
        ok: false,
        report: nativeSettingsFailureReport("reload", error, handled.length),
      };
    }
    if (!reloaded.ok) {
      return { ok: false, report: reloaded.report };
    }
    model = reloaded.model;
  }
}

async function presentSettingsNativeUi(input: {
  readonly ctx: ExtensionCommandContext;
  readonly model: SettingsReadModel;
  readonly screen: NativeSettingsScreen;
  readonly selected: number;
  readonly dossierScroll: number;
  readonly dossierOrigin: NativeSettingsScreen;
  readonly message?: NativeSettingsMessage;
}): Promise<NativeSettingsUiInteraction> {
  const custom = input.ctx.ui.custom.bind(input.ctx.ui);
  return await custom<NativeSettingsUiInteraction>(
    (tui, theme, _keybindings, done) => {
      let component: SettingsNativeUiComponent | undefined;
      let lastFailure: string | undefined;
      const fallbackNavigation = {
        screen: input.screen,
        selected: input.selected,
        dossierScroll: input.dossierScroll,
      } satisfies Omit<NativeSettingsUiInteraction, "selection">;

      const reportFailure = (phase: string, error: unknown): void => {
        const diagnostic = `Pi Clearance native settings ${phase} failed: ${errorMessage(error)}`;
        if (diagnostic === lastFailure) return;
        lastFailure = diagnostic;
        console.error(diagnostic);
      };

      const safeDone = (selection: SettingsNativeUiSelection): void => {
        try {
          done({
            selection,
            ...(component?.getNavigationState() ?? fallbackNavigation),
          });
        } catch (error) {
          reportFailure("completion", error);
        }
      };

      try {
        component = new SettingsNativeUiComponent({
          model: input.model,
          theme: theme as MinimalTheme,
          done: safeDone,
          initialScreen: input.screen,
          initialSelected: input.selected,
          initialDossierScroll: input.dossierScroll,
          dossierOrigin: input.dossierOrigin,
          ...(input.message === undefined ? {} : { message: input.message }),
        });
      } catch (error) {
        reportFailure("component construction", error);
      }

      const minimalTui = tui as MinimalTui;
      return {
        render: (width: number) => {
          try {
            if (component === undefined) {
              return renderNativeSettingsFallback(width, lastFailure);
            }
            return component.render(width);
          } catch (error) {
            reportFailure("render", error);
            return renderNativeSettingsFallback(width, lastFailure);
          }
        },
        invalidate: () => {
          try {
            component?.invalidate();
          } catch (error) {
            reportFailure("invalidation", error);
          }
        },
        handleInput: (data: string) => {
          try {
            if (component === undefined) {
              if (isClose(data)) safeDone({ kind: "close" });
            } else {
              component.handleInput(data);
            }
          } catch (error) {
            reportFailure("input", error);
          }

          // requestRender is a host callback too; a broken TUI refresh must
          // not prevent the component from accepting a later close/recovery
          // input or turn a completed settings write into a failed command.
          try {
            minimalTui.requestRender?.call(tui);
          } catch (error) {
            reportFailure("input refresh", error);
          }
        },
      };
    },
  );
}

async function dispatchNativeSettingsSelection(
  selection: Exclude<SettingsNativeUiSelection, { readonly kind: "close" }>,
  ctx: ExtensionCommandContext,
  deps: SettingsDispatchDependencies,
): Promise<CommandReport> {
  switch (selection.kind) {
    case "action":
      // The scope details dossier reuses the /clearance scope status report.
      if (selection.action.id === "scope.open") {
        return await handleScopeCommand([], ctx, deps);
      }
      return await dispatchSettingsAction(selection.action, ctx, deps);
    case "scope-path":
      return await dispatchScopePathInputAction(
        { id: selection.id, field: selection.field },
        ctx,
        deps,
      );
    case "input-action": {
      const input = await readNativeSettingsInput(selection, ctx);
      if (!input.ok) return input.report;
      return await dispatchSettingsAction(
        {
          id: selection.actionId,
          args: { ...selection.args, [selection.argName]: input.value },
        },
        ctx,
        deps,
      );
    }
  }
}

async function readNativeSettingsInput(
  selection: Extract<
    SettingsNativeUiSelection,
    { readonly kind: "input-action" }
  >,
  ctx: ExtensionCommandContext,
): Promise<
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly report: CommandReport }
> {
  let input:
    | ((
        title: string,
        placeholder?: string,
      ) => Promise<string | undefined> | string | undefined)
    | undefined;
  try {
    input = (
      ctx as unknown as {
        readonly ui?: {
          readonly input?: (
            title: string,
            placeholder?: string,
          ) => Promise<string | undefined> | string | undefined;
        };
      }
    ).ui?.input;
  } catch (error) {
    return {
      ok: false,
      report: nativeInputRefusedReport(selection, "failed", error),
    };
  }

  if (typeof input !== "function") {
    return {
      ok: false,
      report: nativeInputRefusedReport(selection, "unavailable"),
    };
  }

  let value: string | undefined;
  try {
    const rawValue = await input(
      selection.prompt,
      selection.placeholder ?? "",
    );
    if (rawValue !== undefined && typeof rawValue !== "string") {
      return {
        ok: false,
        report: nativeInputRefusedReport(
          selection,
          "failed",
          new Error("Pi UI input returned a non-string value"),
        ),
      };
    }
    value = rawValue;
  } catch (error) {
    return {
      ok: false,
      report: nativeInputRefusedReport(selection, "failed", error),
    };
  }
  if (value === undefined) {
    return {
      ok: false,
      report: nativeInputRefusedReport(selection, "cancelled"),
    };
  }

  let trimmed: string;
  try {
    trimmed = value.trim();
  } catch (error) {
    return {
      ok: false,
      report: nativeInputRefusedReport(selection, "failed", error),
    };
  }
  if (trimmed.length === 0) {
    if (selection.empty === "null") {
      return { ok: true, value: null };
    }
    return {
      ok: false,
      report: nativeInputRefusedReport(selection, "empty"),
    };
  }

  return { ok: true, value: trimmed };
}

function nativeInputRefusedReport(
  selection: Extract<
    SettingsNativeUiSelection,
    { readonly kind: "input-action" }
  >,
  reason: "unavailable" | "cancelled" | "empty" | "failed",
  error?: unknown,
): CommandReport {
  const summary = (() => {
    switch (reason) {
      case "unavailable":
        return "Text input is not available in this Pi UI host; no config changes were written.";
      case "cancelled":
        return "Text input was cancelled; no config changes were written.";
      case "empty":
        return "Text input was empty; no config changes were written.";
      case "failed":
        return `Text input failed: ${errorMessage(error)}; no config changes were written.`;
    }
  })();

  return {
    title: "Settings input required",
    summary,
    markdown: [
      "# Settings input required",
      "",
      `- Action: \`${selection.actionId}\``,
      `- Input: ${selection.prompt}`,
      `- Reason: ${summary}`,
      "- No config changes were written.",
    ].join("\n"),
    details: { reason: `native-input-${reason}`, selection },
    level: reason === "unavailable" || reason === "failed" ? "error" : "warning",
  };
}

function nativeSettingsFailureReport(
  phase: string,
  error: unknown,
  actionsHandled: number,
): CommandReport {
  const message = errorMessage(error);
  const summary = `Pi Clearance settings ${phase} failed: ${message}. Previously confirmed actions, if any, remain applied; no rollback was attempted.`;
  return {
    title: "Pi Clearance settings failed",
    summary,
    markdown: [
      "# Pi Clearance settings failed",
      "",
      `- Phase: ${phase}`,
      `- Error: ${message}`,
      `- Actions already handled: ${actionsHandled}`,
      "- Reopen status to verify any previously confirmed writes.",
    ].join("\n"),
    details: { reason: `native-ui-${phase}-failed`, actionsHandled, error: message },
    level: "error",
  };
}

function renderNativeSettingsFallback(
  width: number,
  diagnostic: string | undefined,
): string[] {
  const lines = [
    "Pi Clearance settings UI encountered an error.",
    diagnostic ?? "The settings component could not be rendered.",
    "Previously confirmed actions, if any, remain applied.",
    "Press q or Esc to close.",
  ];
  try {
    return lines.map((line) => truncateAnsi(line, Math.max(1, width)));
  } catch {
    return ["Pi Clearance settings UI unavailable.", "Press q or Esc to close."];
  }
}

interface NativeSettingsMessage {
  readonly level: "info" | "warning" | "error";
  readonly text: string;
  readonly dossier?: string;
}

interface SettingsNativeUiComponentOptions {
  readonly model: SettingsReadModel;
  readonly initialPanel?: SettingsPanel["id"];
  readonly initialScreen?: NativeSettingsScreen;
  readonly initialSelected?: number;
  readonly initialDossierScroll?: number;
  readonly dossierOrigin?: NativeSettingsScreen;
  readonly message?: NativeSettingsMessage;
  readonly theme: MinimalTheme;
  readonly done: (selection: SettingsNativeUiSelection) => void;
}

export class SettingsNativeUiComponent {
  private readonly model: SettingsReadModel;
  private readonly message: NativeSettingsMessage | undefined;
  private readonly theme: MinimalTheme;
  private readonly done: (selection: SettingsNativeUiSelection) => void;
  private screen: NativeSettingsScreen;
  private selected = 0;
  private dossierScroll = 0;
  private readonly dossierOrigin: NativeSettingsScreen;

  constructor(options: SettingsNativeUiComponentOptions) {
    this.model = options.model;
    this.message = options.message;
    this.theme = options.theme;
    this.done = options.done;
    this.screen = options.initialScreen ?? options.initialPanel ?? "home";
    this.selected = Math.max(0, options.initialSelected ?? 0);
    this.dossierScroll = Math.max(0, options.initialDossierScroll ?? 0);
    this.dossierOrigin = options.dossierOrigin ?? "packs";
    this.clampSelection();
    this.clampDossierScroll();
  }

  getNavigationState(): Omit<NativeSettingsUiInteraction, "selection"> {
    return {
      screen: this.screen,
      selected: this.selected,
      dossierScroll: this.dossierScroll,
    };
  }

  handleInput(data: string): void {
    if (this.screen === "pack-dossier") {
      this.handleDossierInput(data);
      return;
    }

    const items = this.items();
    if (isUp(data)) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (isDown(data)) {
      this.selected = Math.min(
        Math.max(0, items.length - 1),
        this.selected + 1,
      );
      return;
    }
    if (isHome(data)) {
      this.selected = 0;
      return;
    }
    if (isEnd(data)) {
      this.selected = Math.max(0, items.length - 1);
      return;
    }
    if (isBack(data)) {
      if (this.screen === "home") {
        this.done({ kind: "close" });
        return;
      }
      this.screen = "home";
      this.selected = 0;
      return;
    }
    if (isClose(data)) {
      this.done({ kind: "close" });
      return;
    }
    if (isEnter(data)) {
      const item = items[this.selected];
      if (item === undefined) return;
      if (item.kind === "panel") {
        this.screen = item.panel.id;
        this.selected = 0;
        return;
      }
      if (item.kind === "close") {
        this.done({ kind: "close" });
        return;
      }
      if (item.kind === "back") {
        this.screen = "home";
        this.selected = 0;
        return;
      }
      this.done(item.selection);
    }
  }

  private handleDossierInput(data: string): void {
    if (isUp(data)) {
      this.dossierScroll = Math.max(0, this.dossierScroll - 1);
      return;
    }
    if (isDown(data)) {
      this.dossierScroll = Math.min(
        this.maxDossierScroll(),
        this.dossierScroll + 1,
      );
      return;
    }
    if (isHome(data)) {
      this.dossierScroll = 0;
      return;
    }
    if (isEnd(data)) {
      this.dossierScroll = this.maxDossierScroll();
      return;
    }
    if (isBack(data)) {
      this.screen = this.dossierOrigin;
      this.selected = 0;
      this.dossierScroll = 0;
      return;
    }
    if (isClose(data)) {
      this.done({ kind: "close" });
      return;
    }
    if (isEnter(data)) {
      this.screen = this.dossierOrigin;
      this.selected = 0;
      this.dossierScroll = 0;
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const title =
      this.screen === "home"
        ? "Pi Clearance Desk"
        : this.screen === "pack-dossier"
          ? "Pack dossier"
          : `${panelById(this.screen).title} settings`;

    lines.push(this.accent(this.strong(title)));
    lines.push(
      this.dim(
        "Native settings UI - no transcript markdown is written while this panel is open.",
      ),
    );
    lines.push("");
    lines.push(...this.renderStatusLines());

    if (this.message !== undefined) {
      lines.push("");
      lines.push(this.messageText(this.message));
    }

    if (this.screen === "pack-dossier") {
      lines.push(...this.renderDossier());
    } else if (this.screen !== "home") {
      const panel = panelById(this.screen);
      lines.push("");
      lines.push(this.accent(`${panel.title} details`));
      for (const row of panel.rows(this.model)) {
        lines.push(...this.renderRow(row));
      }
    }

    lines.push("");
    lines.push(
      this.accent(
        this.screen === "home"
          ? "Choose a panel or quick action"
          : this.screen === "pack-dossier"
            ? "Dossier navigation"
            : "Actions",
      ),
    );
    const items = this.items();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      const selected = index === this.selected;
      const prefix = selected ? this.accent("> ") : "  ";
      const label = selected ? this.accent(item.label) : item.label;
      lines.push(`${prefix}${label}`);
      if (selected) {
        lines.push(`  ${this.dim(item.description)}`);
      }
    }

    lines.push("");
    lines.push(
      this.dim(
        this.screen === "home"
          ? "Up/Down or j/k move - Enter select - q/Esc close"
          : this.screen === "pack-dossier"
            ? "Up/Down or j/k scroll - b/Esc back - q close"
            : "Up/Down or j/k move - Enter select - b/Esc back - q close",
      ),
    );

    return lines.map((line) => truncateAnsi(line, Math.max(1, width)));
  }

  private renderDossier(): readonly string[] {
    const dossier = this.message?.dossier;
    if (dossier === undefined) {
      return [this.dim("No pack dossier is available.")];
    }

    const dossierLines = dossier.split("\n");
    const visibleLines = dossierLines.slice(
      this.dossierScroll,
      this.dossierScroll + DOSSIER_VISIBLE_LINES,
    );
    const lines: string[] = [
      "",
      this.accent("Dossier details"),
      ...visibleLines,
    ];
    if (dossierLines.length > DOSSIER_VISIBLE_LINES) {
      lines.push(
        this.dim(
          `Lines ${this.dossierScroll + 1}-${Math.min(
            dossierLines.length,
            this.dossierScroll + DOSSIER_VISIBLE_LINES,
          )} of ${dossierLines.length}`,
        ),
      );
    }
    return lines;
  }

  invalidate(): void {
    // Rendering is computed from the current theme on every pass, so there is no cache to clear.
  }

  private renderStatusLines(): readonly string[] {
    return [
      `Mode: ${this.model.currentMode.label} - ${this.model.currentMode.description}`,
      `Reviewer: ${this.model.status.reviewer.path} - ${this.model.status.reviewer.consequence}`,
      `Review context: ${this.model.status.reviewer.contextMode}`,
      ...((this.model.status.customizations?.length ?? 0) === 0
        ? []
        : [
            `Customizations: ${this.model.status.customizations?.join("; ") ?? ""}`,
          ]),
      `Packs: ${this.model.status.packs.enabled}/${this.model.status.packs.total} enabled`,
    ];
  }

  private renderRow(row: SettingsRow): readonly string[] {
    const value = row.value.replaceAll("\n", ", ");
    const lines = [`${row.label}: ${value}`];
    if (row.meaning !== undefined && row.meaning.length > 0) {
      lines.push(`  ${this.dim(row.meaning)}`);
    }
    return lines;
  }

  private items(): readonly NativeSettingsItem[] {
    if (this.screen === "home") return homeItems(this.model);
    if (this.screen === "pack-dossier") return [backItem()];

    // SelectList/SettingsList are flat value-list primitives. This component
    // keeps typed actions, panel navigation, and the dossier detail screen in
    // one small state machine, so replacing it with string-valued list items
    // would require a larger rewrite without improving this flow.
    return panelItems(this.screen, this.model);
  }

  private clampSelection(): void {
    this.selected = Math.min(
      this.selected,
      Math.max(0, this.items().length - 1),
    );
  }

  private maxDossierScroll(): number {
    const lineCount = this.message?.dossier?.split("\n").length ?? 0;
    return Math.max(0, lineCount - DOSSIER_VISIBLE_LINES);
  }

  private clampDossierScroll(): void {
    this.dossierScroll = Math.min(this.dossierScroll, this.maxDossierScroll());
  }

  private accent(text: string): string {
    return this.theme.fg?.("accent", text) ?? text;
  }

  private dim(text: string): string {
    return this.theme.fg?.("dim", text) ?? text;
  }

  private warning(text: string): string {
    return this.theme.fg?.("warning", text) ?? text;
  }

  private error(text: string): string {
    return this.theme.fg?.("error", text) ?? text;
  }

  private strong(text: string): string {
    return this.theme.bold?.(text) ?? text;
  }

  private messageText(message: NativeSettingsMessage): string {
    const text = `Last action: ${message.text}`;
    switch (message.level) {
      case "error":
        return this.error(text);
      case "warning":
        return this.warning(text);
      case "info":
        return this.accent(text);
    }
  }
}

function homeItems(model: SettingsReadModel): readonly NativeSettingsItem[] {
  return [
    actionItem(
      `Mode: ${model.currentMode.label}`,
      model.currentMode.description,
      { id: "mode.select", args: {} },
    ),
    ...model.panels.map((descriptor) => ({
      kind: "panel" as const,
      label: descriptor.title,
      description: descriptor.summary,
      panel: panelById(descriptor.id),
    })),
    {
      kind: "close" as const,
      label: "Close",
      description: "Close settings without writing config.",
    },
  ];
}

function panelItems(
  panelId: SettingsPanel["id"],
  model: SettingsReadModel,
): readonly NativeSettingsItem[] {
  switch (panelId) {
    case "reviewer":
      return reviewerItems(model);
    case "scope":
      return scopeItems(model);
    case "packs":
      return packItems(model);
    case "briefing":
      return briefingItems(model);
  }
}

function reviewerItems(
  model: SettingsReadModel,
): readonly NativeSettingsItem[] {
  const configuredModel = model.status.reviewer.configuredModel;
  const gatedToolItems = model.gatedTools.names.map((toolName) =>
    actionItem(
      `Gated tool: ${toolName}`,
      "Toggle this exact non-Bash tool off; Bash cannot be listed.",
      { id: "gated-tools.remove", args: { toolName } },
    ),
  );
  return [
      actionItem(
      `Reviewer model: ${configuredModel ?? "session model"}`,
      "Choose a configured model or return to the active session model; writes require confirmation.",
      { id: "reviewer.model", args: {} },
      ),
    actionItem(
      `Prompt posture: ${model.status.reviewer.promptPosture}`,
      "Choose the evidence threshold used by the model reviewer; writes require confirmation.",
      { id: "reviewer.posture.select", args: {} },
    ),
    actionItem(
      `Gated non-Bash tools: ${model.gatedTools.names.length}`,
      model.gatedTools.addableToolNames.length === 0
        ? "No active non-Bash tools are available to add."
        : "Choose an active non-Bash tool to opt into exact-name Clearance gating.",
      { id: "gated-tools.add", args: {} },
    ),
    ...gatedToolItems,
    actionItem(
      "Show reviewer details",
      "Reviewer settings and current evidence thresholds.",
      { id: "reviewer.open", args: {} },
    ),
    backItem(),
  ];
}

function scopeItems(model: SettingsReadModel): readonly NativeSettingsItem[] {
  const safeHomeEnabled = model.projectScope.safeHomeUseDefaults;
  const agentSupportEnabled = model.projectScope.agentSupportUseDefaults;
  return [
    actionItem(
      `Scope preset: ${scopePresetLabel(model)}`,
      "Choose one behavior bundle; path lists remain unchanged and writes require confirmation.",
      { id: "scope.preset.select", args: {} },
    ),
    actionItem(
      "Show full scope details",
      "Raw and resolved scope views in a scrollable dossier.",
      { id: "scope.open", args: {} },
    ),
    ...scopePathItems("scope.add-path", "Add"),
    ...scopePathItems("scope.remove-path", "Remove"),
    actionItem(
      `Unknown paths: ${model.projectScope.unknownPathBehavior}`,
      "Choose whether ambiguous paths review or deny; writes require confirmation.",
      { id: "scope.unknown-path.select", args: {} },
    ),
    actionItem(
      safeHomeEnabled ? "Safe-home defaults: off" : "Safe-home defaults: on",
      "Toggle implicit developer-oriented safe-home defaults after confirmation.",
      {
        id: "scope.safe-home-defaults",
        args: { enabled: !safeHomeEnabled },
      },
    ),
    actionItem(
      agentSupportEnabled
        ? "Agent-support defaults: off"
        : "Agent-support defaults: on",
      "Toggle built-in Pi support roots for typed read/search/list operations after confirmation.",
      {
        id: "scope.agent-support-defaults",
        args: { enabled: !agentSupportEnabled },
      },
    ),
    backItem(),
  ];
}

export function packItems(
  model: SettingsReadModel,
): readonly NativeSettingsItem[] {
  const toggleable = model.packs.filter((pack) => pack.toggleable);
  return [
    ...toggleable.map((pack) => {
      // Disable targets the scope that actually enables the pack: a pack
      // enabled only in the project overlay is untouched by a global disable.
      const disableScope =
        pack.enabledInProject && !pack.enabledInGlobal ? "project" : "global";
      return actionItem(
        `${pack.enabled ? "●" : "○"} ${pack.title}`,
        pack.enabled
          ? `Enabled${pack.enabledInProject && pack.enabledInGlobal ? " (global + project)" : pack.enabledInProject ? " (project)" : " (global)"}. Disable in ${disableScope} scope after confirmation.`
          : "Available but not enabled. Enable this package pack (global) after confirmation.",
        pack.enabled
          ? {
              id: "packs.disable",
              args: { packId: pack.id, scope: disableScope },
            }
          : {
              id: "packs.enable",
              args: { packId: pack.id, scope: "global" },
            },
      );
    }),
    inputActionItem(
      "Show pack dossier",
      "Enter an installed pack id to inspect its dossier without writing config.",
      "packs.show",
      "packId",
      "Pack id",
      "refuse",
    ),
    backItem(),
  ];
}

function scopePresetLabel(model: SettingsReadModel): string {
  const scope = model.projectScope;
  const preset = inferScopePreset(scope);
  return preset === "custom" ? "Custom" : SCOPE_PRESET_LABELS[preset];
}

function briefingItems(
  model: SettingsReadModel,
): readonly NativeSettingsItem[] {
  const briefing = model.briefing;
  return [
    actionItem(
      `Note mode: ${briefing.mode}`,
      "Choose the inline review-note mode; writes require confirmation.",
      { id: "briefing.mode.select", args: {} },
    ),
    actionItem(
      briefing.showModelLabel ? "Model label: hide" : "Model label: show",
      "Include the reviewer model in the note detail.",
      {
        id: "briefing.model-label",
        args: { enabled: !briefing.showModelLabel },
      },
    ),
    actionItem(
      briefing.accent ? "Accent: off" : "Accent: on",
      "Gold accent on model-allowed calls where the Pi host supports it.",
      { id: "briefing.accent", args: { enabled: !briefing.accent } },
    ),
    backItem(),
  ];
}

function actionItem(
  label: string,
  description: string,
  action: SettingsAction,
): NativeSettingsActionItem {
  return {
    kind: "selection",
    label,
    description,
    selection: { kind: "action", label, action },
  };
}

function inputActionItem(
  label: string,
  description: string,
  actionId: SettingsActionId,
  argName: string,
  prompt: string,
  empty: "null" | "refuse",
  args: Readonly<Record<string, string | boolean | number | null>> = {},
): NativeSettingsActionItem {
  return {
    kind: "selection",
    label,
    description,
    selection: {
      kind: "input-action",
      label,
      actionId,
      args,
      prompt,
      argName,
      empty,
    },
  };
}

function scopePathItems(
  id: ScopePathActionId,
  verb: "Add" | "Remove",
): readonly NativeSettingsActionItem[] {
  const fields = [
    ["roots", "project root"],
    ["writableDirectories", "writable directory"],
    ["tempDirectories", "temp directory"],
    ["deniedDirectories", "denied path"],
    ["safeHomeDirectories", "safe-home entry"],
    ["agentSupportDirectories", "agent-support entry"],
  ] as const satisfies readonly (readonly [ProjectScopeListField, string])[];

  return fields.map(([field, label]) => ({
    kind: "selection" as const,
    label: `${verb} ${label}`,
    description: `${verb} a ${label} through the existing path-scope planner and confirmation path.`,
    selection: {
      kind: "scope-path" as const,
      label: `${verb} ${label}`,
      id,
      field,
    },
  }));
}

function backItem(): NativeSettingsBackItem {
  return {
    kind: "back",
    label: "Back",
    description: "Return to the settings panel list.",
  };
}

function panelById(id: SettingsPanel["id"]): SettingsPanel {
  const panel = SETTINGS_PANELS.find((candidate) => candidate.id === id);
  if (panel === undefined) {
    throw new Error(`unknown settings panel id: ${id}`);
  }
  return panel;
}

function maxLevel(
  levels: readonly ("info" | "warning" | "error")[],
): "info" | "warning" | "error" {
  if (levels.includes("error")) return "error";
  if (levels.includes("warning")) return "warning";
  return "info";
}

function isUp(data: string): boolean {
  return matchesKey(data, Key.up) || data === "k";
}

function isDown(data: string): boolean {
  return matchesKey(data, Key.down) || data === "j";
}

function isHome(data: string): boolean {
  return matchesKey(data, Key.home);
}

function isEnd(data: string): boolean {
  return matchesKey(data, Key.end);
}

function isEnter(data: string): boolean {
  return matchesKey(data, Key.enter);
}

function isBack(data: string): boolean {
  return (
    matchesKey(data, Key.escape) ||
    matchesKey(data, Key.left) ||
    data === "b" ||
    data === "h"
  );
}

function isClose(data: string): boolean {
  return (
    data === "q" ||
    matchesKey(data, Key.ctrl("c")) ||
    matchesKey(data, Key.ctrl("d"))
  );
}

export function truncateAnsi(input: string, width: number): string {
  return truncateToWidth(input, width, width >= 2 ? "…" : "");
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}
