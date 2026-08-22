import { composeActivationObservation, type ActivationObservation, type LifecycleReloadPort } from "../application/ports/lifecycle-reload.js";
import type { ProjectionExpectation } from "../application/ports/runtime-projection.js";
import type { ScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { PiSessionBindingPort } from "./packaged-plugin-host-contract.js";
import type { RuntimeDesiredState, RuntimeDesiredStateOverride } from "./runtime-desired-state.js";
import type { ComposedSkillHookRuntime } from "./create-skill-hook-runtime.js";
import type { ComposedMcpRuntime } from "./create-mcp-runtime.js";
import type { RuntimeSelection, RuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import type { PiOperationContextPort, PiReloadBroker, PiReloadTicket } from "../pi/pi-reload-broker.js";

export type RuntimeDesiredStateLoader = Readonly<{ load(signal: AbortSignal, overrides?: readonly RuntimeDesiredStateOverride[]): Promise<RuntimeDesiredState> }>;
export type CompletePluginReloadPort = LifecycleReloadPort & Readonly<{
  reconcileCurrent(signal: AbortSignal): Promise<readonly ActivationObservation[]>;
  acceptSuccessor(ticket: PiReloadTicket, signal: AbortSignal): Promise<readonly ActivationObservation[]>;
  publishSuccessor(ticket: PiReloadTicket): void;
  failSuccessor(ticket: PiReloadTicket, error?: unknown): void;
}>;
function target(expectation: ProjectionExpectation): string {
  const owner = expectation.kind === "active" ? { scope: expectation.projection.scope, plugin: expectation.projection.plugin } : { scope: expectation.scope, plugin: expectation.plugin };
  return JSON.stringify(owner);
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
  let successorPublication: Readonly<{ ticket: PiReloadTicket; observations: readonly ActivationObservation[] }> | undefined;

  async function evidenceFor(desired: RuntimeDesiredState, expectations: readonly ProjectionExpectation[], signal: AbortSignal): Promise<readonly ActivationObservation[]> {
    const byTarget = new Map<string, RuntimeSelection>(desired.selections.map((selection) => [target(selection.skillHook.prepared.expectation), selection]));
    const all = new Map<string, ProjectionExpectation>(desired.selections.map((selection) => [target(selection.skillHook.prepared.expectation), selection.skillHook.prepared.expectation]));
    for (const expectation of expectations) all.set(target(expectation), expectation);
    const results: ActivationObservation[] = [];
    for (const expectation of all.values()) {
      signal.throwIfAborted();
      const skill = await input.skillHook.participant.observe(expectation, signal);
      if (skill.kind !== "ready") continue;
      const selection = byTarget.get(target(expectation));
      const plannedMcpState = desired.mcp.find((transition) => target(transition.to.expectation) === target(expectation))?.to;
      const mcpState = plannedMcpState ?? (selection === undefined && expectation.kind === "inactive" ? { kind: "inactive" as const, expectation } : undefined);
      if (mcpState === undefined) continue;
      const mcp = await input.mcp.participant.observe({ from: mcpState, to: mcpState, currentProject: desired.currentProject }, signal);
      if (mcp.kind !== "ready") continue;
      try { results.push(composeActivationObservation({ expectation, skillsHooks: skill.observation, mcp: mcp.observation })); } catch { /* degraded entries remain visible to runtime reconstruction */ }
    }
    return Object.freeze(results);
  }

  async function perform(signal: AbortSignal, expectations: readonly ProjectionExpectation[] = [], overrides: readonly RuntimeDesiredStateOverride[] = []): Promise<readonly ActivationObservation[]> {
    signal.throwIfAborted();
    const desired = await input.desired.load(signal, overrides);
    const candidate = input.selections.beginCandidate(desired.selections, desired.currentProject);
    input.skillHook.quiesce();
    try {
      const skills = await input.skillHook.participant.reconcile(desired.skillHook, signal);
      if (skills.kind !== "applied") throw new Error("skill/hook reconciliation failed");
      const mcp = await input.mcp.reconcileAll(desired.mcp, signal);
      if (mcp.some((result) => result.kind !== "applied" && result.kind !== "unchanged")) throw new Error("MCP reconciliation failed");
      const resources = await input.skillHook.resources.discover({ reason: current === undefined ? "startup" : "reload", projectTrusted: desired.currentProject.trust.kind === "trusted" }, signal);
      if (resources.kind !== "ready") throw new Error("skill resource discovery failed");
      const observations = await evidenceFor(desired, expectations, signal);
      candidate.commit();
      current = desired;
      input.skillHook.resume();
      return observations;
    } catch (error) {
      input.skillHook.resume();
      throw error;
    }
  }
  function reconcileCurrent(signal: AbortSignal): Promise<readonly ActivationObservation[]> {
    const task = queue.then(() => perform(signal)); queue = task.then(() => undefined, () => undefined); return task;
  }
  async function acceptSuccessor(ticket: PiReloadTicket, signal: AbortSignal): Promise<readonly ActivationObservation[]> {
    const task = queue.then(() => perform(signal)); queue = task.then(() => undefined, () => undefined);
    const observations = await task; successorPublication = Object.freeze({ ticket, observations }); return observations;
  }
  function publishSuccessor(ticket: PiReloadTicket): void {
    const publication = successorPublication;
    if (publication === undefined || publication.ticket.id !== ticket.id) throw new Error("Pi reload successor publication is unavailable");
    input.broker.publish(ticket, publication.observations); successorPublication = undefined;
  }
  function failSuccessor(ticket: PiReloadTicket, error?: unknown): void { if (successorPublication?.ticket.id === ticket.id) successorPublication = undefined; input.broker.fail(ticket, error); }
  async function reload(request: Readonly<{ scope: ScopeReference }>, signal: AbortSignal) {
    const context = input.operationContext.takeReloadContext();
    if (context === undefined || !("reload" in context) || typeof context.reload !== "function") return { kind: "failed" as const, code: "PI_RELOAD_CONTEXT_UNAVAILABLE" };
    const ticket = input.broker.open(input.binding.current(), request.scope); input.markDraining?.(ticket.id);
    try { await context.reload(); const observations = await input.broker.wait(ticket, signal); void observations; return { kind: "accepted" as const }; }
    catch { input.broker.fail(ticket); return { kind: "failed" as const, code: "PI_RELOAD_FAILED" }; }
  }
  return Object.freeze({ reload, reconcileCurrent, acceptSuccessor, publishSuccessor, failSuccessor });
}
