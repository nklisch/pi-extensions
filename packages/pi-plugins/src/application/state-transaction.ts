import type { ScopeContext } from "../domain/state/scope.js";
import type { GenerationSnapshot, StateCommitResult, StateLoadResult, VerifiedStateMutation } from "./state-contract.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";

/** The bounded number of authority snapshots a mutation may re-plan. */
export const SCOPED_MUTATION_MAX_ATTEMPTS = 4;

export type ScopedMutationCommitDecision<T> = Readonly<{
  kind: "commit";
  mutation: VerifiedStateMutation;
  value: T;
  /** Optional per-plan authority check; it still runs before store.commit. */
  recheckAuthority?: ScopedMutationRecheckAuthority;
}>;

export type ScopedMutationRejectDecision<T> = Readonly<{
  kind: "reject";
  value: T;
  code?: string;
}>;

export type ScopedMutationNoopDecision<T> = Readonly<{
  kind: "no-op";
  value: T;
}>;

/** A plan is deliberately synchronous: slow work belongs before this boundary. */
export type ScopedMutationDecision<T> =
  | ScopedMutationCommitDecision<T>
  | ScopedMutationRejectDecision<T>
  | ScopedMutationNoopDecision<T>;

export type ScopedMutationPlan<T> = (snapshot: GenerationSnapshot) => ScopedMutationDecision<T>;

export type ScopedMutationRetryableResult = Readonly<{
  kind: "retryable";
  code: "BUSY";
  attempts: number;
  reason: "another session is mid-write, retry";
}>;

export type ScopedMutationResult<T> =
  | Readonly<{ kind: "committed"; value: T; snapshot: GenerationSnapshot }>
  | ScopedMutationRejectDecision<T>
  | ScopedMutationNoopDecision<T>
  | Readonly<{ kind: "stale"; expected: number; actual?: number }>
  | ScopedMutationRetryableResult;

export type ScopedMutationRecheckAuthority = (snapshot: GenerationSnapshot) => void | Promise<void>;

function assertSignal(signal: AbortSignal): void {
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.throwIfAborted !== "function" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("scoped mutation requires an AbortSignal");
  }
}

function isBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly errcode?: unknown; readonly name?: unknown };
  return candidate.errcode === 5 || candidate.code === "SQLITE_BUSY" || candidate.code === "STATE_BUSY" || candidate.name === "LifecycleStateBusyError";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function retryableBusy(attempts: number): ScopedMutationRetryableResult {
  return Object.freeze({
    kind: "retryable" as const,
    code: "BUSY" as const,
    attempts,
    reason: "another session is mid-write, retry" as const,
  });
}

function validateLoadResult(result: StateLoadResult, scope: ScopeContext): GenerationSnapshot {
  if (!result || typeof result !== "object") throw new Error("state store returned an invalid read result");
  if (!result.ok) throw new Error("lifecycle state is corrupt");
  if (result.snapshot.scope.kind !== scope.kind ||
      (scope.kind === "project" && result.snapshot.scope.kind === "project" && result.snapshot.scope.projectKey !== scope.projectKey)) {
    throw new Error("state store returned a snapshot for the wrong scope");
  }
  return result.snapshot;
}

/**
 * Run one pure-plan/CAS mutation against a scope authority.
 *
 * The store owns the SQLite transaction. This helper never passes a callback
 * into it: `recheckAuthority` is awaited immediately before `commit`, and the
 * transaction window therefore contains no plan work, I/O, or user callback.
 */
export async function runScopedMutation<T>(
  store: LifecycleStateStore,
  scope: ScopeContext,
  plan: ScopedMutationPlan<T>,
  signal: AbortSignal,
  recheckAuthority?: ScopedMutationRecheckAuthority,
): Promise<ScopedMutationResult<T>> {
  if (store === null || typeof store !== "object" || typeof store.read !== "function" || typeof store.commit !== "function") {
    throw new TypeError("scoped mutation requires a lifecycle state store");
  }
  if (scope === null || typeof scope !== "object") throw new TypeError("scoped mutation requires a scope");
  if (typeof plan !== "function") throw new TypeError("scoped mutation requires a pure plan");
  assertSignal(signal);

  let lastStale: Readonly<{ expected: number; actual: number }> | undefined;
  for (let attempt = 0; attempt < SCOPED_MUTATION_MAX_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    let loaded: StateLoadResult;
    try {
      loaded = await store.read(scope, signal);
    } catch (error) {
      if (isBusy(error)) return retryableBusy(attempt + 1);
      throw error;
    }
    const snapshot = validateLoadResult(loaded, scope);
    const decision = plan(snapshot);
    if (isPromiseLike(decision)) throw new TypeError("scoped mutation plans must be synchronous");
    if (decision === null || typeof decision !== "object") throw new TypeError("scoped mutation plan returned an invalid decision");
    if (decision.kind === "reject" || decision.kind === "no-op") return decision;
    if (decision.kind !== "commit" || typeof decision.mutation !== "object" || decision.mutation === null) {
      throw new TypeError("scoped mutation plan returned an invalid decision");
    }

    // This callback is intentionally outside store.commit. In particular, it
    // cannot run after BEGIN IMMEDIATE has acquired the SQLite write lock.
    const authorityCheck = decision.recheckAuthority ?? recheckAuthority;
    if (authorityCheck !== undefined) await authorityCheck(snapshot);
    signal.throwIfAborted();

    let result: StateCommitResult;
    try {
      result = await store.commit(decision.mutation, signal);
    } catch (error) {
      if (isBusy(error)) return retryableBusy(attempt + 1);
      throw error;
    }
    if (result.kind === "committed") return { kind: "committed", value: decision.value, snapshot: result.snapshot };
    if (result.kind !== "stale-generation") throw new Error("state store returned an invalid commit result");
    lastStale = { expected: result.expected, actual: result.actual };
  }

  return {
    kind: "stale",
    expected: lastStale?.expected ?? 0,
    ...(lastStale === undefined ? {} : { actual: lastStale.actual }),
  };
}
