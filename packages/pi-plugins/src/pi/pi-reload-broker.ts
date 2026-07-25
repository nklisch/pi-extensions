import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActivationObservation } from "../application/ports/lifecycle-reload.js";
import type { PendingTransitionRef } from "../domain/state/references.js";
import type { ScopeReference } from "../domain/state/scope.js";
import type { PiSessionBinding } from "../composition/packaged-plugin-host-contract.js";

const REGISTRY = Symbol.for("@nklisch/pi-plugins/reload-broker-v1");

type TicketState = {
  id: string;
  sessionId: string;
  cwd: string;
  scope: ScopeReference;
  transition: PendingTransitionRef;
  claimed: boolean;
  settled: boolean;
  resolve: (observations: readonly ActivationObservation[]) => void;
  reject: (error: unknown) => void;
  promise: Promise<readonly ActivationObservation[]>;
};
type Registry = { tickets: Map<string, TicketState> };

function registry(): Registry {
  const root = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
  if (root[REGISTRY] !== undefined) return root[REGISTRY];
  const created: Registry = { tickets: new Map() };
  Object.defineProperty(root, REGISTRY, { value: created, configurable: false });
  return created;
}

export type PiReloadTicket = Readonly<{ id: string; sessionId: string; cwd: string; scope: ScopeReference; transition: PendingTransitionRef }>;
export type PiOperationContextPort = Readonly<{
  /** Consume the one reload authority carried by an admitted Pi call frame. */
  takeReloadContext(): ExtensionCommandContext | undefined;
}>;
export type PiReloadBroker = Readonly<{
  open(binding: PiSessionBinding, scope: ScopeReference, transition: PendingTransitionRef): PiReloadTicket;
  claimSuccessor(binding: PiSessionBinding): PiReloadTicket | undefined;
  publish(ticket: PiReloadTicket, observations: readonly ActivationObservation[]): void;
  fail(ticket: PiReloadTicket, error?: unknown): void;
  wait(ticket: PiReloadTicket, signal: AbortSignal): Promise<readonly ActivationObservation[]>;
}>;

function publicTicket(state: TicketState): PiReloadTicket {
  return Object.freeze({ id: state.id, sessionId: state.sessionId, cwd: state.cwd, scope: state.scope, transition: state.transition });
}
function exact(state: TicketState, ticket: PiReloadTicket): boolean {
  return state.id === ticket.id && state.sessionId === ticket.sessionId && state.cwd === ticket.cwd &&
    JSON.stringify(state.scope) === JSON.stringify(ticket.scope) && state.transition === ticket.transition;
}

export function createPiReloadBroker(): PiReloadBroker {
  const states = registry();
  function lookup(ticket: PiReloadTicket): TicketState {
    const state = states.tickets.get(ticket.id);
    if (state === undefined || !exact(state, ticket)) throw new Error("Pi reload ticket is unavailable");
    return state;
  }
  function open(binding: PiSessionBinding, scope: ScopeReference, transition: PendingTransitionRef): PiReloadTicket {
    if ([...states.tickets.values()].some((ticket) => !ticket.settled && ticket.sessionId === binding.sessionId)) {
      throw new Error("a Pi reload ticket is already pending for this session");
    }
    let resolve!: TicketState["resolve"];
    let reject!: TicketState["reject"];
    const promise = new Promise<readonly ActivationObservation[]>((accept, decline) => { resolve = accept; reject = decline; });
    // A successor can fail while the predecessor is still inside
    // `await context.reload()`, before it can call wait(). Attach a handler
    // immediately so that exact failure remains broker evidence rather than an
    // unhandled process-level rejection.
    void promise.catch(() => undefined);
    const state: TicketState = { id: randomUUID(), sessionId: binding.sessionId, cwd: binding.cwd, scope, transition, claimed: false, settled: false, resolve, reject, promise };
    states.tickets.set(state.id, state);
    return publicTicket(state);
  }
  function claimSuccessor(binding: PiSessionBinding): PiReloadTicket | undefined {
    const matches = [...states.tickets.values()].filter((ticket) => !ticket.settled && !ticket.claimed && ticket.sessionId === binding.sessionId && ticket.cwd === binding.cwd);
    if (matches.length !== 1) return undefined;
    matches[0]!.claimed = true;
    return publicTicket(matches[0]!);
  }
  function publish(ticket: PiReloadTicket, observations: readonly ActivationObservation[]): void {
    const state = lookup(ticket);
    if (!state.claimed || state.settled) throw new Error("Pi reload ticket cannot be published");
    state.settled = true;
    state.resolve(Object.freeze([...observations]));
  }
  function fail(ticket: PiReloadTicket, error: unknown = new Error("Pi reload successor failed")): void {
    const state = lookup(ticket);
    if (state.settled) return;
    state.settled = true;
    state.reject(error);
  }
  async function wait(ticket: PiReloadTicket, signal: AbortSignal): Promise<readonly ActivationObservation[]> {
    const state = lookup(ticket);
    signal.throwIfAborted();
    const abort = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    try { return await Promise.race([state.promise, abort]); }
    finally { if (state.settled) states.tickets.delete(state.id); }
  }
  return Object.freeze({ open, claimSuccessor, publish, fail, wait });
}
