import {
  SuccessorActivationReportSchema,
  type HostBlockedPluginObservation,
  type LifecycleReloadPort,
  type SuccessorActivationReport,
} from "../application/ports/lifecycle-reload.js";
import type { ScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { PiSessionBindingPort } from "./packaged-plugin-host-contract.js";
import type { RuntimeDesiredState, RuntimeDesiredStateOverride } from "./runtime-desired-state.js";
import type { ComposedSkillHookRuntime } from "./create-skill-hook-runtime.js";
import type { ComposedMcpRuntime } from "./create-mcp-runtime.js";
import type { McpLifecycleState } from "../runtime/mcp/lifecycle-participant.js";
import type { RuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import type { PiOperationContextPort, PiReloadBroker, PiReloadTicket } from "../pi/pi-reload-broker.js";

export type RuntimeDesiredStateLoader = Readonly<{ load(signal: AbortSignal, overrides?: readonly RuntimeDesiredStateOverride[]): Promise<RuntimeDesiredState> }>;
export type CompletePluginReloadPort = LifecycleReloadPort & Readonly<{
  reconcileCurrent(signal: AbortSignal): Promise<SuccessorActivationReport>;
  acceptSuccessor(ticket: PiReloadTicket, signal: AbortSignal): Promise<SuccessorActivationReport>;
  publishSuccessor(ticket: PiReloadTicket): void;
  failSuccessor(ticket: PiReloadTicket, error?: unknown): void;
}>;

function reportFor(
  desired: RuntimeDesiredState,
  mcpFailures: readonly Readonly<{ transition: { to: McpLifecycleState }; code: string }>[],
): SuccessorActivationReport {
  const failures: HostBlockedPluginObservation[] = [...desired.degraded];
  for (const failure of mcpFailures) {
    if (failure.transition.to.kind !== "source") continue;
    const owner = failure.transition.to.expectation.projection;
    failures.push({
      plugin: owner.plugin,
      scope: owner.scope,
      selectedRevision: owner.revision,
      code: `MCP_${failure.code}`,
      explanation: "MCP source registration could not be activated for this session",
    });
  }
  const unique = new Map<string, HostBlockedPluginObservation>();
  for (const failure of failures) {
    const key = JSON.stringify([failure.scope, failure.plugin, failure.selectedRevision, failure.code]);
    unique.set(key, failure);
  }
  const degraded = [...unique.values()];
  return SuccessorActivationReportSchema.parse(degraded.length === 0
    ? { kind: "applied", degraded: [] }
    : { kind: "degraded", degraded });
}

export function createCompletePluginReloadPort(input: Readonly<{
  binding: PiSessionBindingPort;
  operationContext: PiOperationContextPort;
  broker: PiReloadBroker;
  desired: RuntimeDesiredStateLoader;
  selections: RuntimeSelectionCatalog;
  skillHook: ComposedSkillHookRuntime;
  mcp: ComposedMcpRuntime;
  markDraining?(ticketId: string): void;
  sha256: Sha256;
}>): CompletePluginReloadPort {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") throw new TypeError("complete plugin reload dependencies are required");
  let current: RuntimeDesiredState | undefined;
  let queue = Promise.resolve();
  let successorPublication: Readonly<{ ticket: PiReloadTicket; report: SuccessorActivationReport }> | undefined;

  async function perform(signal: AbortSignal, _overrides: readonly RuntimeDesiredStateOverride[] = []): Promise<SuccessorActivationReport> {
    signal.throwIfAborted();
    const desired = await input.desired.load(signal, _overrides);
    const candidate = input.selections.beginCandidate(desired.selections, desired.currentProject);
    input.skillHook.quiesce();
    try {
      const skills = await input.skillHook.participant.reconcile(desired.skillHook, signal);
      if (skills.kind !== "applied") throw new Error("skill/hook reconciliation failed");
      const mcpResults = await input.mcp.reconcileAll(desired.mcp, signal);
      const mcpFailures = mcpResults.flatMap((result, index) =>
        result.kind === "applied" || result.kind === "unchanged"
          ? []
          : [{ transition: desired.mcp[index]!, code: result.kind === "failed" || result.kind === "ambiguous" ? result.code : result.kind === "stale" ? "STALE" : "CANCELLED" }],
      );
      const resources = await input.skillHook.resources.discover({ reason: current === undefined ? "startup" : "reload", projectTrusted: desired.currentProject.trust.kind === "trusted" }, signal);
      if (resources.kind !== "ready") throw new Error("skill resource discovery failed");
      const report = reportFor(desired, mcpFailures);
      candidate.commit();
      current = desired;
      input.skillHook.resume();
      return report;
    } catch (error) {
      input.skillHook.resume();
      throw error;
    }
  }

  function reconcileCurrent(signal: AbortSignal): Promise<SuccessorActivationReport> {
    const task = queue.then(() => perform(signal));
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async function acceptSuccessor(ticket: PiReloadTicket, signal: AbortSignal): Promise<SuccessorActivationReport> {
    const task = queue.then(() => perform(signal));
    queue = task.then(() => undefined, () => undefined);
    const report = await task;
    successorPublication = Object.freeze({ ticket, report });
    return report;
  }

  function publishSuccessor(ticket: PiReloadTicket): void {
    const publication = successorPublication;
    if (publication === undefined || publication.ticket.id !== ticket.id) throw new Error("Pi reload successor publication is unavailable");
    input.broker.publish(ticket, publication.report);
    successorPublication = undefined;
  }

  function failSuccessor(ticket: PiReloadTicket, error?: unknown): void {
    if (successorPublication?.ticket.id === ticket.id) successorPublication = undefined;
    input.broker.fail(ticket, error);
  }

  async function consumeFailure(ticket: PiReloadTicket): Promise<void> {
    // A predecessor can fail before it reaches broker.wait(). Consume the
    // rejected promise here so a ctx.reload() throw cannot leave a settled
    // ticket retained forever in the process-local registry.
    try { await input.broker.wait(ticket, new AbortController().signal); } catch { /* expected */ }
  }

  async function reload(request: Readonly<{ scope: ScopeReference }>, signal: AbortSignal) {
    const context = input.operationContext.takeReloadContext();
    if (context === undefined || !("reload" in context) || typeof context.reload !== "function") return { kind: "failed" as const, code: "PI_RELOAD_CONTEXT_UNAVAILABLE" };
    const ticket = input.broker.open(input.binding.current(), request.scope);
    try {
      input.markDraining?.(ticket.id);
      await context.reload();
      const report = await input.broker.wait(ticket, signal);
      return { kind: "accepted" as const, report };
    } catch (error) {
      try { input.broker.fail(ticket, error); } catch { /* successor may already have settled the ticket */ }
      await consumeFailure(ticket);
      return { kind: "failed" as const, code: "PI_RELOAD_FAILED" };
    }
  }

  return Object.freeze({ reload, reconcileCurrent, acceptSuccessor, publishSuccessor, failSuccessor });
}
