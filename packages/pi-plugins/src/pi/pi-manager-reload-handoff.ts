import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { NativeControlEnvelopeSchema } from "../application/native-control-contract.js";
import type { NativeControlExecutionReport } from "../application/ports/native-control-execution.js";

export type PluginManagerDestination = "installed" | "install-result" | "operation-result";
export type PiManagerHandoffTicket = Readonly<{ id: string }>;
export type PiManagerHandoffClaim = Readonly<{
  destination: PluginManagerDestination;
  result: Promise<NativeControlExecutionReport>;
}>;

export interface PiManagerReloadHandoff {
  open(input: Readonly<{ sessionId: string; cwd: string; destination: PluginManagerDestination }>): PiManagerHandoffTicket;
  claimSuccessor(input: Readonly<{ sessionId: string; cwd: string }>): PiManagerHandoffClaim | undefined;
  publish(ticket: PiManagerHandoffTicket, report: NativeControlExecutionReport): "local" | "successor";
  fail(ticket: PiManagerHandoffTicket, error?: unknown): void;
  closeSession(sessionId: string, reason: SessionShutdownEvent["reason"]): void;
}

type Slot = {
  ticket: PiManagerHandoffTicket;
  sessionId: string;
  cwd: string;
  destination: PluginManagerDestination;
  claimed: boolean;
  settled: boolean;
  resolve: ((value: NativeControlExecutionReport) => void) | undefined;
  reject: ((error: Error) => void) | undefined;
};
type Registry = { byId: Map<string, Slot>; bySession: Map<string, Slot> };

function key(sessionId: string, cwd: string): string { return `${sessionId}\0${cwd}`; }

function registry(namespace: string): Registry {
  const symbol = Symbol.for(`@nklisch/pi-plugins/manager-handoff-v1/${namespace}`);
  const root = globalThis as typeof globalThis & { [key: symbol]: Registry | undefined };
  const existing = root[symbol];
  if (existing !== undefined) return existing;
  const created: Registry = { byId: new Map(), bySession: new Map() };
  Object.defineProperty(root, symbol, { value: created, configurable: false, enumerable: false });
  return created;
}

function validIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

/** Process-local plain-data bridge. No Pi/TUI/context object can enter a slot. */
export function createPiManagerReloadHandoff(options: Readonly<{ namespace?: string }> = {}): PiManagerReloadHandoff {
  const state = registry(options.namespace ?? "default");

  function owned(ticket: PiManagerHandoffTicket): Slot {
    const slot = state.byId.get(ticket.id);
    if (slot === undefined || slot.settled) throw new Error("Pi manager reload handoff is settled or unknown");
    return slot;
  }

  function remove(slot: Slot): void {
    state.byId.delete(slot.ticket.id);
    if (state.bySession.get(key(slot.sessionId, slot.cwd)) === slot) state.bySession.delete(key(slot.sessionId, slot.cwd));
  }

  function reject(slot: Slot): void {
    if (slot.settled) return;
    slot.settled = true;
    slot.reject?.(new Error("Pi manager reload handoff closed"));
    remove(slot);
    slot.resolve = undefined;
    slot.reject = undefined;
  }

  const handoff: PiManagerReloadHandoff = {
    open(input: Readonly<{ sessionId: string; cwd: string; destination: PluginManagerDestination }>): PiManagerHandoffTicket {
      validIdentity(input.sessionId, "session id");
      validIdentity(input.cwd, "cwd");
      const sessionKey = key(input.sessionId, input.cwd);
      if (state.bySession.has(sessionKey)) throw new Error("Pi manager reload handoff is already pending for this session");
      const ticket = Object.freeze({ id: `pi-manager-handoff-v1:${randomUUID()}` });
      const slot: Slot = { ticket, sessionId: input.sessionId, cwd: input.cwd, destination: input.destination, claimed: false, settled: false, resolve: undefined, reject: undefined };
      state.byId.set(ticket.id, slot);
      state.bySession.set(sessionKey, slot);
      return ticket;
    },
    claimSuccessor(input: Readonly<{ sessionId: string; cwd: string }>): PiManagerHandoffClaim | undefined {
      const slot = state.bySession.get(key(input.sessionId, input.cwd));
      if (slot === undefined || slot.claimed || slot.settled) return undefined;
      slot.claimed = true;
      const result = new Promise<NativeControlExecutionReport>((resolve, rejectPromise) => {
        slot.resolve = resolve;
        slot.reject = rejectPromise;
      });
      // The lifecycle attaches immediately, but this guard prevents an
      // unhandled rejection if Pi tears down the successor in the same turn.
      void result.catch(() => undefined);
      return Object.freeze({ destination: slot.destination, result });
    },
    publish(ticket: PiManagerHandoffTicket, report: NativeControlExecutionReport): "local" | "successor" {
      const slot = owned(ticket);
      const plain = JSON.parse(JSON.stringify(report)) as unknown;
      if (plain === null || typeof plain !== "object" || Array.isArray(plain)) throw new TypeError("Pi manager reload report is invalid");
      const value = plain as Record<string, unknown>;
      const delivery = value.delivery;
      const deliveredThrough = value.deliveredThrough;
      if ((delivery !== "complete" && delivery !== "closed" && delivery !== "failed") ||
          !Number.isSafeInteger(deliveredThrough) || (deliveredThrough as number) < -1) {
        throw new TypeError("Pi manager reload report is invalid");
      }
      const validated: NativeControlExecutionReport = Object.freeze({
        envelope: NativeControlEnvelopeSchema.parse(structuredClone(value.envelope)),
        delivery,
        deliveredThrough: deliveredThrough as number,
      });
      slot.settled = true;
      if (!slot.claimed) {
        remove(slot);
        return "local";
      }
      slot.resolve?.(validated);
      remove(slot);
      slot.resolve = undefined;
      slot.reject = undefined;
      return "successor";
    },
    fail(ticket: PiManagerHandoffTicket, _error?: unknown): void {
      reject(owned(ticket));
    },
    closeSession(sessionId: string, reason: SessionShutdownEvent["reason"]): void {
      if (reason === "reload") return;
      for (const slot of [...state.byId.values()]) if (slot.sessionId === sessionId) reject(slot);
    },
  };
  return Object.freeze(handoff);
}
