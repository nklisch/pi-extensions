import { compareUtf8 } from "../domain/canonical-json.js";
import { deriveMarketplaceRegistrationId } from "../domain/marketplace-registration.js";
import { HostConfigDocumentSchema } from "../domain/state/config-state.js";
import { ProjectLocalStateDocumentSchema } from "../domain/state/project-state.js";
import { ScopeContextSchema, toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import { UpdateSchedulerLeaseIdSchema, UpdateSchedulerLeaseSchema, type UpdateSchedulerLeaseId } from "../domain/update-policy.js";
import type { Sha256 } from "../domain/source.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import { marketplaceUpdateRecords } from "./marketplace-update-state.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { CurrentProjectRuntimeContext, ProjectTrustPort } from "./ports/project-trust.js";
import type { UpdateSchedulerLeasePort } from "./ports/update-scheduler-lease.js";
import { parseStateMutation, type GenerationSnapshot } from "./state-contract.js";
import { authorizeCurrentScope } from "./current-scope-authority.js";

export function createStateUpdateSchedulerLeasePort(dependencies: Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  mutations: GenerationMutationCoordinator;
  clock: LifecycleClock;
  sha256: Sha256;
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
  projectTrust?: ProjectTrustPort;
  revalidateCurrentProject?: (signal: AbortSignal) => Promise<CurrentProjectRuntimeContext>;
}>): UpdateSchedulerLeasePort {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("scheduler lease state dependencies are required");

  async function userCadence(signal: AbortSignal) {
    const loaded = await dependencies.state.read({ kind: "user" }, signal);
    return loaded.ok && "config" in loaded.snapshot ? loaded.snapshot.config.global.cadence : "paused" as const;
  }

  async function projectAuthorized(context: ScopeContext, signal: AbortSignal): Promise<boolean> {
    return (await authorizeCurrentScope(context, dependencies, signal)).kind === "trusted";
  }

  async function inventory(signal: AbortSignal) {
    const discovered = await dependencies.inventory.discover(signal);
    const cadence = await userCadence(signal);
    const plans = [];
    for (const contextInput of discovered.scopes) {
      const context = ScopeContextSchema.parse(contextInput);
      if (!await projectAuthorized(context, signal)) continue;
      const loaded = await dependencies.state.read(context, signal);
      if (!loaded.ok) continue;
      const scope = toScopeReference(context);
      const remote = marketplaceUpdateRecords(loaded.snapshot).filter((record) => record.source.kind !== "local-git");
      const registrationIds = remote.map((record) => deriveMarketplaceRegistrationId({ scope, source: record.source }, dependencies.sha256)).sort(compareUtf8);
      const schedules = remote.map((record) => record.refresh.schedule);
      const now = dependencies.clock.nowEpochMilliseconds();
      const regressed = schedules.some((schedule) => schedule !== undefined && now < schedule.anchorAt);
      const dueAt = schedules.length === 0 ? undefined : schedules.map((schedule) => schedule?.dueAt ?? 0).sort((a, b) => a - b)[0];
      plans.push({ context, scope, registrationIds, enabled: cadence !== "paused" && registrationIds.length > 0, ...(dueAt === undefined ? {} : { dueAt }), clock: regressed ? "regressed" as const : "current" as const });
    }
    return { plans: plans.sort((left, right) => compareUtf8(JSON.stringify(left.scope), JSON.stringify(right.scope))), complete: discovered.complete };
  }

  function lease(snapshot: GenerationSnapshot) {
    return "config" in snapshot ? snapshot.config.scope.schedulerLease : snapshot.project.scope.schedulerLease;
  }

  function mutation(snapshot: GenerationSnapshot, nextLease: ReturnType<typeof lease>) {
    if ("config" in snapshot) {
      const { schedulerLease: _previousLease, ...scope } = snapshot.config.scope;
      return parseStateMutation({
        scope: snapshot.scope,
        expectedGeneration: snapshot.generation,
        replace: { config: HostConfigDocumentSchema.parse({ ...snapshot.config, scope: { ...scope, ...(nextLease === undefined ? {} : { schedulerLease: nextLease }) } }) },
      }, dependencies.sha256);
    }
    const { schedulerLease: _previousLease, ...scope } = snapshot.project.scope;
    return parseStateMutation({
      scope: snapshot.scope,
      expectedGeneration: snapshot.generation,
      replace: { project: ProjectLocalStateDocumentSchema.parse({ ...snapshot.project, scope: { ...scope, ...(nextLease === undefined ? {} : { schedulerLease: nextLease }) } }) },
    }, dependencies.sha256);
  }

  function active(value: ReturnType<typeof lease>, now: number): boolean {
    return value !== undefined && value.startedAt <= now && value.renewedAt <= now && value.expiresAt > now;
  }

  async function replace(
    scope: ScopeContext,
    ownerInput: UpdateSchedulerLeaseId,
    now: number,
    leaseMs: number,
    mode: "acquire" | "renew" | "release",
    signal: AbortSignal,
  ): Promise<"self" | "other" | "unavailable"> {
    const owner = UpdateSchedulerLeaseIdSchema.parse(ownerInput);
    if (!await projectAuthorized(scope, signal)) return "unavailable";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const loaded = await dependencies.state.read(scope, signal);
      if (!loaded.ok) return "unavailable";
      const current = lease(loaded.snapshot);
      if (mode === "acquire" && active(current, now) && current?.id !== owner) return "other";
      if (mode !== "acquire" && current?.id !== owner) return "other";
      const nextLease = mode === "release" ? undefined : UpdateSchedulerLeaseSchema.parse({
        id: owner,
        startedAt: mode === "renew" && current?.id === owner ? current.startedAt : now,
        renewedAt: now,
        expiresAt: now + leaseMs,
      });
      const result = await dependencies.mutations.runPreparedMutation(
        { scope, plugins: [], expectedGeneration: loaded.snapshot.generation },
        async ({ snapshot }) => {
          const authority = lease(snapshot);
          if (mode === "acquire" && active(authority, now) && authority?.id !== owner) throw new Error("LEASE_OWNED");
          if (mode !== "acquire" && authority?.id !== owner) throw new Error("LEASE_LOST");
          return {
            mutation: mutation(snapshot, nextLease),
            value: undefined,
            beforeCommit: async () => {
              if (!await projectAuthorized(scope, signal)) throw new Error("PROJECT_UNTRUSTED");
            },
          };
        },
        signal,
      ).catch((error) => {
        if (signal.aborted) throw signal.reason ?? error;
        return undefined;
      });
      if (result?.kind === "committed") return "self";
    }
    return "unavailable";
  }

  const port: UpdateSchedulerLeasePort = {
    inventory,
    acquire(scope, owner, now, leaseMs, signal) { return replace(scope, owner, now, leaseMs, "acquire", signal); },
    async renew(scope, owner, now, leaseMs, signal) { return await replace(scope, owner, now, leaseMs, "renew", signal) === "self"; },
    async release(scope, owner, signal) { await replace(scope, owner, dependencies.clock.nowEpochMilliseconds(), 1, "release", signal); },
    async validate(scope, ownerInput, now, signal) {
      const owner = UpdateSchedulerLeaseIdSchema.parse(ownerInput);
      if (!await projectAuthorized(scope, signal)) return false;
      const loaded = await dependencies.state.read(scope, signal);
      return loaded.ok && lease(loaded.snapshot)?.id === owner && active(lease(loaded.snapshot), now);
    },
  };
  return Object.freeze(port);
}
