import { runSafely } from "#src/debug";
import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import { buildEventData, type NotificationSystem } from "#src/observation/notification";
import type { CompactionInfo, Subagent } from "#src/types";

/** Emit callback — a subset of `pi.events.emit`. */
export type EventEmit = (channel: string, data: unknown) => void;

/** Append callback — a subset of `pi.appendEntry`. */
export type AppendEntry = (customType: string, data: unknown) => void;

export interface SubagentEventsObserverDeps {
	emit: EventEmit;
	appendEntry: AppendEntry;
	notifications: NotificationSystem;
}

/**
 * Receives agent lifecycle notifications from SubagentManager and dispatches
 * them to three concerns: pi.events lifecycle events, session-entry persistence,
 * and completion notifications.
 *
 * Constructed with narrow deps (emit, appendEntry, NotificationSystem) so all
 * three concerns are unit-testable without booting the extension.
 */
export class SubagentEventsObserver implements SubagentManagerObserver {
	private readonly emit: EventEmit;
	private readonly appendEntry: AppendEntry;
	private readonly notifications: NotificationSystem;

	constructor(deps: SubagentEventsObserverDeps) {
		this.emit = deps.emit;
		this.appendEntry = deps.appendEntry;
		this.notifications = deps.notifications;
	}

	onSubagentStarted(record: Subagent): void {
		// Emit started event when agent transitions to running (including from queue).
		runSafely("subagent event emission started", () => this.emit("subagents:started", {
			id: record.id,
			type: record.type,
			description: record.description,
		}));
	}

	onSubagentCompleted(record: Subagent): void {
		// Emit lifecycle event based on terminal status.
		const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
		const eventData = buildEventData(record);
		if (isError) {
			runSafely("subagent event emission failed", () => this.emit("subagents:failed", eventData));
		} else {
			runSafely("subagent event emission completed", () => this.emit("subagents:completed", eventData));
		}

		// Persist final record for cross-extension history reconstruction.
		runSafely("subagent record append", () => this.appendEntry("subagents:record", {
			id: record.id,
			type: record.type,
			description: record.description,
			status: record.status,
			result: record.result,
			error: record.error,
			startedAt: record.startedAt,
			completedAt: record.completedAt,
		}));

		// The manager decides whether to nudge (it owns the consumed-result state).
		runSafely("subagent completion notification", () => this.notifications.sendCompletion(record));
	}

	onSubagentResumed(record: Subagent): void {
		const eventData = buildEventData(record);
		runSafely("subagent event emission resumed", () => this.emit("subagents:resumed", eventData));
		runSafely("subagent record append resumed", () => this.appendEntry("subagents:record", {
			id: record.id,
			type: record.type,
			description: record.description,
			status: record.status,
			result: record.result,
			error: record.error,
			startedAt: record.startedAt,
			completedAt: record.completedAt,
		}));
	}

	onSubagentCompacted(record: Subagent, info: CompactionInfo): void {
		// Emit compacted event when agent's session compacts (preserves count on record).
		runSafely("subagent event emission compacted", () => this.emit("subagents:compacted", {
			id: record.id,
			type: record.type,
			description: record.description,
			reason: info.reason,
			tokensBefore: info.tokensBefore,
			compactionCount: record.compactionCount,
		}));
	}

	onSubagentCreated(record: Subagent): void {
		// Emit created event for background agents (before limiter admission).
		runSafely("subagent event emission created", () => this.emit("subagents:created", {
			id: record.id,
			type: record.type,
			description: record.description,
			isBackground: true,
		}));
	}
}
