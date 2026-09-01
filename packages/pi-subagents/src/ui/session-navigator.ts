/**
 * session-navigator.ts — The `/subagents:sessions` command: pick a subagent and
 * read its transcript through Pi's own per-entry session components.
 *
 * The overlay remains a read-only native Pi transcript. Query state is local to
 * this view and uses the same projection as the parent query tool; it never
 * becomes a persisted index or a second message renderer.
 */

import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  getMarkdownTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  type ToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  Input,
  Key,
  type MarkdownTheme,
  matchesKey,
  Spacer,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { debugLog } from "#src/debug";
import type { SessionMessage } from "#src/types";
import { describeActivity, formatDuration, formatModelThinking, type Theme } from "#src/ui/display";
import {
  fileSnapshotSource,
  liveFileSource,
  listNavigableAgents,
  type NavigableSubagent,
  type RunDisplayMetadata,
  type TranscriptSource,
  type TranscriptSourceAvailability,
} from "#src/ui/session-navigation";
import { projectSessionMessages, querySession, type SessionQueryEntry } from "#src/session/query";

// ─────────────────────────────────────────────────────────────────────────────

/** Chrome lines: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;
const VIEWPORT_HEIGHT_PCT = 70;
const OVERLAY_QUERY_LIMIT = 50;

type MatchMark = { readonly index: number; readonly total: number; readonly selected: boolean };

/** Component factory shape Pi's `ui.custom` invokes to mount an overlay. */
export type OverlayComponentFactory<R> = (
  tui: TUI,
  theme: Theme,
  keybindings: unknown,
  done: (result: R) => void,
) => Component;

/** Narrow UI interface — only the `ctx.ui` methods the navigator calls. */
export interface SessionNavigatorUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  custom<R>(component: OverlayComponentFactory<R>, options?: unknown): Promise<R>;
}

/** Parameters for one `/subagents:sessions` invocation. */
export interface SessionNavigatorParams {
  ui: SessionNavigatorUI;
  agents: readonly NavigableSubagent[];
  registry: AgentConfigLookup;
  /** Working directory for tool-call rendering (relative path display). */
  cwd: string;
  /** Reads a persisted session file for the file-snapshot source. */
  readFile: (path: string) => string;
}

/** Options for the read-only transcript overlay. */
export interface TranscriptOverlayOptions {
  tui: TUI;
  theme: Theme;
  source: TranscriptSource;
  run: RunDisplayMetadata;
  done: (result: undefined) => void;
  cwd: string;
  markdownTheme: MarkdownTheme;
}

/**
 * Handler for the `/subagents:sessions` slash command.
 *
 * Lists navigable subagents, lets the operator pick one, and opens its transcript
 * read-only. Receives the agent snapshot (`manager.listAgents()`) rather than the
 * manager, so it stays a reactive consumer with no inbound call into the core.
 */
export class SessionNavigatorHandler {
  async handle({ ui, agents, registry, cwd, readFile }: SessionNavigatorParams): Promise<void> {
    const entries = listNavigableAgents(agents, registry);
    if (entries.length === 0) {
      ui.notify("No subagent sessions to view.", "info");
      return;
    }

    const choice = await ui.select(
      "Subagent sessions",
      entries.map((entry) => entry.label),
    );
    const entry = entries.find((candidate) => candidate.label === choice);
    if (!entry) return;

    let source: TranscriptSource;
    try {
      source = entry.kind === "live"
        ? liveFileSource(entry.record, readFile)
        : fileSnapshotSource(entry.outputFile, readFile);
    } catch {
      ui.notify("Could not read the session transcript file.", "error");
      return;
    }
    const markdownTheme = getMarkdownTheme();
    await ui.custom<undefined>(
      (tui, theme, _keybindings, done) =>
        new TranscriptOverlay({ tui, theme, source, run: entry.run, done, cwd, markdownTheme }),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    );
  }
}

/**
 * Read-only scrollable transcript overlay with literal query navigation.
 *
 * Pi's message/tool components remain the body renderer. `MatchChrome` only
 * adds block-level rails and a bounded match label around those components,
 * which is the intentional fallback because the native components do not expose
 * substring-highlighting hooks.
 */
export class TranscriptOverlay implements Component, Focusable {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private runtimeInterval: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private _focused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly source: TranscriptSource;
  private readonly run: RunDisplayMetadata;
  private readonly done: (result: undefined) => void;
  private readonly cwd: string;
  private readonly markdownTheme: MarkdownTheme;
  private readonly searchInput = new Input();
  private content: Container;
  private sourceMessages: readonly SessionMessage[] = [];
  private matches: readonly SessionQueryEntry[] = [];
  /** Query total, not the capped visible match list; keeps overflow truthful. */
  private totalMatches = 0;
  private matchMarks = new Map<string, MatchMark>();
  private selectedMatchId: string | undefined;
  private searchActive = false;
  private searchCommitted = false;
  private toolsOnly = false;
  private newMatchCount = 0;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor({ tui, theme, source, run, done, cwd, markdownTheme }: TranscriptOverlayOptions) {
    this.tui = tui;
    this.theme = theme;
    this.source = source;
    this.run = run;
    this.done = done;
    this.cwd = cwd;
    this.markdownTheme = markdownTheme;
    try {
      this.content = this.rebuildFromSource(false);
    } catch (error) {
      debugLog("session navigator initial render", error);
      this.content = new Container();
    }
    try {
      this.unsubscribe = source.subscribe(() => this.refreshFromSource());
    } catch (error) {
      debugLog("session navigator subscribe", error);
    }
    if (this.isRunning()) this.runtimeInterval = setInterval(() => this.refreshRuntime(), 100);
  }

  handleInput(data: string): void {
    try {
      if (this.searchActive) {
        this.handleSearchInput(data);
        return;
      }

      if (data === "/") {
        this.beginSearch();
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.escape) || data === "q") {
        this.close();
        return;
      }
      this.handleScrollInput(data);
      this.requestRender();
    } catch (error) {
      debugLog("session navigator input", error);
    }
  }

  render(width: number): string[] {
    try {
      return this.renderSafe(width);
    } catch (error) {
      debugLog("session navigator render", error);
      return [];
    }
  }

  private renderSafe(width: number): string[] {
    if (width < 6) return [];
    this.refreshProjectionIfSourceChanged();
    const th = this.theme;
    const innerW = width - 4;
    const lines: string[] = [];

    const pad = (s: string, len: number): string => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string): string =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    lines.push(hrTop);
    const runtime = formatDuration(this.run.startedAt, this.run.completedAt());
    lines.push(row(th.bold(`Subagent session · ${formatModelThinking(this.run.modelLabel, this.run.thinkingLevel)} · ${runtime}`)));
    lines.push(hrMid);

    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    for (let i = 0; i < viewportHeight; i++) lines.push(row(visible[i] ?? ""));

    lines.push(hrMid);
    lines.push(row(this.footer(innerW, contentLines.length, visibleStart, viewportHeight)));
    lines.push(hrBot);
    return lines;
  }

  invalidate(): void {
    try {
      this.content.invalidate();
      this.searchInput.invalidate();
    } catch (error) {
      debugLog("session navigator invalidate", error);
    }
  }

  dispose(): void {
    this.close(false);
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (error) {
        debugLog("session navigator unsubscribe", error);
      }
    }
  }

  // ---- Search and source updates -------------------------------------------

  private beginSearch(): void {
    this.searchActive = true;
    this.searchInput.focused = true;
    this.searchCommitted = false;
    this.toolsOnly = false;
    this.newMatchCount = 0;
    this.selectedMatchId = undefined;
    this.autoScroll = false;
    this.searchInput.setValue("");
    this.matches = [];
    this.totalMatches = 0;
    this.matchMarks.clear();
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.clearSearch();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.toolsOnly = !this.toolsOnly;
      this.reproject(false);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.searchInput.setValue("");
      this.searchCommitted = false;
      this.reproject(false);
      this.requestRender();
      return;
    }

    const previous = this.searchInput.getValue();
    const shiftEnter = matchesKey(data, "shift+enter");
    const enter = matchesKey(data, Key.enter);
    if (shiftEnter) {
      this.searchCommitted = true;
      this.selectNextMatch(-1);
      this.requestRender();
      return;
    }
    if (enter) {
      this.searchCommitted = true;
      this.selectNextMatch(1);
      this.requestRender();
      return;
    }
    // Printable n/N are literal while editing. Once Enter has committed the
    // query, the mock's n/N navigation shortcuts become active.
    if (this.searchCommitted && (data === "n" || data === "N")) {
      this.selectNextMatch(data === "n" ? 1 : -1);
      this.requestRender();
      return;
    }

    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previous) {
      this.searchCommitted = false;
      this.selectedMatchId = undefined;
      this.newMatchCount = 0;
      this.reproject(false);
      this.requestRender();
    }
  }

  private clearSearch(): void {
    this.searchActive = false;
    this.searchInput.focused = false;
    this.searchCommitted = false;
    this.toolsOnly = false;
    this.newMatchCount = 0;
    this.selectedMatchId = undefined;
    this.searchInput.setValue("");
    this.matches = [];
    this.totalMatches = 0;
    this.matchMarks.clear();
    // Keep the current offset. Tail-following resumes only if the operator is
    // already at the tail, so clearing cannot move the inspected block.
    const maxScroll = Math.max(0, this.buildContentLines(this.innerWidth()).length - this.viewportHeight());
    this.autoScroll = this.scrollOffset >= maxScroll;
    this.content = this.rebuildFromSource(false);
  }

  private selectNextMatch(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    const current = this.selectedMatchId === undefined
      ? -1
      : this.matches.findIndex((entry) => entry.id === this.selectedMatchId);
    const next = current < 0
      ? direction > 0 ? 0 : this.matches.length - 1
      : (current + direction + this.matches.length) % this.matches.length;
    this.selectedMatchId = this.matches[next]!.id;
    this.newMatchCount = 0;
    this.rebuildFromCurrentMessages();
    this.scrollToSelected();
  }

  private reproject(preserveSelection: boolean): void {
    const oldMatches = this.matches;
    const oldIds = new Set(oldMatches.map((entry) => entry.id));
    const priorSelection = this.selectedMatchId;
    const queryResult = this.searchActive && this.searchInput.getValue()
      ? querySession(this.sourceMessages, {
        query: this.searchInput.getValue(),
        kind: "all",
        order: "oldest",
        limit: OVERLAY_QUERY_LIMIT,
        entryFamily: this.toolsOnly ? "tools" : "all",
      })
      : { entries: [], totalMatches: 0 };
    const matches = queryResult.entries;
    this.matches = matches;
    this.totalMatches = queryResult.totalMatches;
    if (!preserveSelection) {
      this.selectedMatchId = undefined;
      this.newMatchCount = 0;
    } else if (priorSelection && matches.some((entry) => entry.id === priorSelection)) {
      this.selectedMatchId = priorSelection;
    } else if (priorSelection && matches.length > 0) {
      const priorIndex = oldMatches.findIndex((entry) => entry.id === priorSelection);
      this.selectedMatchId = matches[Math.min(Math.max(priorIndex, 0), matches.length - 1)]!.id;
    } else if (matches.length === 0) {
      this.selectedMatchId = undefined;
    }
    if (preserveSelection && this.searchActive) {
      this.newMatchCount = matches.filter((entry) => !oldIds.has(entry.id)).length;
    }
    this.matchMarks = new Map(matches.map((entry, index) => [entry.id, {
      index: index + 1,
      total: this.totalMatches,
      selected: entry.id === this.selectedMatchId,
    }]));
  }

  private refreshFromSource(): void {
    if (this.closed) return;
    try {
      const oldMessages = this.sourceMessages;
      this.sourceMessages = this.source.getMessages();
      if (this.sourceMessages !== oldMessages) this.reproject(this.searchActive);
      this.content = this.buildComponents(this.sourceMessages);
      this.tui.requestRender();
    } catch (error) {
      debugLog("session navigator live refresh", error);
    }
  }

  private refreshProjectionIfSourceChanged(): void {
    try {
      const messages = this.source.getMessages();
      if (messages !== this.sourceMessages) {
        this.sourceMessages = messages;
        this.reproject(true);
        this.content = this.buildComponents(messages);
      }
    } catch (error) {
      debugLog("session navigator source projection", error);
    }
  }

  private rebuildFromSource(preserveSelection: boolean): Container {
    this.sourceMessages = this.source.getMessages();
    this.reproject(preserveSelection);
    return this.buildComponents(this.sourceMessages);
  }

  private rebuildFromCurrentMessages(): void {
    this.reproject(true);
    this.content = this.buildComponents(this.sourceMessages);
  }

  // ---- Ordinary transcript navigation -------------------------------------

  private handleScrollInput(data: string): void {
    const totalLines = this.buildContentLines(this.innerWidth()).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, Key.up) || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, "shift+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, Key.pageDown) || matchesKey(data, "shift+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  private scrollToSelected(): void {
    if (!this.selectedMatchId) return;
    const width = this.innerWidth();
    let line = 0;
    let selectedLine: number | undefined;
    for (const child of this.content.children) {
      if (isMatchChrome(child) && child.matchId === this.selectedMatchId) selectedLine = line;
      line += child.render(width).length;
    }
    if (selectedLine === undefined) return;
    const viewport = this.viewportHeight();
    const maxScroll = Math.max(0, this.buildContentLines(width).length - viewport);
    this.scrollOffset = Math.min(maxScroll, Math.max(0, selectedLine - Math.floor(viewport / 3)));
    this.autoScroll = false;
  }

  // ---- Rendering and lifecycle --------------------------------------------

  private footer(innerW: number, contentLineCount: number, visibleStart: number, viewportHeight: number): string {
    if (this.searchActive) {
      const input = this.searchInput.render(Math.max(8, Math.min(32, innerW - 48)))[0] ?? "> ";
      const inputLine = "/" + input.slice(1);
      const filter = `[${this.toolsOnly ? "tools" : "all"}]`;
      const query = this.searchInput.getValue();
      const count = !query
        ? "type to search"
        : this.totalMatches === 0
          ? "0 matches"
          : `${this.totalMatches > OVERLAY_QUERY_LIMIT ? `${OVERLAY_QUERY_LIMIT}+` : this.totalMatches} matches${this.selectedMatchId ? ` [${this.selectedIndex()}/${this.totalMatches}]` : ""}${this.newMatchCount > 0 ? ` (+${this.newMatchCount} new)` : ""}`;
      const source = this.source.availability?.();
      const sourceNote = sourceFooterNote(source);
      const hints = "Enter/n next · Shift+Enter/N prev · Tab filter · Esc clear";
      return truncateToWidth(`${inputLine} ${filter} ${count}${sourceNote} · ${hints}`, innerW, "");
    }
    const scrollPct = contentLineCount <= viewportHeight
      ? "100%"
      : `${Math.round(((visibleStart + viewportHeight) / contentLineCount) * 100)}%`;
    const source = this.source.availability?.();
    const sourceNote = sourceFooterNote(source);
    const footerLeft = ` ${contentLineCount} lines · ${scrollPct}${sourceNote}`;
    const footerRight = "↑↓/j/k scroll · PgUp/PgDn · / search · Esc/q close";
    const gap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
    return truncateToWidth(footerLeft + " ".repeat(gap) + footerRight, innerW, "");
  }

  private selectedIndex(): number {
    const index = this.matches.findIndex((entry) => entry.id === this.selectedMatchId);
    return index < 0 ? 0 : index + 1;
  }

  private buildContentLines(innerW: number): string[] {
    if (innerW <= 0) return [];
    const lines = this.content.render(innerW);
    const streaming = this.source.streaming();
    if (streaming) lines.push("", `◍ ${describeActivity(streaming.activeTools, streaming.responseText)}`);
    return lines.map((line) => truncateToWidth(line, innerW));
  }

  private buildComponents(messages: readonly SessionMessage[]): Container {
    return buildTranscriptComponents(messages, {
      tui: this.tui,
      cwd: this.cwd,
      markdownTheme: this.markdownTheme,
      getToolDefinition: (name) => this.source.getToolDefinition(name),
    }, this.matchMarks, this.theme);
  }

  private isRunning(): boolean {
    try {
      return this.run.completedAt() === undefined;
    } catch (error) {
      debugLog("session navigator runtime state", error);
      return false;
    }
  }

  private refreshRuntime(): void {
    try {
      if (this.closed) {
        this.clearRuntimeInterval();
        return;
      }
      this.refreshProjectionIfSourceChanged();
      if (!this.isRunning()) this.clearRuntimeInterval();
      this.tui.requestRender();
    } catch (error) {
      debugLog("session navigator runtime refresh", error);
      this.clearRuntimeInterval();
    }
  }

  private clearRuntimeInterval(): void {
    if (this.runtimeInterval !== undefined) {
      clearInterval(this.runtimeInterval);
      this.runtimeInterval = undefined;
    }
  }

  private innerWidth(): number { return Math.max(0, this.tui.terminal.columns - 4); }
  private viewportHeight(): number {
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
  }
  private requestRender(): void {
    try { this.tui.requestRender(); } catch (error) { debugLog("session navigator request render", error); }
  }

  private close(notify = true): void {
    if (this.closed) return;
    this.closed = true;
    this.searchInput.focused = false;
    this.clearRuntimeInterval();
    if (notify) {
      try { this.done(undefined); } catch (error) { debugLog("session navigator close", error); }
    }
  }
}

function sourceFooterNote(source: TranscriptSourceAvailability | undefined): string {
  if (source?.kind === "file") return " · released (snapshot)";
  if (source?.kind === "unavailable") return " · released / transcript unavailable";
  return "";
}

/** Dependencies the per-entry component tree needs from the SDK/TUI environment. */
interface TranscriptRenderOptions {
  tui: TUI;
  cwd: string;
  markdownTheme: MarkdownTheme;
  getToolDefinition: (name: string) => ToolDefinition | undefined;
}

/**
 * Build a `Container` of Pi's per-entry components from a message snapshot,
 * mirroring Pi's own interactive-mode `renderSessionContext` mapping. Tool
 * results are matched to their tool-call components by id, exactly as Pi does.
 */
function buildTranscriptComponents(
  messages: readonly SessionMessage[],
  opts: TranscriptRenderOptions,
  marks: ReadonlyMap<string, MatchMark>,
  theme: Theme,
): Container {
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const entries = projectSessionMessages(messages);
  const messageEntries = new Map(entries.filter((entry) => entry.kind === "message").map((entry) => [entry.sourceIndex, entry]));
  const toolEntries = new Map(entries.filter((entry) => entry.kind === "tool_call").map((entry) => [entry.id, entry]));
  for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex++) {
    const message = messages[sourceIndex]!;
    addMessageComponents(
      container,
      message,
      pendingTools,
      opts,
      marks,
      theme,
      messageEntries.get(sourceIndex),
      toolEntries,
      sourceIndex,
    );
  }
  return container;
}

function addMessageComponents(
  container: Container,
  message: SessionMessage,
  pendingTools: Map<string, ToolExecutionComponent>,
  opts: TranscriptRenderOptions,
  marks: ReadonlyMap<string, MatchMark>,
  theme: Theme,
  messageEntry: SessionQueryEntry | undefined,
  toolEntries: ReadonlyMap<string, SessionQueryEntry>,
  sourceIndex: number,
): void {
  const add = (component: Component, entry: SessionQueryEntry | undefined): void => {
    const mark = entry ? marks.get(entry.id) : undefined;
    container.addChild(mark ? new MatchChrome(component, entry!.id, mark, theme) : component);
  };
  switch (message.role) {
    case "assistant": {
      add(new AssistantMessageComponent(message, false, opts.markdownTheme), messageEntry);
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        const tool = new ToolExecutionComponent(
          content.name,
          content.id,
          content.arguments,
          { showImages: false },
          opts.getToolDefinition(content.name),
          opts.tui,
          opts.cwd,
        );
        tool.setExpanded(true);
        add(tool, toolEntries.get(content.id));
        pendingTools.set(content.id, tool);
      }
      break;
    }
    case "toolResult": {
      pendingTools.get(message.toolCallId)?.updateResult(message);
      pendingTools.delete(message.toolCallId);
      break;
    }
    case "user":
      addUserComponents(container, message.content, opts.markdownTheme, messageEntry, marks, theme);
      break;
    case "bashExecution": {
      const bash = new BashExecutionComponent(message.command, opts.tui, message.excludeFromContext);
      if (message.output) bash.appendOutput(message.output);
      bash.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
      add(bash, toolEntries.get(`bash:${sourceIndex}`));
      break;
    }
    case "compactionSummary":
      container.addChild(new Spacer(1));
      const summary = new CompactionSummaryMessageComponent(message, opts.markdownTheme);
      summary.setExpanded(true);
      container.addChild(summary);
      break;
    case "branchSummary":
      container.addChild(new Spacer(1));
      const branch = new BranchSummaryMessageComponent(message, opts.markdownTheme);
      branch.setExpanded(true);
      container.addChild(branch);
      break;
  }
}

/** Render a user message (skill block + text) into the container, mirroring Pi. */
function addUserComponents(
  container: Container,
  content: string | readonly { type: string; text?: string }[],
  markdownTheme: MarkdownTheme,
  entry: SessionQueryEntry | undefined,
  marks: ReadonlyMap<string, MatchMark>,
  theme: Theme,
): void {
  const text = userMessageText(content);
  if (!text) return;
  const mark = entry ? marks.get(entry.id) : undefined;
  const wrap = (component: Component): void => container.addChild(mark ? new MatchChrome(component, entry!.id, mark, theme) : component);
  if (container.children.length > 0) container.addChild(new Spacer(1));

  const skillBlock = parseSkillBlock(text);
  if (!skillBlock) {
    wrap(new UserMessageComponent(text, markdownTheme));
    return;
  }
  wrap(new SkillInvocationMessageComponent(skillBlock, markdownTheme));
  if (skillBlock.userMessage) {
    container.addChild(new Spacer(1));
    wrap(new UserMessageComponent(skillBlock.userMessage, markdownTheme));
  }
}

/** Concatenate the text blocks of a user message's content (mirrors Pi). */
function userMessageText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * Block-level chrome intentionally wraps native rendering; it does not inspect
 * or reformat the child body, so Pi's tool and markdown renderers stay in use.
 */
class MatchChrome implements Component {
  readonly matchId: string;
  private readonly component: Component;
  private readonly mark: MatchMark;
  private readonly theme: Theme;

  constructor(component: Component, matchId: string, mark: MatchMark, theme: Theme) {
    this.component = component;
    this.mark = mark;
    this.matchId = matchId;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (width <= 2) return this.component.render(Math.max(1, width));
    const bodyWidth = width - 2;
    const lines = this.component.render(bodyWidth);
    const color = this.mark.selected ? "accent" : "warning";
    const label = `${this.mark.selected ? "▶ " : ""}MATCH ${this.mark.index}/${this.mark.total}`;
    const header = truncateToWidth(this.theme.fg(color, `╭─ ${label} ─`), width, "");
    return [header, ...lines.map((line) =>
      truncateToWidth(this.theme.fg(color, "│") + " " + line, width, ""),
    )];
  }

  invalidate(): void { this.component.invalidate(); }
}

function isMatchChrome(component: Component): component is MatchChrome {
  return component instanceof MatchChrome;
}
