/** Authoritative coarse lifecycle state and metrics for one subagent record. */

import type { LifetimeUsage } from "#src/lifecycle/usage";
import { addUsage } from "#src/lifecycle/usage";

export type SubagentStatus = "queued" | "running" | "completed" | "stopped" | "error";

export type SubagentTerminalReason =
  | "completed"
  | "explicit_stop"
  | "parent_cancelled"
  | "runtime_timeout"
  | "turn_limit_graceful"
  | "turn_limit_hard"
  | "lifecycle_abort"
  | "provider_failure"
  | "execution_failure"
  | "workspace_teardown_failure";

export type SubagentStopReason = "explicit_stop" | "parent_cancelled" | "runtime_timeout";

export interface SubagentStateInit {
  status?: SubagentStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  consumedAt?: number;
  terminalReason?: SubagentTerminalReason;
  toolUses?: number;
  lifetimeUsage?: LifetimeUsage;
  compactionCount?: number;
  turnCount?: number;
  activeTools?: ReadonlyMap<string, string>;
  responseText?: string;
}

export class SubagentState {
  private _status: SubagentStatus;
  get status(): SubagentStatus { return this._status; }

  private _result?: string;
  get result(): string | undefined { return this._result; }

  private _error?: string;
  get error(): string | undefined { return this._error; }

  private _startedAt: number;
  get startedAt(): number { return this._startedAt; }

  private _completedAt?: number;
  get completedAt(): number | undefined { return this._completedAt; }

  private _consumedAt?: number;
  get consumedAt(): number | undefined { return this._consumedAt; }
  get consumed(): boolean { return this._consumedAt != null; }

  private _terminalReason?: SubagentTerminalReason;
  get terminalReason(): SubagentTerminalReason | undefined { return this._terminalReason; }

  private _toolUses: number;
  get toolUses(): number { return this._toolUses; }

  private _lifetimeUsage: LifetimeUsage;
  get lifetimeUsage(): Readonly<LifetimeUsage> { return this._lifetimeUsage; }

  private _compactionCount: number;
  get compactionCount(): number { return this._compactionCount; }

  private _turnCount: number;
  get turnCount(): number { return this._turnCount; }

  private _activeTools: Map<string, string>;
  get activeTools(): ReadonlyMap<string, string> { return this._activeTools; }
  private _toolKeySeq = 0;

  private _responseText: string;
  get responseText(): string { return this._responseText; }

  constructor(init: SubagentStateInit = {}) {
    this._status = init.status ?? "queued";
    this._result = init.result;
    this._error = init.error;
    this._startedAt = init.startedAt ?? Date.now();
    this._completedAt = init.completedAt;
    this._consumedAt = init.consumedAt;
    this._terminalReason = init.terminalReason;
    this._toolUses = init.toolUses ?? 0;
    this._lifetimeUsage = { ...(init.lifetimeUsage ?? { input: 0, output: 0, cacheWrite: 0 }) };
    this._compactionCount = init.compactionCount ?? 0;
    this._turnCount = init.turnCount ?? 1;
    this._activeTools = new Map(init.activeTools ?? []);
    this._responseText = init.responseText ?? "";
  }

  incrementToolUses(): void { this._toolUses++; }
  addUsage(delta: { input: number; output: number; cacheWrite: number }): void { addUsage(this._lifetimeUsage, delta); }
  incrementCompactions(): void { this._compactionCount++; }
  incrementTurnCount(): void { this._turnCount++; }

  addActiveTool(toolName: string): void {
    this._activeTools.set(`${toolName}_${++this._toolKeySeq}`, toolName);
  }

  removeActiveTool(toolName: string): void {
    for (const [key, name] of this._activeTools) {
      if (name === toolName) {
        this._activeTools.delete(key);
        break;
      }
    }
  }

  resetResponseText(): void { this._responseText = ""; }
  appendResponseText(delta: string): void { this._responseText += delta; }

  markRunning(startedAt: number): void {
    this._status = "running";
    this._startedAt = startedAt;
    this._completedAt = undefined;
    this._result = undefined;
    this._error = undefined;
    this._consumedAt = undefined;
    this._terminalReason = undefined;
  }

  markCompleted(result: string, reason: "completed" | "turn_limit_graceful", completedAt = Date.now()): void {
    this._status = "completed";
    this._result = result;
    this._error = undefined;
    this._completedAt = completedAt;
    this._terminalReason = reason;
  }

  markStopped(result: string | undefined, reason: SubagentStopReason | "turn_limit_hard" | "lifecycle_abort", completedAt = Date.now()): void {
    this._status = "stopped";
    this._result = result;
    this._completedAt = completedAt;
    this._terminalReason = reason;
  }

  markError(error: unknown, reason: "provider_failure" | "execution_failure" | "workspace_teardown_failure", result?: string, completedAt = Date.now()): void {
    this._status = "error";
    this._error = error instanceof Error ? error.message : String(error);
    this._result = result?.trim() ? result : undefined;
    this._completedAt = completedAt;
    this._terminalReason = reason;
  }

  markConsumed(at = Date.now()): void { this._consumedAt ??= at; }

  resetForResume(): void {
    this._status = "queued";
    this._completedAt = undefined;
    this._result = undefined;
    this._error = undefined;
    this._consumedAt = undefined;
    this._terminalReason = undefined;
    this._responseText = "";
    this._activeTools.clear();
    this._turnCount = 1;
  }
}
