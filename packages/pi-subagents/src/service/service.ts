/** Public cross-extension contract for subagent execution control. */

import type {
  SubagentLifecycleInterceptor,
  SubagentLifecycleRegistration,
  SubagentExecutionMode,
} from "#src/lifecycle/lifecycle-interceptor";
import type { SubagentStatus, SubagentStopReason, SubagentTerminalReason } from "#src/lifecycle/subagent-state";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "#src/lifecycle/workspace";
import type { ThinkingLevel } from "#src/types";

export {
  MAX_LIFECYCLE_CONTINUATION_ROUNDS,
  type SubagentExecutionAdmission,
  type SubagentExecutionMode,
  type SubagentExecutionOrigin,
  type SubagentExecutionPhase,
  type SubagentLifecycleCompletionContext,
  type SubagentLifecycleCompletionDecision,
  type SubagentLifecycleExecutionPath,
  type SubagentLifecycleIdentity,
  type SubagentLifecycleInterceptor,
  type SubagentLifecycleOutcome,
  type SubagentLifecycleRegistration,
  type SubagentLifecycleStartContext,
  type SubagentLifecycleStartDecision,
} from "#src/lifecycle/lifecycle-interceptor";
export type { SubagentStatus, SubagentStopReason, SubagentTerminalReason } from "#src/lifecycle/subagent-state";
export type {
  LifetimeUsage,
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
};
export type { SubagentExecutionMode as SubagentMode };

export interface SubagentRecord {
  id: string;
  type: string;
  description: string;
  runId: number;
  mode: SubagentExecutionMode;
  status: SubagentStatus;
  stopRequested: boolean;
  terminalReason?: SubagentTerminalReason;
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  activeRuntimeMs: number;
  modelLabel: string;
  thinkingLevel: ThinkingLevel;
  activeTools: string[];
  currentActivity: string;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  outputFile?: string;
}

export interface LaunchOptions {
  description?: string;
  model?: string;
  maxTurns?: number;
  thinkingLevel?: ThinkingLevel;
  inheritContext?: boolean;
  mode?: SubagentExecutionMode;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export type LaunchDelivery =
  | { kind: "detached"; agentId: string; runId: number }
  | { kind: "joined"; record: SubagentRecord };

export type ResumeDelivery = LaunchDelivery |
  { kind: "not_found"; agentId: string } |
  { kind: "wrong_state"; agentId: string; status: SubagentStatus };

export type StopDelivery =
  | { kind: "stopped"; agentId: string; runId: number; reason: SubagentStopReason; record: SubagentRecord }
  | { kind: "stop_pending"; agentId: string; runId: number; reason: SubagentStopReason; record: SubagentRecord }
  | { kind: "already_terminal"; agentId: string; runId: number; record: SubagentRecord }
  | { kind: "not_found"; agentId: string };

export type SteerDelivery =
  | { kind: "delivered" | "buffered"; agentId: string; runId: number }
  | { kind: "rejected"; agentId: string; runId: number; status: SubagentStatus }
  | { kind: "not_found"; agentId: string };

export type ResultDelivery =
  | { kind: "result"; record: SubagentRecord }
  | { kind: "not_found"; agentId: string };

export type SubagentListState = "active" | "terminal" | "all";
export interface ListOptions {
  state?: SubagentListState;
  limit?: number;
}

export interface SubagentsService {
  launch(type: string, prompt: string, options?: LaunchOptions): Promise<LaunchDelivery>;
  resume(agentId: string, prompt: string, options?: Pick<LaunchOptions, "mode" | "timeoutSeconds" | "signal">): Promise<ResumeDelivery>;
  stop(agentId: string, settlementTimeoutSeconds?: number): Promise<StopDelivery>;
  steer(agentId: string, message: string): Promise<SteerDelivery>;
  list(options?: ListOptions): SubagentRecord[];
  getResult(agentId: string): ResultDelivery;
  getRecord(agentId: string): SubagentRecord | undefined;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
  registerLifecycleInterceptor(interceptor: SubagentLifecycleInterceptor): SubagentLifecycleRegistration;
}

export const SUBAGENT_EVENTS = {
  STARTED: "subagents:started",
  COMPLETED: "subagents:completed",
  RESUMED: "subagents:resumed",
  FAILED: "subagents:failed",
  COMPACTED: "subagents:compacted",
  CREATED: "subagents:created",
  STEERED: "subagents:steered",
} as const;

const SERVICE_KEY = Symbol.for("@nklisch/pi-subagents:service");

export function publishSubagentsService(service: SubagentsService): void {
  (globalThis as Record<symbol, unknown>)[SERVICE_KEY] = service;
}

export function getSubagentsService(): SubagentsService | undefined {
  return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as SubagentsService | undefined;
}

export function unpublishSubagentsService(): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property
  delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
}
