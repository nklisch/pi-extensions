import type { ScopeReference } from "../../domain/state/scope.js";

/**
 * The capability held while a scope mutation is in its short authoritative
 * window. Implementations must not make ownership expire while the process is
 * merely paused; process death is the safe abandonment boundary.
 */
export interface ScopeLockLease {
  readonly scope: ScopeReference;
  assertOwned(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
}

/** Cross-process coordination for one complete user or project scope. */
export interface ScopeLockManager {
  acquire(scope: ScopeReference, signal: AbortSignal): Promise<ScopeLockLease>;
}
