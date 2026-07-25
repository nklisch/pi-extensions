import type { MarketplaceRegistrationId } from "../../domain/marketplace-registration.js";
import type { ScopeContext, ScopeReference } from "../../domain/state/scope.js";
import type { UpdateSchedulerLeaseId } from "../../domain/update-policy.js";

export type UpdateSchedulerScopePlan = Readonly<{
  context: ScopeContext;
  scope: ScopeReference;
  registrationIds: readonly MarketplaceRegistrationId[];
  enabled: boolean;
  dueAt?: number;
  clock: "current" | "regressed";
}>;

export interface UpdateSchedulerLeasePort {
  inventory(signal: AbortSignal): Promise<Readonly<{ plans: readonly UpdateSchedulerScopePlan[]; complete: boolean }>>;
  acquire(scope: ScopeContext, owner: UpdateSchedulerLeaseId, now: number, leaseMs: number, signal: AbortSignal): Promise<"self" | "other" | "unavailable">;
  renew(scope: ScopeContext, owner: UpdateSchedulerLeaseId, now: number, leaseMs: number, signal: AbortSignal): Promise<boolean>;
  release(scope: ScopeContext, owner: UpdateSchedulerLeaseId, signal: AbortSignal): Promise<void>;
  validate(scope: ScopeContext, owner: UpdateSchedulerLeaseId, now: number, signal: AbortSignal): Promise<boolean>;
}
