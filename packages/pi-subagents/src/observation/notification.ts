import { debugLog } from "#src/debug";
import { getLifetimeTotal } from "#src/lifecycle/usage";
import type { Subagent } from "#src/lifecycle/subagent";
import type { SubagentTerminalReason } from "#src/lifecycle/subagent-state";

export interface NotificationDetails {
  id: string;
  description: string;
  runId: number;
  mode: string;
  modelLabel: string;
  thinkingLevel: Subagent["effectiveThinkingLevel"];
  status: string;
  terminalReason?: SubagentTerminalReason;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function getStatusLabel(status: string, reason?: SubagentTerminalReason, error?: string): string {
  if (status === "error") return `Error: ${error ?? "unknown"}`;
  if (reason === "turn_limit_graceful") return "Completed (turn limit)";
  if (reason === "turn_limit_hard") return "Stopped (turn limit)";
  if (status === "stopped") return reason ? `Stopped (${reason.replaceAll("_", " ")})` : "Stopped";
  return "Done";
}

export function formatTaskNotification(record: Subagent, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.stateTerminalReason, record.error);
  const resultPreview = record.result
    ? record.result.length > resultMaxLen ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)" : record.result
    : "No output.";
  const outputFile = record.outputFile;
  return [
    "<task-notification>",
    `<task-id>${record.id}</task-id>`,
    `<run-id>${record.runId}</run-id>`,
    `<mode>${record.mode}</mode>`,
    `<status>${escapeXml(status)}</status>`,
    record.stateTerminalReason ? `<terminal-reason>${record.stateTerminalReason}</terminal-reason>` : null,
    `<model>${escapeXml(record.modelLabel)}</model>`,
    `<thinking_level>${escapeXml(record.effectiveThinkingLevel)}</thinking_level>`,
    `<summary>Subagent "${escapeXml(record.description)}" ${escapeXml(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${getLifetimeTotal(record.lifetimeUsage)}</total_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${record.activeRuntimeMs}</duration_ms></usage>`,
    outputFile ? `<output-file>${escapeXml(outputFile)}</output-file>` : null,
    "</task-notification>",
  ].filter((line): line is string => line !== null).join("\n");
}

export function buildNotificationDetails(record: Subagent, resultMaxLen: number): NotificationDetails {
  return {
    id: record.id,
    description: record.description,
    runId: record.runId,
    mode: record.mode,
    modelLabel: record.modelLabel,
    thinkingLevel: record.effectiveThinkingLevel,
    status: record.status,
    terminalReason: record.stateTerminalReason,
    toolUses: record.toolUses,
    turnCount: record.turnCount,
    maxTurns: record.maxTurns,
    totalTokens: getLifetimeTotal(record.lifetimeUsage),
    durationMs: record.activeRuntimeMs,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result ? record.result.slice(0, resultMaxLen) : "No output.",
  };
}

export function buildEventData(record: Subagent) {
  const usage = record.lifetimeUsage;
  const total = getLifetimeTotal(usage);
  return {
    id: record.id,
    runId: record.runId,
    mode: record.mode,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    terminalReason: record.stateTerminalReason,
    modelLabel: record.modelLabel,
    thinkingLevel: record.effectiveThinkingLevel,
    toolUses: record.toolUses,
    activeRuntimeMs: record.activeRuntimeMs,
    tokens: total > 0 ? { input: usage.input, output: usage.output, total } : undefined,
  };
}

export interface NotificationSystem {
  sendCompletion(record: Subagent): void;
  dispose(): void;
}

export class NotificationManager implements NotificationSystem {
  private readonly pendingNudges = new Map<string, { record: Subagent; runId: number; content: string; details: NotificationDetails }>();
  private parentRunActive = false;
  private disposed = false;

  constructor(private readonly sendMessage: (msg: { customType: string; content: string; display: boolean; details?: unknown }, opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) => void) {}

  sendCompletion(record: Subagent): void {
    if (this.disposed || record.mode !== "detached" || record.consumed) return;
    if (this.parentRunActive) {
      this.pendingNudges.set(`${record.id}:${record.runId}`, {
        record,
        runId: record.runId,
        content: formatTaskNotification(record, 500),
        details: buildNotificationDetails(record, 500),
      });
    } else this.emitIndividualNudge(record);
  }

  onParentAgentStart(): void { if (!this.disposed) this.parentRunActive = true; }

  onParentAgentSettled(): void {
    if (this.disposed) return;
    this.parentRunActive = false;
    const pending = [...this.pendingNudges.values()];
    this.pendingNudges.clear();
    for (const nudge of pending) {
      try {
        // A resume may advance the record while the parent is running. The
        // queued notification describes the old run and must not wake the
        // parent after that run has been superseded (or after delivery mode
        // changed to joined).
        if (
          nudge.runId === nudge.record.runId &&
          nudge.record.mode === "detached" &&
          !nudge.record.isActive() &&
          !nudge.record.consumed
        ) {
          this.emitNudge(nudge.record, nudge.content, nudge.details);
        }
      } catch (error) { debugLog("notification render", error); }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pendingNudges.clear();
  }

  private emitIndividualNudge(record: Subagent): void {
    if (this.disposed || record.consumed || record.mode !== "detached") return;
    this.emitNudge(record, formatTaskNotification(record, 500), buildNotificationDetails(record, 500));
  }

  private emitNudge(record: Subagent, notification: string, details: NotificationDetails, markConsumed = true): void {
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";
    this.sendMessage({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details,
    }, { deliverAs: "followUp", triggerTurn: true });
    if (markConsumed) record.markConsumed();
  }
}
