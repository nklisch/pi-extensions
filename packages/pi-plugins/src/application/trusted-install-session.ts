import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleOperationIdPort } from "./ports/lifecycle-operation-id.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { Sha256 } from "../domain/source.js";
import type { PluginConfigurationDocument } from "../domain/configured-values.js";
import type { ConfigurationRecoveryCapability } from "./configuration-service.js";
import type { TrustedInstallCandidate } from "./trusted-install-candidate.js";
import {
  TrustedInstallSessionPolicy,
  type TrustedInstallActivationResult,
  type TrustedInstallProgressEvent,
  type TrustedInstallSessionState,
  type TrustedInstallSessionToken,
} from "./trusted-install-contract.js";
import { createTrustedInstallSessionToken, verifyTrustedInstallSessionToken } from "./trusted-install-identifiers.js";

export type PendingTrustedInstallConfigurationRecovery =
  | Readonly<{ kind: "ambiguous"; recovery: ConfigurationRecoveryCapability }>
  | Readonly<{ kind: "stored-cleanup"; recovery: ConfigurationRecoveryCapability; document: PluginConfigurationDocument }>
  | Readonly<{ kind: "stale-cleanup"; recovery: ConfigurationRecoveryCapability }>
  | Readonly<{ kind: "retry-save"; recovery: ConfigurationRecoveryCapability }>;

export type TrustedInstallSessionEntry = {
  readonly token: TrustedInstallSessionToken;
  readonly candidate: TrustedInstallCandidate;
  readonly createdMonotonic: number;
  readonly createdEpoch: number;
  lastAccessMonotonic: number;
  version: number;
  state: TrustedInstallSessionState;
  readonly controller: AbortController;
  readonly progress: TrustedInstallProgressEvent[];
  retained: { configuration: boolean; trust: boolean };
  configurationRevision?: ContentDigest;
  configurationRecovery?: PendingTrustedInstallConfigurationRecovery;
  trustRecoveryPending?: true;
  result?: TrustedInstallActivationResult;
  terminalMonotonic?: number;
};

export type TrustedInstallSessionLookup =
  | Readonly<{ kind: "found"; entry: TrustedInstallSessionEntry }>
  | Readonly<{ kind: "missing" | "expired" | "disposed" }>;

const terminalStates = new Set<TrustedInstallSessionState>([
  "succeeded", "current-state", "cancelled", "rejected", "stale", "conflict",
  "rolled-back", "recovery-required", "failed", "expired", "disposed",
]);

export function createTrustedInstallSessionRegistry(dependencies: Readonly<{
  clock: LifecycleClock;
  sessionIds: LifecycleOperationIdPort;
  hostEpoch: ContentDigest;
  sha256: Sha256;
}>) {
  const entries = new Map<TrustedInstallSessionToken, TrustedInstallSessionEntry>();
  let accepting = true;
  let disposed = false;

  function now() { return dependencies.clock.monotonicMilliseconds(); }
  function expired(entry: TrustedInstallSessionEntry, at = now()): boolean {
    return at - entry.lastAccessMonotonic >= TrustedInstallSessionPolicy.idleTtlMs ||
      at - entry.createdMonotonic >= TrustedInstallSessionPolicy.absoluteTtlMs;
  }
  async function expire(entry: TrustedInstallSessionEntry): Promise<void> {
    if (entry.state === "expired") return;
    entry.state = "expired";
    entry.terminalMonotonic = now();
    entry.controller.abort(new DOMException("trusted-install session expired", "AbortError"));
    await entry.candidate.lease.release();
  }
  async function reap(): Promise<void> {
    const at = now();
    for (const [token, entry] of entries) {
      if (entry.terminalMonotonic === undefined && expired(entry, at)) await expire(entry);
      if (entry.terminalMonotonic !== undefined && at - entry.terminalMonotonic >= TrustedInstallSessionPolicy.terminalRetentionMs) entries.delete(token);
    }
  }

  return Object.freeze({
    async create(candidate: TrustedInstallCandidate, signal: AbortSignal): Promise<TrustedInstallSessionEntry> {
      if (!accepting || disposed) throw new Error("trusted-install session registry is closed");
      await reap();
      const id = await dependencies.sessionIds.create(signal);
      const token = createTrustedInstallSessionToken(id, dependencies.hostEpoch, dependencies.sha256);
      const createdMonotonic = now();
      const entry: TrustedInstallSessionEntry = {
        token, candidate, createdMonotonic, createdEpoch: dependencies.clock.nowEpochMilliseconds(),
        lastAccessMonotonic: createdMonotonic, version: 0, state: "awaiting-input",
        controller: new AbortController(), progress: [], retained: { configuration: false, trust: false },
      };
      entries.set(token, entry);
      return entry;
    },
    async lookup(token: TrustedInstallSessionToken, touch = true): Promise<TrustedInstallSessionLookup> {
      if (disposed) return { kind: "disposed" };
      await reap();
      if (verifyTrustedInstallSessionToken(token, dependencies.hostEpoch, dependencies.sha256) === undefined) return { kind: "missing" };
      const entry = entries.get(token);
      if (entry === undefined) return { kind: "missing" };
      if (entry.state === "expired") return { kind: "expired" };
      if (entry.state === "disposed") return { kind: "disposed" };
      if (touch && entry.terminalMonotonic === undefined) entry.lastAccessMonotonic = now();
      return { kind: "found", entry };
    },
    expiresAt(entry: TrustedInstallSessionEntry): number {
      // performance.now() is fractional; public epoch contracts are integer
      // milliseconds. Flooring avoids extending either idle or absolute TTL.
      return Math.floor(entry.createdEpoch + Math.min(
        entry.lastAccessMonotonic - entry.createdMonotonic + TrustedInstallSessionPolicy.idleTtlMs,
        TrustedInstallSessionPolicy.absoluteTtlMs,
      ));
    },
    finish(entry: TrustedInstallSessionEntry, state: TrustedInstallSessionState, result: TrustedInstallActivationResult): void {
      entry.state = state;
      entry.result = result;
      entry.terminalMonotonic = now();
    },
    pause(entry: TrustedInstallSessionEntry, state: TrustedInstallSessionState, result: TrustedInstallActivationResult): void {
      entry.state = state;
      entry.result = result;
      delete entry.terminalMonotonic;
    },
    restore(entry: TrustedInstallSessionEntry): void {
      entry.state = "awaiting-input";
      delete entry.result;
      delete entry.terminalMonotonic;
    },
    quiesce(): void { accepting = false; },
    async reap(): Promise<void> { await reap(); },
    async close(): Promise<void> {
      if (disposed) return;
      accepting = false;
      const failures: unknown[] = [];
      for (const entry of entries.values()) {
        entry.controller.abort(new DOMException("trusted-install session disposed", "AbortError"));
        if (entry.configurationRecovery !== undefined) {
          try {
            const settlement = await entry.configurationRecovery.recovery.settle(new AbortController().signal);
            if (settlement.kind === "recovery-required") failures.push(new Error("configuration recovery remains incomplete"));
            else delete entry.configurationRecovery;
          } catch (error) {
            failures.push(error);
          }
        }
        try { await entry.candidate.lease.release(); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, "trusted-install session cleanup failed");
      disposed = true;
      for (const entry of entries.values()) entry.state = "disposed";
      entries.clear();
    },
  });
}

export type TrustedInstallSessionRegistry = ReturnType<typeof createTrustedInstallSessionRegistry>;
