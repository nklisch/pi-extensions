import { runSafely } from "#src/debug";
import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import { buildEventData, type NotificationSystem } from "#src/observation/notification";
import type { CompactionInfo, Subagent } from "#src/types";

export type EventEmit = (channel: string, data: unknown) => void;
export type AppendEntry = (customType: string, data: unknown) => void;

export interface SubagentEventsObserverDeps {
  emit: EventEmit;
  appendEntry: AppendEntry;
  notifications: NotificationSystem;
}

export class SubagentEventsObserver implements SubagentManagerObserver {
  constructor(private readonly deps: SubagentEventsObserverDeps) {}

  onSubagentStarted(record: Subagent): void {
    runSafely("subagent event emission started", () => this.deps.emit("subagents:started", {
      id: record.id, runId: record.runId, mode: record.mode, type: record.type, description: record.description,
    }));
  }

  onSubagentCompleted(record: Subagent): void {
    const eventData = buildEventData(record);
    const channel = record.status === "error" || record.status === "stopped" ? "subagents:failed" : "subagents:completed";
    runSafely("subagent event emission terminal", () => this.deps.emit(channel, eventData));
    runSafely("subagent record append", () => this.deps.appendEntry("subagents:record", eventData));
    runSafely("subagent completion notification", () => this.deps.notifications.sendCompletion(record));
  }

  onSubagentResumedStarted(record: Subagent): void {
    runSafely("subagent event emission resumed-started", () => this.deps.emit("subagents:started", {
      id: record.id, runId: record.runId, mode: record.mode, type: record.type, description: record.description, resumed: true,
    }));
  }

  onSubagentResumed(record: Subagent): void {
    const eventData = buildEventData(record);
    runSafely("subagent event emission resumed", () => this.deps.emit("subagents:resumed", eventData));
    runSafely("subagent record append resumed", () => this.deps.appendEntry("subagents:record", eventData));
    runSafely("subagent resumed notification", () => this.deps.notifications.sendCompletion(record));
  }

  onSubagentCompacted(record: Subagent, info: CompactionInfo): void {
    runSafely("subagent event emission compacted", () => this.deps.emit("subagents:compacted", {
      id: record.id, runId: record.runId, mode: record.mode, type: record.type, description: record.description,
      reason: info.reason, tokensBefore: info.tokensBefore, compactionCount: record.compactionCount,
    }));
  }

  onSubagentCreated(record: Subagent): void {
    runSafely("subagent event emission created", () => this.deps.emit("subagents:created", {
      id: record.id, runId: record.runId, mode: record.mode, type: record.type, description: record.description,
    }));
  }
}
