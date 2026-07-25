import { hashContent, type ContentDigest } from "../domain/content-manifest.js";
import { RuntimeCapabilitySnapshotSchema, type RuntimeCapabilitySnapshot } from "../domain/compatibility-policy.js";
import { compareUtf8 } from "../domain/canonical-json.js";
import { deriveMarketplaceRegistrationId, deriveMarketplaceSnapshotToken } from "../domain/marketplace-registration.js";
import { toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import { LifecycleRecoveryResultSchema, type LifecycleRecoveryResult } from "../application/recovery-contract.js";
import { createInactiveProjectionExpectation, type ProjectionExpectation } from "../application/ports/runtime-projection.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { LifecycleClock } from "../application/ports/lifecycle-clock.js";
import type { MarketplaceCatalogService } from "../application/marketplace-catalog-service.js";
import type { CurrentProjectRuntimeContext } from "../application/ports/project-trust.js";
import type { SkillHookContributionObservationResult } from "../runtime/skills/resource-discovery.js";
import type { McpLifecycleParticipant, McpLifecycleStatusResult } from "../runtime/mcp/lifecycle-participant.js";
import type { Sha256 } from "../domain/source.js";
import { marketplaceSnapshots, marketplaceUpdateRecords } from "../application/marketplace-update-state.js";
import type { StateLoadResult } from "../application/state-contract.js";
import type { RuntimeDesiredState } from "./runtime-desired-state.js";
import type { RuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import type { HostStartupResult } from "../application/host-observation-contract.js";
import type { HostStatusService } from "./host-status-service.js";
import type {
  InspectionEvidenceSnapshot,
  InspectionMcpExpectation,
  InspectionSnapshotBinding,
  InstalledRuntimeEvidence,
  NativeInspectionEvidencePort,
} from "../application/ports/native-inspection-evidence.js";

const encoder = new TextEncoder();

function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("inspection evidence is not serializable");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(tag: string, value: unknown, sha256: Sha256): ContentDigest {
  return hashContent(encoder.encode(`${tag}\0${stable(value)}`), sha256);
}

function sameAuthority(left: InspectionSnapshotBinding, right: InspectionSnapshotBinding): boolean {
  const { capturedAt: _leftAt, ...leftAuthority } = left;
  const { capturedAt: _rightAt, ...rightAuthority } = right;
  return stable(leftAuthority) === stable(rightAuthority);
}

function installAuthority(binding: InspectionSnapshotBinding): unknown {
  const { capturedAt: _capturedAt, updateDigest: _updateDigest, scopes, ...authority } = binding;
  return {
    ...authority,
    // Exact trust/configuration writes advance the containing scope generation.
    // Preserve health/corruption authority while excluding only that expected
    // workflow-owned counter.
    scopes: scopes.map(({ generation: _generation, ...scope }) => scope),
  };
}

function sameInstallAuthority(left: InspectionSnapshotBinding, right: InspectionSnapshotBinding): boolean {
  return stable(installAuthority(left)) === stable(installAuthority(right));
}

function scopeOrder(left: ScopeContext, right: ScopeContext): number {
  if (left.kind !== right.kind) return left.kind === "user" ? -1 : 1;
  return left.kind === "project" && right.kind === "project" ? compareUtf8(left.projectKey, right.projectKey) : 0;
}

function records(result: StateLoadResult) {
  if (!result.ok) return [];
  const values = "installed" in result.snapshot ? result.snapshot.installed.plugins : result.snapshot.project.plugins;
  return values.map((record) => ({ scope: result.snapshot.scope, record }));
}

function ownerMatches(scope: ReturnType<typeof toScopeReference>, plugin: string, expectation: ProjectionExpectation): boolean {
  const owner = expectation.kind === "active"
    ? { scope: expectation.projection.scope, plugin: expectation.projection.plugin }
    : { scope: expectation.scope, plugin: expectation.plugin };
  return stable(owner.scope) === stable(scope) && owner.plugin === plugin;
}

function mcpExpectation(desired: RuntimeDesiredState | undefined, scope: ReturnType<typeof toScopeReference>, plugin: string): InspectionMcpExpectation {
  const transition = desired?.mcp.find((entry) => ownerMatches(scope, plugin, entry.to.expectation));
  if (transition?.to.kind === "source") {
    const registration = transition.to.projection.registration;
    return Object.freeze({
      kind: "source" as const,
      registrationDigest: registration.digest,
      servers: Object.entries(registration.source.servers).map(([serverKey, server]) => Object.freeze({
        componentId: server.componentId,
        serverKey: serverKey as never,
        transport: server.transport,
      })).sort((left, right) => compareUtf8(left.serverKey, right.serverKey)),
    });
  }
  return Object.freeze({ kind: transition?.to.kind === "none" ? "none" as const : "inactive" as const, servers: Object.freeze([]) });
}

function safeMcpStatus(result: McpLifecycleStatusResult): InstalledRuntimeEvidence["mcp"]["status"] {
  if (result.kind === "ready") return Object.freeze({ kind: "ready" as const, status: result.status });
  if (result.kind === "ambiguous") return Object.freeze({ kind: "mismatched" as const });
  return Object.freeze({ kind: "unavailable" as const, code: result.kind === "unavailable" ? "RUNTIME_UNAVAILABLE" : result.kind === "cancelled" ? "CANCELLED" : result.code });
}

function safeSkillObservation(result: SkillHookContributionObservationResult): InstalledRuntimeEvidence["skillsHooks"] {
  if (result.kind === "ready") return Object.freeze({ kind: "ready" as const, observation: result.observation });
  if (result.kind === "failed" && result.code === "OBSERVATION_MISMATCH") return Object.freeze({ kind: "mismatched" as const });
  return Object.freeze({ kind: "unavailable" as const, code: result.kind === "cancelled" ? "CANCELLED" : result.code });
}

type AuthorityCapture = Readonly<{
  states: readonly StateLoadResult[];
  currentProject: CurrentProjectRuntimeContext;
  runtime: readonly InstalledRuntimeEvidence[];
  binding: InspectionSnapshotBinding;
}>;

/**
 * Compose existing state, catalog, capability, recovery, and local runtime
 * evidence. The adapter never reconciles, reloads, refreshes, launches, or
 * probes; all runtime calls below are observation-only against already
 * composed local participants.
 */
export function createNativeInspectionEvidence(input: Readonly<{
  state: LifecycleStateStore;
  catalog: Pick<MarketplaceCatalogService, "search">;
  scopes: readonly ScopeContext[];
  revalidateProject(signal: AbortSignal): Promise<CurrentProjectRuntimeContext>;
  selections: RuntimeSelectionCatalog;
  desired(): RuntimeDesiredState | undefined;
  skillHook: Readonly<{ observe(expectation: ProjectionExpectation, signal: AbortSignal): Promise<SkillHookContributionObservationResult> }>;
  mcp: Pick<McpLifecycleParticipant, "status">;
  capabilities?: RuntimeCapabilitySnapshot;
  recovery: LifecycleRecoveryResult;
  startup: HostStartupResult;
  status?: HostStatusService;
  clock: LifecycleClock;
  sha256: Sha256;
}>): NativeInspectionEvidencePort {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("native inspection evidence dependencies are required");
  }
  const scopes = [...input.scopes].sort(scopeOrder);
  const capabilities = input.capabilities === undefined ? undefined : RuntimeCapabilitySnapshotSchema.parse(input.capabilities);
  const recovery = LifecycleRecoveryResultSchema.parse(input.recovery);
  const capabilityDigest = capabilities === undefined ? undefined : digest("inspection-capability-v1", capabilities, input.sha256);

  async function captureAuthority(signal: AbortSignal): Promise<AuthorityCapture> {
    signal.throwIfAborted();
    const currentProject = await input.revalidateProject(signal);
    const states: StateLoadResult[] = [];
    const scopeBindings: InspectionSnapshotBinding["scopes"][number][] = [];
    for (const scope of scopes) {
      try {
        const result = await input.state.read(scope, signal);
        states.push(result);
        const corruptions = result.ok ? result.snapshot.corruptions : result.corruptions;
        const corruptionCodes = corruptions.map((item) => item.code).sort(compareUtf8);
        scopeBindings.push({
          scope: toScopeReference(scope),
          ...(result.ok ? { generation: result.snapshot.generation } : {}),
          status: result.ok && corruptions.length === 0 ? "ready" : "corrupt",
          corruptionCodes,
          ...(corruptions.length === 0 ? {} : { corruptionDigest: digest("inspection-state-corruption-v1", corruptions, input.sha256) }),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        scopeBindings.push({ scope: toScopeReference(scope), status: "unavailable", corruptionCodes: [] });
      }
    }

    let catalogs: InspectionSnapshotBinding["catalogs"][number][] = [];
    const globalRegistry = states.find((result) => result.ok && result.snapshot.scope.kind === "user");
    if (globalRegistry?.ok) {
      const registryReference = toScopeReference(globalRegistry.snapshot.scope);
      const snapshots = marketplaceSnapshots(globalRegistry.snapshot);
      for (const target of states) {
        if (!target.ok) continue;
        const targetReference = toScopeReference(target.snapshot.scope);
        for (const record of marketplaceUpdateRecords(globalRegistry.snapshot)) {
          const registrationId = deriveMarketplaceRegistrationId({ scope: registryReference, source: record.source }, input.sha256);
          const selected = snapshots.find((snapshot) => snapshot.marketplace === record.marketplace);
          catalogs.push({
            scope: targetReference,
            registrationId,
            ...(selected === undefined ? {} : { snapshot: deriveMarketplaceSnapshotToken({ scope: targetReference, registrationId, snapshot: selected }, input.sha256) }),
            // Replaced below by the catalog service's publication-verified
            // observation. A missing observation is unavailable, never guessed.
            cache: { kind: "unavailable" },
          });
        }
      }
    }
    // Validate the one global catalog projection for every readable plugin
    // target. Native adapter errors never enter bindings or public observations.
    for (const result of states) {
      if (!result.ok) continue;
      const scope = toScopeReference(result.snapshot.scope);
      if (!catalogs.some((catalog) => stable(catalog.scope) === stable(scope))) continue;
      try {
        const page = await input.catalog.search({ scope: scope.kind, query: "", limit: 1 }, signal);
        const observations = new Map(page.observations.map((observation) => [observation.registrationId, observation.cache]));
        catalogs = catalogs.map((catalog) => stable(catalog.scope) !== stable(scope)
          ? catalog
          : { ...catalog, cache: observations.get(catalog.registrationId) ?? { kind: "unavailable" } });
      } catch (error) {
        if (signal.aborted) throw error;
        catalogs = catalogs.map((catalog) => stable(catalog.scope) !== stable(scope)
          ? catalog
          : { ...catalog, cache: { kind: "unavailable" } });
      }
    }
    catalogs.sort((left, right) => {
      const scopeCompare = left.scope.kind !== right.scope.kind ? (left.scope.kind === "user" ? -1 : 1)
        : left.scope.kind === "project" && right.scope.kind === "project" ? compareUtf8(left.scope.projectKey, right.scope.projectKey)
        : 0;
      return scopeCompare || compareUtf8(left.registrationId, right.registrationId);
    });

    const desired = input.desired();
    const selectionSnapshot = input.selections.snapshot();
    const runtime: InstalledRuntimeEvidence[] = [];
    for (const { scope, record } of states.flatMap(records).sort((left, right) => {
      const scopeCompare = scopeOrder(left.scope, right.scope);
      return scopeCompare || compareUtf8(left.record.plugin, right.record.plugin);
    })) {
      signal.throwIfAborted();
      const reference = toScopeReference(scope);
      const selection = selectionSnapshot.selections.find((candidate) => stable(candidate.scope) === stable(reference) && candidate.plugin === record.plugin && candidate.revision.revision === record.selectedRevision);
      const expectation = selection?.skillHook.prepared.expectation ?? createInactiveProjectionExpectation({ scope: reference, plugin: record.plugin, sha256: input.sha256 });
      let skillsHooks: InstalledRuntimeEvidence["skillsHooks"];
      try {
        skillsHooks = safeSkillObservation(await input.skillHook.observe(expectation, signal));
      } catch (error) {
        if (signal.aborted) throw error;
        skillsHooks = Object.freeze({ kind: "unavailable", code: "ADAPTER_FAILED" });
      }
      let status: InstalledRuntimeEvidence["mcp"]["status"];
      try {
        status = safeMcpStatus(await input.mcp.status({ scope: reference, plugin: record.plugin }, signal));
      } catch (error) {
        if (signal.aborted) throw error;
        status = Object.freeze({ kind: "unavailable", code: "ADAPTER_FAILED" });
      }
      runtime.push(Object.freeze({
        scope: reference,
        plugin: record.plugin,
        selectedRevision: record.selectedRevision,
        ...(selection === undefined ? {} : { projectionDigest: selection.skillHook.prepared.expectation.projection.digest }),
        skillsHooks,
        mcp: Object.freeze({ expected: mcpExpectation(desired, reference, record.plugin), status }),
      }));
    }

    const runtimeEpoch = digest("inspection-runtime-epoch-v1", {
      selectionEpoch: selectionSnapshot.epoch,
      currentProject: { projectKey: currentProject.projectKey, trust: currentProject.trust },
      runtime,
    }, input.sha256);
    const recoveryDigest = digest("inspection-recovery-v1", recovery, input.sha256);
    const hostStatus = input.status?.snapshot();
    const updateDigest = digest("inspection-update-v1", {
      scopes: states.filter((result) => result.ok).map((result) => ({
        scope: toScopeReference(result.snapshot.scope),
        generation: result.snapshot.generation,
        records: marketplaceUpdateRecords(result.snapshot),
      })),
      ...(hostStatus === undefined ? {} : { hostStatus }),
    }, input.sha256);
    const projectEpoch = digest("inspection-project-trust-v1", { projectKey: currentProject.projectKey, trust: currentProject.trust }, input.sha256);
    const binding: InspectionSnapshotBinding = Object.freeze({
      capturedAt: input.clock.nowEpochMilliseconds(),
      scopes: Object.freeze(scopeBindings),
      currentProject: Object.freeze({ projectKey: currentProject.projectKey, trust: currentProject.trust, epoch: projectEpoch }),
      catalogs: Object.freeze(catalogs),
      capability: Object.freeze(capabilities === undefined
        ? { status: "unavailable" as const }
        : { status: "ready" as const, digest: capabilityDigest!, capturedBy: capabilities.capturedBy }),
      runtimeEpoch,
      recoveryDigest,
      updateDigest,
    });
    return Object.freeze({ states: Object.freeze(states), currentProject, runtime: Object.freeze(runtime), binding });
  }

  const port: NativeInspectionEvidencePort = {
    async capture(signal): Promise<InspectionEvidenceSnapshot> {
      const captured = await captureAuthority(signal);
      return Object.freeze({
        ...captured,
        ...(capabilities === undefined ? {} : { capabilities }),
        recovery,
        startup: input.startup,
        ...(input.status === undefined ? {} : { hostStatus: input.status.snapshot() }),
      });
    },
    async validate(binding, signal) {
      const current = await captureAuthority(signal);
      return sameAuthority(binding, current.binding) ? "current" : "stale";
    },
    async validateForInstall(binding, signal) {
      const current = await captureAuthority(signal);
      return sameInstallAuthority(binding, current.binding) ? "current" : "stale";
    },
  };
  return Object.freeze(port);
}
