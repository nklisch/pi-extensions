import type { ScopeReference } from "../domain/state/scope.js";

export type UpdateSchedulerStatus = Readonly<{
  state: "disabled" | "standby" | "running" | "clock-regressed" | "degraded" | "stopped";
  scopes: readonly Readonly<{ scope: ScopeReference; ownership: "self" | "other" | "none"; nextAt?: number }>[];
}>;

export interface UpdateSchedulerStatusProjection {
  snapshot(): UpdateSchedulerStatus;
  status(signal: AbortSignal): Promise<UpdateSchedulerStatus>;
}

export interface MutableUpdateSchedulerStatusProjection extends UpdateSchedulerStatusProjection {
  publish(status: UpdateSchedulerStatus): void;
  degrade(): void;
}

function freeze(status: UpdateSchedulerStatus): UpdateSchedulerStatus {
  return Object.freeze({
    state: status.state,
    scopes: Object.freeze(status.scopes.map((entry) => Object.freeze({
      scope: entry.scope,
      ownership: entry.ownership,
      ...(entry.nextAt === undefined ? {} : { nextAt: entry.nextAt }),
    }))),
  });
}

/** One path-free scheduler projection shared by every public observer. */
export function createUpdateSchedulerStatusProjection(
  initial: UpdateSchedulerStatus = { state: "standby", scopes: [] },
): MutableUpdateSchedulerStatusProjection {
  let current = freeze(initial);
  return Object.freeze({
    snapshot: () => current,
    async status(signal: AbortSignal) {
      signal.throwIfAborted();
      return current;
    },
    publish(status: UpdateSchedulerStatus) {
      current = freeze(status);
    },
    degrade() {
      current = freeze({ state: "degraded", scopes: current.scopes });
    },
  });
}
