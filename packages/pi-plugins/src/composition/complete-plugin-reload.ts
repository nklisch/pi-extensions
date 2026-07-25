import {
  composeActivationObservation,
  type ActivationObservation,
  type LifecycleReloadPort,
} from "../application/ports/lifecycle-reload.js";
import type { ProjectionExpectation } from "../application/ports/runtime-projection.js";
import type { LifecycleTransitionStore } from "../application/ports/lifecycle-transition-store.js";
import type { ScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { PiSessionBindingPort } from "./packaged-plugin-host-contract.js";
import type { RuntimeDesiredState, RuntimeDesiredStateOverride } from "./runtime-desired-state.js";
import type { ComposedSkillHookRuntime } from "./create-skill-hook-runtime.js";
import type { ComposedMcpRuntime } from "./create-mcp-runtime.js";
import type { RuntimeSelection, RuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import type { PiOperationContextPort, PiReloadBroker, PiReloadTicket } from "../pi/pi-reload-broker.js";

export type RuntimeDesiredStateLoader = Readonly<{
  load(signal: AbortSignal, overrides?: readonly RuntimeDesiredStateOverride[]): Promise<RuntimeDesiredState>;
}>;

export type CompletePluginReloadPort = LifecycleReloadPort & Readonly<{
  reconcileCurrent(signal: AbortSignal, expectations?: readonly ProjectionExpectation[]): Promise<readonly ActivationObservation[]>;
  acceptSuccessor(ticket: PiReloadTicket, signal: AbortSignal): Promise<readonly ActivationObservation[]>;
  publishSuccessor(ticket: PiReloadTicket): void;
  failSuccessor(ticket: PiReloadTicket, error?: unknown): void;
}>;

function target(expectation: ProjectionExpectation): string {
  const owner = expectation.kind === "active"
    ? { scope: expectation.projection.scope, plugin: expectation.projection.plugin }
    : { scope: expectation.scope, plugin: expectation.plugin };
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
  transitions(scope: ScopeReference): LifecycleTransitionStore;
  markDraining?(ticketId: string): void;
  sha256: Sha256;
}>): CompletePluginReloadPort {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("complete plugin reload dependencies are required");
  }
  const observed = new Map<string, ActivationObservation>();
  let current: RuntimeDesiredState | undefined;
  let queue = Promise.resolve();
  let successorPublication: Readonly<{ ticket: PiReloadTicket; observations: readonly ActivationObservation[] }> | undefined;

  async function evidenceFor(
    desired: RuntimeDesiredState,
    expectations: readonly ProjectionExpectation[],
    signal: AbortSignal,
  ): Promise<readonly ActivationObservation[]> {
    const byTarget = new Map<string, RuntimeSelection>(desired.selections.map((selection) => [target(selection.skillHook.prepared.expectation), selection]));
    const all = new Map<string, ProjectionExpectation>(desired.selections.map((selection) => [target(selection.skillHook.prepared.expectation), selection.skillHook.prepared.expectation]));
    for (const expectation of expectations) all.set(target(expectation), expectation);
    const results: ActivationObservation[] = [];
    for (const expectation of all.values()) {
      signal.throwIfAborted();
      const skill = await input.skillHook.participant.observe(expectation, signal);
      if (skill.kind !== "ready") throw new Error(`skill/hook observation unavailable: ${skill.kind === "failed" ? skill.code : skill.kind}`);
      const selection = byTarget.get(target(expectation));
      const plannedMcpState = desired.mcp.find((transition) => target(transition.to.expectation) === target(expectation))?.to;
      const mcpState = plannedMcpState ?? (selection === undefined && expectation.kind === "inactive"
        ? { kind: "inactive" as const, expectation }
        : undefined);
      if (mcpState === undefined) throw new Error("MCP desired state is unavailable for complete observation");
      const mcp = await input.mcp.participant.observe({
        from: mcpState,
        to: mcpState,
        currentProject: desired.currentProject,
      }, signal);
      if (mcp.kind !== "ready") throw new Error(`MCP observation unavailable: ${mcp.kind === "failed" ? mcp.code : mcp.kind}`);
      results.push(composeActivationObservation({ expectation, skillsHooks: skill.observation, mcp: mcp.observation }));
    }
    return Object.freeze(results);
  }

  async function restore(previous: RuntimeDesiredState | undefined, failed: RuntimeDesiredState, signal: AbortSignal): Promise<void> {
    input.selections.rollbackCandidate();
    if (previous === undefined) {
      await input.skillHook.participant.reconcile({ active: [], currentProject: failed.currentProject }, signal);
      await input.mcp.reconcileAll(failed.mcp.map((transition) => ({ from: transition.to, to: transition.from })).reverse(), signal);
      return;
    }
    const skills = await input.skillHook.participant.reconcile(previous.skillHook, signal);
    const mcp = await input.mcp.reconcileAll(failed.mcp.map((transition) => ({ from: transition.to, to: transition.from })).reverse(), signal);
    if (skills.kind !== "applied" || mcp.some((result) => result.kind !== "applied" && result.kind !== "unchanged")) {
      throw new Error("previous complete plugin runtime could not be restored");
    }
  }

  async function perform(
    signal: AbortSignal,
    expectations: readonly ProjectionExpectation[],
    overrides: readonly RuntimeDesiredStateOverride[] = [],
  ): Promise<readonly ActivationObservation[]> {
    signal.throwIfAborted();
    const previous = current;
    const desired = await input.desired.load(signal, overrides);
    const candidate = input.selections.beginCandidate(desired.selections, desired.currentProject);
    input.skillHook.quiesce();
    try {
      const skillResult = await input.skillHook.participant.reconcile(desired.skillHook, signal);
      if (skillResult.kind !== "applied") throw new Error("skill/hook reconciliation failed");
      const mcpResults = await input.mcp.reconcileAll(desired.mcp, signal);
      if (mcpResults.some((result) => result.kind !== "applied" && result.kind !== "unchanged")) {
        throw new Error("MCP reconciliation failed");
      }
      const resources = await input.skillHook.resources.discover({
        reason: current === undefined ? "startup" : "reload",
        projectTrusted: desired.currentProject.trust.kind === "trusted",
      }, signal);
      if (resources.kind !== "ready") throw new Error("skill resource discovery failed");
      const observations = await evidenceFor(desired, expectations, signal);
      candidate.commit();
      await input.skillHook.replaceSessionLease(desired.selections, signal);
      current = desired;
      observed.clear();
      for (const observation of observations) observed.set(JSON.stringify({ scope: observation.scope, plugin: observation.plugin }), observation);
      input.skillHook.resume();
      return observations;
    } catch (error) {
      input.skillHook.quiesce();
      try { await restore(previous, desired, new AbortController().signal); }
      catch (restoreError) { throw new AggregateError([error, restoreError], "complete plugin reconciliation and restoration failed"); }
      throw error;
    }
  }

  function reconcileCurrent(signal: AbortSignal, expectations: readonly ProjectionExpectation[] = []): Promise<readonly ActivationObservation[]> {
    const task = queue.then(() => perform(signal, expectations));
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  function reconcileLocal(
    request: Parameters<NonNullable<LifecycleReloadPort["reconcileLocal"]>>[0],
    signal: AbortSignal,
  ): Promise<ActivationObservation> {
    const task = queue.then(async () => {
      const observations = await perform(signal, [request.expectation], [{
        scope: request.scope,
        plugin: request.plugin,
        record: request.target,
      }]);
      const scope = request.expectation.kind === "active" ? request.expectation.projection.scope : request.expectation.scope;
      const observation = observations.find((entry) => entry.plugin === request.plugin && JSON.stringify(entry.scope) === JSON.stringify(scope));
      if (observation === undefined) throw new Error("local recovery observation is unavailable");
      return observation;
    });
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async function acceptSuccessor(ticket: PiReloadTicket, signal: AbortSignal): Promise<readonly ActivationObservation[]> {
    const journal = input.transitions(ticket.scope);
    const entry = await journal.read?.({ scope: ticket.scope, reference: ticket.transition }, signal);
    if (entry?.kind !== "found") throw new Error("reload transition evidence is unavailable");
    const transition = entry.entry.record;
    const task = queue.then(() => perform(signal, [transition.candidateProjection], [{
      scope: transition.scope,
      plugin: transition.plugin,
      record: transition.candidate,
    }]));
    queue = task.then(() => undefined, () => undefined);
    const observations = await task;
    successorPublication = Object.freeze({ ticket, observations });
    return observations;
  }

  function publishSuccessor(ticket: PiReloadTicket): void {
    const publication = successorPublication;
    if (publication === undefined || publication.ticket.id !== ticket.id) throw new Error("Pi reload successor publication is unavailable");
    input.broker.publish(ticket, publication.observations);
    successorPublication = undefined;
  }

  function failSuccessor(ticket: PiReloadTicket, error?: unknown): void {
    if (successorPublication?.ticket.id === ticket.id) successorPublication = undefined;
    input.broker.fail(ticket, error);
  }

  async function reload(request: Parameters<LifecycleReloadPort["reload"]>[0], signal: AbortSignal) {
    const context = input.operationContext.takeReloadContext();
    if (context === undefined) return { kind: "failed" as const, code: "PI_RELOAD_CONTEXT_UNAVAILABLE" };
    const ticket = input.broker.open(input.binding.current(), request.scope, request.transition);
    input.markDraining?.(ticket.id);
    try {
      await context.reload();
      const observations = await input.broker.wait(ticket, signal);
      for (const observation of observations) observed.set(JSON.stringify({ scope: observation.scope, plugin: observation.plugin }), observation);
      return { kind: "accepted" as const };
    } catch {
      input.broker.fail(ticket);
      return { kind: "failed" as const, code: "PI_RELOAD_FAILED" };
    }
  }

  async function observe(request: Parameters<LifecycleReloadPort["observe"]>[0], signal: AbortSignal): Promise<ActivationObservation> {
    signal.throwIfAborted();
    const value = observed.get(JSON.stringify(request));
    if (value === undefined) throw new Error("complete plugin observation is unavailable");
    return value;
  }

  return Object.freeze({ reload, observe, reconcileLocal, reconcileCurrent, acceptSuccessor, publishSuccessor, failSuccessor });
}
