/** Adapter from the public service contract to the authoritative manager. */

import type { Model } from "@earendil-works/pi-ai";
import { resolveDispatchAgentType } from "#src/config/agent-type-resolution";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import type {
  SubagentLifecycleInterceptor,
  SubagentLifecycleRegistration,
} from "#src/lifecycle/lifecycle-interceptor";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import type { AgentSpawnConfig, DeliveryOutcome, ManagerSteerOutcome, ResumeOutcome, StopOutcome } from "#src/lifecycle/subagent-manager";
import type { Subagent } from "#src/lifecycle/subagent";
import type {
  LaunchDelivery,
  LaunchOptions,
  ListOptions,
  ResultDelivery,
  ResumeDelivery,
  StopDelivery,
  SteerDelivery,
  SubagentRecord,
  SubagentsService,
} from "#src/service/service";
import { formatModelLabel } from "#src/session/model-label";
import { resolveEffectiveThinkingLevel } from "#src/session/thinking-level";
import type { ModelRegistry } from "#src/session/model-resolver";
import { resolveDefaultModel } from "#src/session/session-config";
import type { AgentInvocation, SessionContext, SubagentMode, ThinkingLevel } from "#src/types";
import { describeActivity } from "#src/ui/display";

export interface SubagentManagerLike {
  launch(snapshot: ParentSnapshot, type: string, prompt: string, options: AgentSpawnConfig): Promise<DeliveryOutcome>;
  resume(id: string, prompt: string, mode: SubagentMode, timeoutSeconds: number | undefined, signal?: AbortSignal): Promise<ResumeOutcome>;
  stop(id: string, settlementTimeoutSeconds?: number): Promise<StopOutcome>;
  steer(id: string, message: string): Promise<ManagerSteerOutcome>;
  getRecord(id: string): Subagent | undefined;
  listAgents(): Subagent[];
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
  registerLifecycleInterceptor(interceptor: SubagentLifecycleInterceptor): SubagentLifecycleRegistration;
}

export interface ServiceRuntimeLike {
  readonly currentCtx: SessionContext | undefined;
  buildSnapshot(inheritContext: boolean): ParentSnapshot;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

export class SubagentsServiceAdapter implements SubagentsService {
  constructor(
    private readonly manager: SubagentManagerLike,
    private readonly resolveModel: (input: string, registry: ModelRegistry) => Model<any> | string,
    private readonly runtime: ServiceRuntimeLike,
    private readonly agentRegistry?: AgentTypeRegistry,
    private readonly settings?: { readonly fallbackSubagent?: string | false },
  ) {}

  async launch(type: string, prompt: string, options?: LaunchOptions): Promise<LaunchDelivery> {
    const ctx = this.requireContext();
    this.agentRegistry?.reload();
    const resolution = this.agentRegistry
      ? resolveDispatchAgentType(type, this.agentRegistry, this.settings?.fallbackSubagent)
      : { type, requestedType: type, fellBack: false };
    if ("error" in resolution) throw new Error(resolution.error);

    const resolvedType = resolution.type;
    const agentConfig = this.agentRegistry?.resolveAgentConfig(resolvedType);
    const model = options?.model
      ? this.resolveModelOption(options.model)
      : this.resolveTypeDefaultModel(resolvedType);
    const mode = normalizeMode(options?.mode ?? agentConfig?.mode);
    const description = options?.description ?? prompt.slice(0, 80);
    const thinking = options?.thinkingLevel ?? agentConfig?.thinking;
    const maxTurns = normalizeMaxTurns(options?.maxTurns ?? agentConfig?.maxTurns);
    const timeoutSeconds = options?.timeoutSeconds ?? agentConfig?.timeoutSeconds;
    const inheritContext = options?.inheritContext ?? agentConfig?.inheritContext ?? false;
    const snapshot = this.runtime.buildSnapshot(inheritContext);
    const effectiveThinkingLevel = resolveEffectiveThinkingLevel(model, thinking, snapshot.thinkingLevel);
    const invocation: AgentInvocation = {
      modelName: formatModelLabel(model),
      maxTurns,
      inheritContext,
      mode,
      timeoutSeconds,
    };
    const parent = this.runtime.getSessionInfo();

    const outcome = await this.manager.launch(snapshot, resolvedType, prompt, {
      description,
      model,
      maxTurns,
      thinkingLevel: effectiveThinkingLevel,
      inheritContext,
      mode,
      timeoutSeconds: normalizeTimeout(timeoutSeconds),
      origin: "service",
      invocation,
      signal: options?.signal,
      lifecycleParentSession: parent.parentSessionId
        ? { parentSessionFile: parent.parentSessionFile || undefined, parentSessionId: parent.parentSessionId }
        : undefined,
    });
    if (outcome.kind === "joined") outcome.record.markConsumed();
    return this.toLaunchDelivery(outcome);
  }

  async resume(
    agentId: string,
    prompt: string,
    options?: Pick<LaunchOptions, "mode" | "timeoutSeconds" | "signal">,
  ): Promise<ResumeDelivery> {
    const mode = options?.mode ?? "detached";
    const outcome = await this.manager.resume(
      agentId,
      prompt,
      mode,
      normalizeTimeout(options?.timeoutSeconds),
      options?.signal,
    );
    if (outcome.kind === "joined") {
      outcome.record.markConsumed();
      return { kind: "joined", record: toSubagentRecord(outcome.record) };
    }
    if (outcome.kind === "detached") return outcome;
    return outcome;
  }

  async stop(agentId: string, settlementTimeoutSeconds = 5): Promise<StopDelivery> {
    const timeout = normalizeSettlementTimeout(settlementTimeoutSeconds);
    const outcome = await this.manager.stop(agentId, timeout);
    if (outcome.kind === "not_found") return outcome;
    if (outcome.kind === "already_terminal") return { ...outcome, record: toSubagentRecord(outcome.record) };
    return { ...outcome, record: toSubagentRecord(outcome.record) };
  }

  async steer(agentId: string, message: string): Promise<SteerDelivery> {
    const outcome = await this.manager.steer(agentId, message);
    if (outcome.kind === "not_found") return outcome;
    if (outcome.kind === "rejected") return { ...outcome, agentId };
    return { ...outcome, agentId };
  }

  list(options?: ListOptions): SubagentRecord[] {
    const state = options?.state ?? "all";
    const limit = normalizeListLimit(options?.limit);
    return this.manager.listAgents()
      .filter((record) => state === "all" || (state === "active" ? record.isActive() : !record.isActive()))
      .slice(0, limit)
      .map(toSubagentRecord);
  }

  getResult(agentId: string): ResultDelivery {
    const record = this.manager.getRecord(agentId);
    if (!record) return { kind: "not_found", agentId };
    if (!record.isActive()) record.markConsumed();
    return { kind: "result", record: toSubagentRecord(record) };
  }

  getRecord(agentId: string): SubagentRecord | undefined {
    const record = this.manager.getRecord(agentId);
    return record ? toSubagentRecord(record) : undefined;
  }

  waitForAll(): Promise<void> { return this.manager.waitForAll(); }
  hasRunning(): boolean { return this.manager.hasRunning(); }
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void { return this.manager.registerWorkspaceProvider(provider); }
  registerLifecycleInterceptor(interceptor: SubagentLifecycleInterceptor): SubagentLifecycleRegistration { return this.manager.registerLifecycleInterceptor(interceptor); }

  private requireContext(): SessionContext {
    if (!this.runtime.currentCtx) throw new Error("No active session — cannot launch agents outside a session.");
    return this.runtime.currentCtx;
  }

  private resolveModelOption(input: string): Model<any> {
    const registry = this.runtime.currentCtx?.modelRegistry;
    if (!registry) throw new Error("No model registry available.");
    const resolved = this.resolveModel(input, registry);
    if (typeof resolved === "string") throw new Error(resolved);
    return resolved;
  }

  private resolveTypeDefaultModel(type: string): Model<any> {
    const ctx = this.runtime.currentCtx!;
    const configured = this.agentRegistry?.resolveAgentConfig(type).model;
    if (!ctx.modelRegistry) return ctx.model as Model<any>;
    return resolveDefaultModel(ctx.model, ctx.modelRegistry, configured) as Model<any>;
  }

  private toLaunchDelivery(outcome: DeliveryOutcome): LaunchDelivery {
    return outcome.kind === "joined"
      ? { kind: "joined", record: toSubagentRecord(outcome.record) }
      : outcome;
  }
}

export function toSubagentRecord(record: Subagent): SubagentRecord {
  const activeTools = [...record.activeTools.values()];
  const out: SubagentRecord = {
    id: record.id,
    type: record.type,
    description: record.description,
    runId: record.runId,
    mode: record.mode,
    status: record.status,
    stopRequested: record.stopRequested,
    terminalReason: record.stateTerminalReason,
    toolUses: record.toolUses,
    startedAt: record.startedAt,
    activeRuntimeMs: record.activeRuntimeMs,
    modelLabel: record.modelLabel,
    thinkingLevel: record.effectiveThinkingLevel,
    activeTools,
    currentActivity: describeActivity(record.activeTools, record.responseText),
    lifetimeUsage: { ...record.lifetimeUsage },
    compactionCount: record.compactionCount,
  };
  if (record.result !== undefined) out.result = boundResult(record.result, record.outputFile);
  if (record.error !== undefined) out.error = record.error;
  if (record.completedAt !== undefined) out.completedAt = record.completedAt;
  if (record.outputFile !== undefined) out.outputFile = record.outputFile;
  return out;
}

const MAX_RESULT_OUTPUT = 12_000;
function boundResult(result: string, outputFile: string | undefined): string {
  return result.length > MAX_RESULT_OUTPUT
    ? result.slice(0, MAX_RESULT_OUTPUT) + `\n\nOutput truncated. Full transcript: ${outputFile ?? "unavailable"}`
    : result;
}

function normalizeMode(value: string | undefined): SubagentMode {
  if (value == null) return "detached";
  if (value !== "joined" && value !== "detached") throw new RangeError("mode must be joined or detached");
  return value;
}

function normalizeMaxTurns(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new RangeError("maxTurns must be a non-negative integer");
  return value;
}

function normalizeTimeout(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError("timeoutSeconds must be a positive integer");
  return value;
}

function normalizeSettlementTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 30) throw new RangeError("settlementTimeoutSeconds must be an integer from 1 to 30");
  return value;
}

function normalizeListLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer from 1 to 100");
  return limit;
}
