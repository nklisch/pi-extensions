/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-redundant-type-constituents -- Pi SDK types are not fully exported; see upstream Pi SDK for type improvements */
/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { AgentTypeRegistry } from "#src/config/agent-types";
import { debugLog, runSafely } from "#src/debug";
import type { Subagent } from "#src/lifecycle/subagent";
import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import type { CompactionInfo } from "#src/types";
import { ERROR_STATUSES, formatModelThinking, formatMs, type Theme } from "#src/ui/display";
import { renderWidgetLines, type WidgetAgent } from "#src/ui/widget-renderer";

// ---- Types ----

/** Minimal agent shape needed for widget lifecycle decisions. */
interface AgentSummary {
  readonly id: string;
  readonly status: string;
  readonly completedAt?: number;
}

/** Lightweight state snapshot used by AgentWidget.update() to decide what to show. */
export interface WidgetState {
  readonly runningCount: number;
  readonly queuedCount: number;
  readonly hasFinished: boolean;
  /** True when runningCount > 0 || queuedCount > 0. Included for call-site readability. */
  readonly hasActive: boolean;
}

/**
 * Count agents by status and return a lightweight state snapshot.
 * Pure function — no IO, no side effects. Exported for direct unit testing.
 */
export function assembleWidgetState(
  agents: readonly AgentSummary[],
  shouldShowFinished: (agentId: string, status: string) => boolean,
): WidgetState {
  let runningCount = 0;
  let queuedCount = 0;
  let hasFinished = false;
  for (const a of agents) {
    if (a.status === "running") { runningCount++; }
    else if (a.status === "queued") { queuedCount++; }
    else if (a.completedAt && shouldShowFinished(a.id, a.status)) { hasFinished = true; }
  }
  const hasActive = runningCount > 0 || queuedCount > 0;
  return { runningCount, queuedCount, hasFinished, hasActive };
}

/** Render the aggregate status bar without hiding per-agent model/runtime details. */
export function formatStatusBar(
  state: WidgetState,
  agents: readonly Pick<Subagent, "status" | "modelLabel" | "effectiveThinkingLevel" | "startedAt">[],
  now = Date.now(),
): string | undefined {
  if (!state.hasActive) return undefined;
  const statusParts: string[] = [];
  if (state.runningCount > 0) statusParts.push(`${state.runningCount} running`);
  if (state.queuedCount > 0) statusParts.push(`${state.queuedCount} queued`);
  const total = state.runningCount + state.queuedCount;
  const activeDetails = agents
    .filter((agent) => agent.status === "running" || agent.status === "queued")
    .map((agent) => agent.status === "running"
      ? `${formatModelThinking(agent.modelLabel, agent.effectiveThinkingLevel)} ${formatMs(now - agent.startedAt)}`
      : `${formatModelThinking(agent.modelLabel, agent.effectiveThinkingLevel)} queued`);
  return `${statusParts.join(", ")} agent${total === 1 ? "" : "s"} · ${activeDetails.join(", ")}`;
}

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

// ---- Widget manager ----

export class AgentWidget implements SubagentManagerObserver {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /**
   * Bounded reactive read model: lifecycle callbacks add active background
   * records and the small terminal linger set; render ticks never ask the
   * manager to clone or sort its retained history.
   */
  private readonly backgroundAgents = new Map<string, Subagent>();
  /** Tracks how many turns each finished agent has survived. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;
  /** Pi renders the whole component tree for each requestRender call. */
  private static readonly STATUS_REFRESH_INTERVAL_MS = 500;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(private registry: AgentTypeRegistry) {}

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    const contextChanged = ctx !== this.uiCtx;
    if (contextChanged) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
    // Lifecycle events can arrive before the first tool gives us a UI context.
    // Refresh when that context becomes available, but let update() decide
    // whether any active record actually needs an animation timer.
    if (contextChanged && this.uiCtx && this.backgroundAgents.size > 0) this.refresh();
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age terminal records and remove them before the next render. Completed
    // records linger for one turn; errors and aborted records linger for two.
    for (const [id, age] of this.finishedTurnAge) {
      const record = this.backgroundAgents.get(id);
      const nextAge = age + 1;
      if (!record || nextAge >= this.maxFinishedAge(record.status)) {
        this.finishedTurnAge.delete(id);
        this.backgroundAgents.delete(id);
      } else {
        this.finishedTurnAge.set(id, nextAge);
      }
    }
    this.refresh();
  }

  // ---- SubagentManagerObserver: react to lifecycle, self-drive the timer ----

  /** A subagent started running — ensure the update loop is live and render. */
  onSubagentStarted(record: Subagent) {
    if (!this.trackBackground(record)) return;
    this.finishedTurnAge.delete(record.id);
    this.startLoop();
  }

  /** A background subagent was created (queued) — ensure the loop is live and render. */
  onSubagentCreated(record: Subagent) {
    if (!this.trackBackground(record)) return;
    this.finishedTurnAge.delete(record.id);
    this.startLoop();
  }

  /** A subagent completed — seed its bounded linger entry and render. */
  onSubagentCompleted(record: Subagent) {
    if (!this.trackBackground(record)) return;
    this.finishedTurnAge.set(record.id, 0);
    this.refresh();
  }

  /** A resumed subagent started — ensure the update loop is live and render. */
  onSubagentResumedStarted(record: Subagent) {
    if (!this.trackBackground(record)) return;
    this.finishedTurnAge.delete(record.id);
    this.startLoop();
  }

  /** A resumed subagent settled — seed its terminal linger entry. */
  onSubagentResumed(record: Subagent) {
    if (!this.trackBackground(record)) return;
    this.finishedTurnAge.set(record.id, 0);
    this.refresh();
  }

  /** A subagent's session compacted — render to refresh the compaction count. */
  onSubagentCompacted(record: Subagent, _info: CompactionInfo) {
    if (this.trackBackground(record)) this.refresh();
  }

  /** Remove terminal state when the manager clears a parent session. */
  onSubagentCleared(record: Subagent) {
    if (!this.backgroundAgents.delete(record.id)) return;
    this.finishedTurnAge.delete(record.id);
    this.refresh();
  }

  /** Refresh immediately; update() owns the timer lifecycle. */
  private startLoop() {
    if (!this.uiCtx) return;
    this.refresh();
  }

  /** Ensure the widget update timer is running while active records animate. */
  private ensureTimer() {
    this.widgetInterval ??= setInterval(
      () => this.refresh(),
      AgentWidget.STATUS_REFRESH_INTERVAL_MS,
    );
  }

  /** Stop animated refreshes while leaving any static finished widget intact. */
  private stopTimer() {
    if (this.widgetInterval !== undefined) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    return age < this.maxFinishedAge(status);
  }

  private maxFinishedAge(status: string): number {
    return ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
  }

  /** Add a record only when its immutable invocation snapshot marks it background. */
  private trackBackground(record: Subagent): boolean {
    if (record.invocation?.runInBackground !== true) return false;
    this.backgroundAgents.set(record.id, record);
    return true;
  }

  /** Drop terminal entries whose turn-based linger window has already elapsed. */
  private pruneExpiredFinished(): void {
    for (const [id, record] of this.backgroundAgents) {
      if (record.isActive()) continue;
      if (record.completedAt == null || !this.shouldShowFinished(id, record.status)) {
        this.backgroundAgents.delete(id);
        this.finishedTurnAge.delete(id);
      }
    }
  }

  /** Project a live Subagent record onto a pure-data WidgetAgent snapshot. */
  private toWidgetAgent(record: Subagent): WidgetAgent {
    return {
      id: record.id,
      type: record.type,
      status: record.status,
      description: record.description,
      modelLabel: record.modelLabel,
      thinkingLevel: record.effectiveThinkingLevel,
      toolUses: record.toolUses,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      error: record.error,
      lifetimeUsage: record.lifetimeUsage,
      compactionCount: record.compactionCount,
      turnCount: record.turnCount,
      maxTurns: record.maxTurns,
      activeTools: record.activeTools,
      responseText: record.responseText,
      contextPercent: record.getContextPercent(),
    };
  }

  /** Delegate rendering to the pure widget-renderer module. */
  private renderWidget(tui: any, theme: Theme): string[] {
    return renderWidgetLines({
      agents: [...this.backgroundAgents.values()].map(r => this.toWidgetAgent(r)),
      registry: this.registry,
      spinnerFrame: this.widgetFrame,
      terminalWidth: tui.terminal.columns,
      theme,
      shouldShowFinished: (id, status) => this.shouldShowFinished(id, status),
    });
  }

  /**
   * Unregister the widget, clear the status bar, stop the interval timer, and
   * release the bounded read model once no visible agents remain.
   * Called only from `update`'s idle path — not from `dispose`.
   */
  private clearWidget(): void {
    if (this.widgetRegistered) {
      runSafely("agent widget clear widget", () => this.uiCtx!.setWidget("agents", undefined));
      this.widgetRegistered = false;
      this.tui = undefined;
    }
    if (this.lastStatusText !== undefined) {
      runSafely("agent widget clear status", () => this.uiCtx!.setStatus("subagents", undefined));
      this.lastStatusText = undefined;
    }
    this.stopTimer();
    this.backgroundAgents.clear();
    this.finishedTurnAge.clear();
  }

  /**
   * Compute the status bar text from the current widget state and call
   * `setStatus` only when it differs from the last cached value.
   */
  private updateStatusBar(state: WidgetState, agents: readonly Subagent[]): void {
    const newStatusText = formatStatusBar(state, agents);
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx!.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;

    this.pruneExpiredFinished();
    const backgroundAgents = [...this.backgroundAgents.values()];
    const state = assembleWidgetState(backgroundAgents, (id, status) => this.shouldShowFinished(id, status));

    if (!state.hasActive && !state.hasFinished) {
      this.clearWidget();
      return;
    }

    // Finished records remain renderable for their turn-based linger window,
    // but they have no changing state to animate. Stop the interval while the
    // static completion widget remains registered.
    if (state.hasActive) this.ensureTimer();
    else this.stopTimer();
    this.updateStatusBar(state, backgroundAgents);
    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      try {
        this.uiCtx!.setWidget("agents", (tui, theme) => {
          this.tui = tui;
          return {
            // TUI render callbacks run after the lifecycle callback that
            // registered them; contain SDK/theme failures at this boundary too.
            render: () => {
              try {
                return this.renderWidget(tui, theme);
              } catch (error) {
                debugLog("agent widget render", error);
                return [];
              }
            },
            invalidate: () => {
              // Theme changed — force re-registration so factory captures fresh theme.
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        }, { placement: "aboveEditor" });
        this.widgetRegistered = true;
      } catch (error) {
        debugLog("agent widget register", error);
        this.stopTimer();
      }
    } else {
      // Widget already registered — just request a re-render of existing components.
      runSafely("agent widget request render", () => this.tui?.requestRender());
    }
  }

  /** Contain UI refresh failures and stop a timer that can no longer make progress. */
  private refresh(): void {
    try {
      this.update();
    } catch (error) {
      debugLog("agent widget update", error);
      this.stopTimer();
    }
  }

  // fallow-ignore-next-line unused-class-member
  dispose() {
    this.stopTimer();
    if (this.uiCtx) {
      runSafely("agent widget dispose widget", () => this.uiCtx!.setWidget("agents", undefined));
      runSafely("agent widget dispose status", () => this.uiCtx!.setStatus("subagents", undefined));
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
    this.backgroundAgents.clear();
    this.finishedTurnAge.clear();
  }
}
