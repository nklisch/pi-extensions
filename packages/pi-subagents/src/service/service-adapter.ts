/**
 * service-adapter.ts — Adapter that wraps SubagentManager to satisfy SubagentsService.
 *
 * Handles model resolution at the API boundary, record serialization
 * (stripping non-serializable fields), and session gating.
 */

import type { Model } from "@earendil-works/pi-ai";
import { resolveDispatchAgentType } from "#src/config/agent-type-resolution";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import type {
  SubagentLifecycleInterceptor,
  SubagentLifecycleRegistration,
} from "#src/lifecycle/lifecycle-interceptor";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import type { SpawnOptions, SubagentRecord, SubagentsService } from "#src/service/service";
import { formatModelLabel } from "#src/session/model-label";
import type { ModelRegistry } from "#src/session/model-resolver";
import { resolveDefaultModel } from "#src/session/session-config";
import type { AgentInvocation, SessionContext, Subagent } from "#src/types";

/** Narrow interface for the SubagentManager — avoids coupling to the concrete class. */
export interface SubagentManagerLike {
  spawn(snapshot: ParentSnapshot, type: string, prompt: string, options: unknown): string;
  getRecord(id: string): Subagent | undefined;
  listAgents(): Subagent[];
  abort(id: string): boolean;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
  registerLifecycleInterceptor(
    interceptor: SubagentLifecycleInterceptor,
  ): SubagentLifecycleRegistration;
}

/**
 * Narrow runtime interface consumed by the service adapter.
 * `SubagentRuntime` satisfies this structurally; tests use plain stubs.
 */
export interface ServiceRuntimeLike {
  readonly currentCtx: SessionContext | undefined;
  buildSnapshot(inheritContext: boolean): ParentSnapshot;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

/** Adapter that wraps SubagentManager to satisfy SubagentsService. */
export class SubagentsServiceAdapter implements SubagentsService {
  constructor(
    private readonly manager: SubagentManagerLike,
    private readonly resolveModel: (input: string, registry: ModelRegistry) => Model<any> | string,
    private readonly runtime: ServiceRuntimeLike,
    private readonly agentRegistry?: AgentTypeRegistry,
    private readonly settings?: { readonly fallbackSubagent?: string | false },
  ) {}

  spawn(type: string, prompt: string, options?: SpawnOptions): string {
    if (!this.runtime.currentCtx) {
      throw new Error("No active session — cannot spawn agents outside a session.");
    }

    this.agentRegistry?.reload();
    const resolution = this.agentRegistry
      ? resolveDispatchAgentType(type, this.agentRegistry, this.settings?.fallbackSubagent)
      : { type, requestedType: type, fellBack: false };
    if ("error" in resolution) throw new Error(resolution.error);
    const resolvedType = resolution.type;

    const model = options?.model
      ? this.resolveModelOption(options.model)
      : this.resolveTypeDefaultModel(resolvedType);
    const description = options?.description ?? prompt.slice(0, 80);
    const isBackground = !(options?.foreground ?? false);
    const invocation: AgentInvocation = {
      modelName: formatModelLabel(model),
      maxTurns: options?.maxTurns,
      inheritContext: options?.inheritContext,
      runInBackground: isBackground,
    };

    const snapshot = this.runtime.buildSnapshot(options?.inheritContext ?? false);
    const parent = this.runtime.getSessionInfo();
    return this.manager.spawn(snapshot, resolvedType, prompt, {
      description,
      model,
      maxTurns: options?.maxTurns,
      thinkingLevel: options?.thinkingLevel,
      inheritContext: options?.inheritContext,
      bypassQueue: options?.bypassQueue,
      isBackground,
      origin: "service",
      invocation,
      lifecycleParentSession: parent.parentSessionId
        ? {
            parentSessionFile: parent.parentSessionFile || undefined,
            parentSessionId: parent.parentSessionId,
          }
        : undefined,
    });
  }

  getRecord(id: string): SubagentRecord | undefined {
    const record = this.manager.getRecord(id);
    return record ? toSubagentRecord(record) : undefined;
  }

  listAgents(): SubagentRecord[] {
    return this.manager.listAgents().map(toSubagentRecord);
  }

  abort(id: string): boolean {
    return this.manager.abort(id);
  }

  async steer(id: string, message: string): Promise<boolean> {
    const record = this.manager.getRecord(id);
    if (!record) {
      return false;
    }
    const outcome = await record.steer(message);
    return outcome.kind !== "rejected";
  }

  async waitForAll(): Promise<void> {
    return this.manager.waitForAll();
  }

  hasRunning(): boolean {
    return this.manager.hasRunning();
  }

  registerWorkspaceProvider(provider: WorkspaceProvider): () => void {
    return this.manager.registerWorkspaceProvider(provider);
  }

  registerLifecycleInterceptor(
    interceptor: SubagentLifecycleInterceptor,
  ): SubagentLifecycleRegistration {
    return this.manager.registerLifecycleInterceptor(interceptor);
  }

  /** Resolve a model-string override against the current session's registry. */
  private resolveModelOption(modelInput: string): Model<any> {
    const registry = this.runtime.currentCtx?.modelRegistry;
    if (!registry) {
      throw new Error("No model registry available.");
    }
    const resolved = this.resolveModel(modelInput, registry);
    if (typeof resolved === "string") {
      throw new Error(resolved);
    }
    return resolved;
  }

  /** Resolve the agent type's configured model with the same fallback used by session assembly. */
  private resolveTypeDefaultModel(type: string): Model<any> {
    const ctx = this.runtime.currentCtx!;
    const configured = this.agentRegistry?.resolveAgentConfig(type).model;
    if (!ctx.modelRegistry) return ctx.model as Model<any>;
    return resolveDefaultModel(ctx.model, ctx.modelRegistry, configured) as Model<any>;
  }
}

/**
 * Convert an internal Subagent to a serializable SubagentRecord.
 * Uses an explicit allowlist — new fields must be opted in.
 */
export function toSubagentRecord(record: Subagent): SubagentRecord {
  const out: SubagentRecord = {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    startedAt: record.startedAt,
    lifetimeUsage: record.lifetimeUsage,
    compactionCount: record.compactionCount,
  };

  if (record.result !== undefined) out.result = record.result;
  if (record.error !== undefined) out.error = record.error;
  if (record.completedAt !== undefined) out.completedAt = record.completedAt;

  return out;
}
