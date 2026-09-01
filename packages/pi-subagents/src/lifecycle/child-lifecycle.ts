/** Ordered child-session lifecycle hooks used by cooperating extensions. */

import { debugLog } from "#src/debug";
import type { SubagentLifecycleOutcome } from "#src/lifecycle/lifecycle-interceptor";

export const SUBAGENT_CHILD_SPAWNING = "subagents:child:spawning";
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";
export const SUBAGENT_CHILD_COMPLETED = "subagents:child:completed";
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

export interface ChildSpawningEvent {
  agentName: string;
  parentSessionId?: string;
}

export interface ChildSessionCreatedEvent {
  sessionId: string;
  parentSessionId?: string;
}

export interface ChildCompletedEvent {
  sessionDir: string;
  agentName: string;
  terminalReason: SubagentLifecycleOutcome | "lifecycle_abort";
}

export interface ChildDisposedEvent {
  sessionId: string;
}

export type LifecycleEmit = (channel: string, data: unknown) => void;

export interface ChildLifecyclePublisher {
  spawning(event: ChildSpawningEvent): void;
  sessionCreated(event: ChildSessionCreatedEvent): void;
  completed(event: ChildCompletedEvent): void;
  disposed(event: ChildDisposedEvent): void;
}

export function createChildLifecyclePublisher(emit: LifecycleEmit): ChildLifecyclePublisher {
  return {
    spawning: (event) => publish(emit, "child lifecycle spawning", SUBAGENT_CHILD_SPAWNING, event),
    sessionCreated: (event) => publish(emit, "child lifecycle session-created", SUBAGENT_CHILD_SESSION_CREATED, event),
    completed: (event) => publish(emit, "child lifecycle completed", SUBAGENT_CHILD_COMPLETED, event),
    disposed: (event) => publish(emit, "child lifecycle disposed", SUBAGENT_CHILD_DISPOSED, event),
  };
}

function publish(emit: LifecycleEmit, context: string, channel: string, data: unknown): void {
  try {
    emit(channel, data);
  } catch (error) {
    debugLog(context, error);
  }
}
