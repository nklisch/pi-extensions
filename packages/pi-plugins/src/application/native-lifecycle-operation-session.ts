import type { ContentDigest } from "../domain/content-manifest.js";
import type { Sha256 } from "../domain/source.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleOperationIdPort } from "./ports/lifecycle-operation-id.js";
import {
  NativeLifecycleOperationSessionPolicy,
  type NativeLifecycleOperationPreview,
  type NativeLifecycleOperationResult,
  type NativeLifecycleOperationSessionState,
  type NativeLifecycleOperationToken,
  type NativeLifecycleProgressEvent,
} from "./native-lifecycle-operation-contract.js";
import { createNativeLifecycleOperationToken, verifyNativeLifecycleOperationToken } from "./native-lifecycle-operation-identifiers.js";
import type { VerifiedNativeLifecycleOperationContext } from "./native-lifecycle-operation.js";
import type { VerifiedProjectSyncExecutionContext } from "./project-sync-service.js";

export type NativeLifecycleOperationSessionExecution =
  | Readonly<{ kind: "lifecycle"; context: VerifiedNativeLifecycleOperationContext }>
  | Readonly<{ kind: "project-sync"; context: VerifiedProjectSyncExecutionContext }>;

export type NativeLifecycleOperationSessionEntry = {
  readonly token: NativeLifecycleOperationToken;
  readonly preview: NativeLifecycleOperationPreview;
  readonly execution: NativeLifecycleOperationSessionExecution;
  readonly createdMonotonic: number;
  readonly createdEpoch: number;
  lastAccessMonotonic: number;
  version: number;
  state: NativeLifecycleOperationSessionState;
  readonly controller: AbortController;
  progress: readonly NativeLifecycleProgressEvent[];
  result?: NativeLifecycleOperationResult;
  terminalMonotonic?: number;
  completion?: Promise<void>;
  released: boolean;
};

export type NativeLifecycleOperationSessionLookup =
  | Readonly<{ kind: "found"; entry: NativeLifecycleOperationSessionEntry }>
  | Readonly<{ kind: "missing" | "expired" | "disposed" }>;

const terminalStates = new Set<NativeLifecycleOperationSessionState>(["succeeded", "current-state", "needs-action", "cancelled", "stale", "conflict", "rejected", "rolled-back", "recovery-required", "failed", "expired", "disposed"]);

export function createNativeLifecycleOperationSessionRegistry(input: Readonly<{
  clock: LifecycleClock;
  sessionIds: LifecycleOperationIdPort;
  hostEpoch: ContentDigest;
  sha256: Sha256;
}>) {
  const entries = new Map<NativeLifecycleOperationToken, NativeLifecycleOperationSessionEntry>();
  let accepting = true;
  let disposed = false;
  let closePromise: Promise<void> | undefined;
  const now = () => input.clock.monotonicMilliseconds();

  async function release(entry: NativeLifecycleOperationSessionEntry): Promise<void> {
    if (entry.released) return;
    if (entry.execution.kind === "lifecycle" && entry.execution.context.update !== undefined) await entry.execution.context.update.candidate.lease.release();
    entry.released = true;
  }
  function expired(entry: NativeLifecycleOperationSessionEntry, at: number): boolean {
    return at - entry.lastAccessMonotonic >= NativeLifecycleOperationSessionPolicy.idleTtlMs || at - entry.createdMonotonic >= NativeLifecycleOperationSessionPolicy.absoluteTtlMs;
  }
  async function reap(): Promise<void> {
    const at = now();
    for (const [token, entry] of entries) {
      if (!terminalStates.has(entry.state) && entry.state !== "applying" && expired(entry, at)) {
        entry.state = "expired";
        entry.terminalMonotonic = at;
        entry.controller.abort(new DOMException("native operation session expired", "AbortError"));
        await release(entry);
      }
      if (entry.terminalMonotonic !== undefined && at - entry.terminalMonotonic >= NativeLifecycleOperationSessionPolicy.terminalRetentionMs) entries.delete(token);
    }
  }

  return Object.freeze({
    async create(preview: NativeLifecycleOperationPreview, execution: NativeLifecycleOperationSessionExecution, signal: AbortSignal) {
      if (!accepting || disposed) throw new Error("native operation session registry is closed");
      await reap();
      const token = createNativeLifecycleOperationToken(await input.sessionIds.create(signal), input.hostEpoch, input.sha256);
      const created = now();
      const entry: NativeLifecycleOperationSessionEntry = { token, preview, execution, createdMonotonic: created, createdEpoch: input.clock.nowEpochMilliseconds(), lastAccessMonotonic: created, version: 0, state: "previewed", controller: new AbortController(), progress: [], released: false };
      entries.set(token, entry);
      return entry;
    },
    async lookup(token: NativeLifecycleOperationToken, touch = true): Promise<NativeLifecycleOperationSessionLookup> {
      if (disposed) return { kind: "disposed" };
      await reap();
      if (verifyNativeLifecycleOperationToken(token, input.hostEpoch, input.sha256) === undefined) return { kind: "missing" };
      const entry = entries.get(token);
      if (entry === undefined) return { kind: "missing" };
      if (entry.state === "expired") return { kind: "expired" };
      if (entry.state === "disposed") return { kind: "disposed" };
      if (touch && !terminalStates.has(entry.state)) entry.lastAccessMonotonic = now();
      return { kind: "found", entry };
    },
    expiresAt(entry: NativeLifecycleOperationSessionEntry): number {
      // performance.now() is fractional; public epoch contracts are integer
      // milliseconds. Flooring avoids extending either idle or absolute TTL.
      return Math.floor(entry.createdEpoch + Math.min(entry.lastAccessMonotonic - entry.createdMonotonic + NativeLifecycleOperationSessionPolicy.idleTtlMs, NativeLifecycleOperationSessionPolicy.absoluteTtlMs));
    },
    finish(entry: NativeLifecycleOperationSessionEntry, result: NativeLifecycleOperationResult): void {
      entry.state = result.kind;
      entry.result = result;
      entry.progress = "progress" in result ? result.progress : [];
      entry.terminalMonotonic = now();
    },
    release,
    quiesce() { accepting = false; },
    isAccepting: () => accepting && !disposed,
    reap,
    close(): Promise<void> {
      closePromise ??= (async () => {
        accepting = false;
        await Promise.allSettled([...entries.values()].map((entry) => entry.completion));
        disposed = true;
        const failures: unknown[] = [];
        for (const entry of entries.values()) {
          entry.state = "disposed";
          if (entry.result === undefined) entry.controller.abort(new DOMException("native operation session disposed", "AbortError"));
          try { await release(entry); } catch (error) { failures.push(error); }
        }
        entries.clear();
        if (failures.length > 0) throw new AggregateError(failures, "native operation session cleanup failed");
      })();
      return closePromise;
    },
  });
}

export type NativeLifecycleOperationSessionRegistry = ReturnType<typeof createNativeLifecycleOperationSessionRegistry>;
