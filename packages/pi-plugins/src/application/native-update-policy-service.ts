import { canonicalJson, compareUtf8 } from "../domain/canonical-json.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { deriveMarketplaceRegistrationId, MarketplaceRegistrationIdSchema } from "../domain/marketplace-registration.js";
import { HostConfigDocumentSchema } from "../domain/state/config-state.js";
import { ProjectLocalStateDocumentSchema } from "../domain/state/project-state.js";
import { ScopeContextSchema, toScopeReference, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import {
  MarketplaceRegistrationRecordSchema,
  StableSourceIdentitySchema,
  UpdateApplicationModeSchema,
  UpdatePolicyChangeSchema,
  deriveMarketplaceSourceIdentity,
  type MarketplaceRegistrationRecord,
  type StableSourceIdentity,
  type UpdateApplicationMode,
  type UpdatePolicyChange,
} from "../domain/update-policy.js";
import type { Sha256 } from "../domain/source.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import { marketplaceUpdateRecords } from "./marketplace-update-state.js";
import {
  NativeUpdatePolicyApplyRequestSchema,
  NativeUpdatePolicyApplyResultSchema,
  NativeUpdatePolicyPreviewResultSchema,
  NativeUpdatePolicyPreviewSchema,
  NativeUpdatePolicyStatusSchema,
  NativeUpdateStatusRequestSchema,
  type NativeUpdatePolicyApplyRequest,
  type NativeUpdatePolicyApplyResult,
  type NativeUpdatePolicyPreviewResult,
  type NativeUpdatePolicyStatus,
  type NativeUpdateStatusRequest,
} from "./native-update-contract.js";
import { deriveUpdatePolicyConsentId, deriveUpdatePolicyPreviewId } from "./native-update-identifiers.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { CurrentProjectRuntimeContext, ProjectTrustPort } from "./ports/project-trust.js";
import type { UpdatePolicyAuthorityPort } from "./ports/update-policy-authority.js";
import { resolveEffectiveUpdatePolicy } from "./update-policy-resolution.js";
import { parseStateMutation, type GenerationSnapshot } from "./state-contract.js";
import { authorizeCurrentScope, sameProjectAuthority } from "./current-scope-authority.js";
import type { UpdateSchedulerStatusProjection } from "./update-scheduler-status.js";

export interface NativeUpdatePolicyService {
  preview(request: UpdatePolicyChange, signal: AbortSignal): Promise<NativeUpdatePolicyPreviewResult>;
  apply(request: NativeUpdatePolicyApplyRequest, signal: AbortSignal): Promise<NativeUpdatePolicyApplyResult>;
  status(request: NativeUpdateStatusRequest, signal: AbortSignal): Promise<NativeUpdatePolicyStatus>;
  readonly authority: UpdatePolicyAuthorityPort;
}

export type NativeUpdatePolicyServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  mutations: GenerationMutationCoordinator;
  sha256: Sha256;
  clock: LifecycleClock;
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
  projectTrust?: ProjectTrustPort;
  revalidateCurrentProject?: (signal: AbortSignal) => Promise<CurrentProjectRuntimeContext>;
  schedulerStatus?: UpdateSchedulerStatusProjection;
}>;

type LoadedAuthority = Readonly<{
  user: Extract<GenerationSnapshot, { scope: { kind: "user" } }>;
  scopes: readonly GenerationSnapshot[];
  complete: boolean;
  projectAuthority?: CurrentProjectRuntimeContext;
}>;

type PolicyRow = Readonly<{
  scope: ScopeReference;
  plugin: PluginKey;
  record: MarketplaceRegistrationRecord;
  marketplaceIdentity: StableSourceIdentity;
  pluginIdentity: StableSourceIdentity;
}>;

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  return left.kind === right.kind && (left.kind === "user" || right.kind === "user" || left.projectKey === right.projectKey);
}

function scopeContext(reference: ScopeReference, currentProject: NativeUpdatePolicyServiceDependencies["currentProject"]): ScopeContext | undefined {
  if (reference.kind === "user") return { kind: "user" };
  return currentProject?.projectKey === reference.projectKey ? currentProject : undefined;
}

function projectPolicyEpoch(authority: CurrentProjectRuntimeContext, generation: number, sha256: Sha256): string {
  return deriveUpdatePolicyPreviewId({
    projectKey: authority.projectKey,
    identity: authority.identity,
    trust: authority.trust,
    generation,
  }, sha256);
}

function scopeOverride(snapshot: GenerationSnapshot): UpdateApplicationMode | undefined {
  return "config" in snapshot ? snapshot.config.scope.application : snapshot.project.scope.application;
}

function installedRows(snapshot: GenerationSnapshot, sha256: Sha256): readonly PolicyRow[] {
  const records = marketplaceUpdateRecords(snapshot);
  const installed = "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins;
  const scope = toScopeReference(snapshot.scope);
  const rows: PolicyRow[] = [];
  for (const plugin of installed) {
    const record = records.find((candidate) => plugin.plugin.endsWith(`@${candidate.marketplace}`));
    const revision = plugin.revisions.find((candidate) => candidate.revision === plugin.selectedRevision);
    if (record === undefined || revision === undefined) continue;
    rows.push({
      scope,
      plugin: plugin.plugin,
      record,
      marketplaceIdentity: revision.evidence.source.marketplaceSourceIdentity ?? "legacy-unavailable",
      pluginIdentity: revision.evidence.source.pluginSourceIdentity ?? "legacy-unavailable",
    });
  }
  return rows.sort((left, right) => compareUtf8(canonicalJson(left.scope), canonicalJson(right.scope)) || compareUtf8(left.plugin, right.plugin));
}

function targetMatches(change: UpdatePolicyChange, row: PolicyRow, sha256: Sha256): boolean {
  if (change.kind !== "application") return false;
  switch (change.target.kind) {
    case "global": return true;
    case "scope": return sameScope(change.target.scope, row.scope);
    case "marketplace": return sameScope(change.target.scope, row.scope) && deriveMarketplaceRegistrationId({ scope: row.scope, source: row.record.source }, sha256) === change.target.registrationId;
    case "plugin": return sameScope(change.target.scope, row.scope) && row.plugin === change.target.plugin;
  }
}

function simulatedRecord(row: PolicyRow, change: UpdatePolicyChange, sha256: Sha256): MarketplaceRegistrationRecord {
  if (change.kind !== "application" || !targetMatches(change, row, sha256)) return row.record;
  if (change.target.kind === "marketplace") {
    return MarketplaceRegistrationRecordSchema.parse({ ...row.record, ...(change.mode === "inherit" ? { applicationOverride: undefined } : { applicationOverride: change.mode }) });
  }
  if (change.target.kind === "plugin") {
    const rest = row.record.pluginOverrides.filter((override) => override.plugin !== row.plugin);
    const pluginOverrides = change.mode === "inherit" ? rest : [...rest, { plugin: row.plugin, sourceIdentity: row.pluginIdentity, mode: change.mode }];
    return MarketplaceRegistrationRecordSchema.parse({ ...row.record, pluginOverrides });
  }
  return row.record;
}

function simulatedScope(snapshot: GenerationSnapshot, change: UpdatePolicyChange): UpdateApplicationMode | undefined {
  if (change.kind !== "application" || change.target.kind !== "scope" || !sameScope(change.target.scope, toScopeReference(snapshot.scope))) return scopeOverride(snapshot);
  return change.mode === "inherit" ? undefined : UpdateApplicationModeSchema.parse(change.mode);
}

function effective(
  row: PolicyRow,
  global: UpdateApplicationMode,
  scope: UpdateApplicationMode | undefined,
  sha256: Sha256,
  record = row.record,
) {
  return resolveEffectiveUpdatePolicy({
    plugin: row.plugin,
    record,
    global,
    ...(scope === undefined ? {} : { scope }),
    marketplaceSourceIdentity: row.marketplaceIdentity,
    registeredMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity(record.source, sha256),
    pluginSourceIdentity: row.pluginIdentity,
  });
}

export function createNativeUpdatePolicyService(dependencies: NativeUpdatePolicyServiceDependencies): NativeUpdatePolicyService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("native update policy dependencies are required");

  async function load(signal: AbortSignal): Promise<LoadedAuthority | undefined> {
    const inventory = await dependencies.inventory.discover(signal);
    const contexts = [...inventory.scopes];
    if (!contexts.some((scope) => scope.kind === "user")) contexts.unshift({ kind: "user" });
    const snapshots: GenerationSnapshot[] = [];
    let projectAuthority: CurrentProjectRuntimeContext | undefined;
    for (const context of contexts) {
      if (context.kind === "project") {
        const authority = await authorizeCurrentScope(context, dependencies, signal);
        if (authority.kind !== "trusted" || authority.current === undefined) continue;
        projectAuthority = authority.current;
      }
      const result = await dependencies.state.read(context, signal);
      if (result.ok) snapshots.push(result.snapshot);
    }
    const user = snapshots.find((snapshot): snapshot is LoadedAuthority["user"] => snapshot.scope.kind === "user");
    return user === undefined ? undefined : {
      user,
      scopes: snapshots,
      complete: inventory.complete,
      ...(projectAuthority === undefined ? {} : { projectAuthority }),
    };
  }

  async function projectAuthority(reference: ScopeReference | undefined, signal: AbortSignal) {
    if (reference?.kind !== "project") return { kind: "trusted" as const };
    const context = dependencies.currentProject;
    if (context === undefined || context.projectKey !== reference.projectKey) return { kind: "project-stale" as const };
    return authorizeCurrentScope(context, dependencies, signal);
  }

  function targetScope(change: UpdatePolicyChange): ScopeReference | undefined {
    return change.kind === "application" && change.target.kind !== "global" ? change.target.scope : undefined;
  }

  async function preview(request: UpdatePolicyChange, signal: AbortSignal): Promise<NativeUpdatePolicyPreviewResult> {
    signal.throwIfAborted();
    const parsed = UpdatePolicyChangeSchema.safeParse(request);
    if (!parsed.success) return NativeUpdatePolicyPreviewResultSchema.parse({ kind: "rejected", code: "INVALID_CHANGE" });
    const change = parsed.data;
    const reference = targetScope(change);
    const targetAuthority = await projectAuthority(reference, signal);
    if (targetAuthority.kind !== "trusted") return NativeUpdatePolicyPreviewResultSchema.parse({ kind: "rejected", code: "PROJECT_UNTRUSTED" });
    const authority = await load(signal);
    if (authority === undefined) return NativeUpdatePolicyPreviewResultSchema.parse({ kind: "rejected", code: "STATE_UNAVAILABLE" });
    if (reference !== undefined && !authority.scopes.some((snapshot) => sameScope(toScopeReference(snapshot.scope), reference))) {
      return NativeUpdatePolicyPreviewResultSchema.parse({ kind: "rejected", code: "TARGET_MISSING" });
    }
    const rows = authority.scopes.flatMap((snapshot) => installedRows(snapshot, dependencies.sha256));
    if (change.kind === "application" && change.target.kind === "marketplace") {
      const target = change.target;
      const configured = authority.scopes.some((snapshot) => sameScope(toScopeReference(snapshot.scope), target.scope) &&
        marketplaceUpdateRecords(snapshot).some((record) => deriveMarketplaceRegistrationId({ scope: target.scope, source: record.source }, dependencies.sha256) === target.registrationId));
      if (!configured) return NativeUpdatePolicyPreviewResultSchema.parse({ kind: "rejected", code: "TARGET_MISSING" });
    }
    if (change.kind === "application" && change.target.kind === "plugin" && !rows.some((row) => targetMatches(change, row, dependencies.sha256))) {
      return NativeUpdatePolicyPreviewResultSchema.parse({ kind: "rejected", code: "TARGET_MISSING" });
    }
    const globalBefore = authority.user.config.global.application;
    const globalAfter = change.kind === "application" && change.target.kind === "global" ? UpdateApplicationModeSchema.parse(change.mode) : globalBefore;
    const before = rows.filter((row) => targetMatches(change, row, dependencies.sha256)).map((row) => {
      const snapshot = authority.scopes.find((candidate) => sameScope(toScopeReference(candidate.scope), row.scope))!;
      return { plugin: row.plugin, effective: effective(row, globalBefore, scopeOverride(snapshot), dependencies.sha256) };
    });
    const after = rows.filter((row) => targetMatches(change, row, dependencies.sha256)).map((row) => {
      const snapshot = authority.scopes.find((candidate) => sameScope(toScopeReference(candidate.scope), row.scope))!;
      return { plugin: row.plugin, effective: effective(row, globalAfter, simulatedScope(snapshot, change), dependencies.sha256, simulatedRecord(row, change, dependencies.sha256)) };
    });
    const automatic = change.kind === "application" && change.mode === "automatic";
    const evidence = {
      change,
      generations: authority.scopes.map((snapshot) => ({ scope: toScopeReference(snapshot.scope), generation: snapshot.generation })),
      before,
      after,
      complete: authority.complete,
    };
    const previewId = deriveUpdatePolicyPreviewId(evidence, dependencies.sha256);
    const consentId = automatic ? deriveUpdatePolicyConsentId({ previewId, change, breadth: change.target.kind }, dependencies.sha256) : undefined;
    return NativeUpdatePolicyPreviewResultSchema.parse({
      kind: "previewed",
      preview: NativeUpdatePolicyPreviewSchema.parse({
        previewId,
        change,
        before,
        after,
        affectedCount: after.filter((entry, index) => canonicalJson(entry.effective) !== canonicalJson(before[index]?.effective)).length,
        inventoryComplete: authority.complete,
        consent: {
          required: automatic,
          ...(consentId === undefined ? {} : {
            consentId,
            disclosure: change.target.kind === "global" ? "global-current-and-future" : change.target.kind === "scope" ? "scope-current-and-future" : "current-target",
          }),
        },
        authority: {
          userGeneration: authority.user.generation,
          ...(reference?.kind === "project" && authority.projectAuthority !== undefined ? {
            projectEpoch: projectPolicyEpoch(
              authority.projectAuthority,
              authority.scopes.find((snapshot) => snapshot.scope.kind === "project")!.generation,
              dependencies.sha256,
            ),
          } : {}),
        },
      }),
    });
  }

  function mutateSnapshot(snapshot: GenerationSnapshot, change: UpdatePolicyChange) {
    if ("config" in snapshot) {
      const global = change.kind === "cadence" ? { ...snapshot.config.global, cadence: change.cadence } :
        change.kind === "application" && change.target.kind === "global" ? { ...snapshot.config.global, application: change.mode } : snapshot.config.global;
      const scope = change.kind === "application" && change.target.kind === "scope"
        ? { ...snapshot.config.scope, application: change.mode === "inherit" ? undefined : change.mode }
        : snapshot.config.scope;
      let records = [...snapshot.config.records];
      if (change.kind === "application" && (change.target.kind === "marketplace" || change.target.kind === "plugin")) {
        const target = change.target;
        records = records.map((record) => {
          const id = deriveMarketplaceRegistrationId({ scope: { kind: "user" }, source: record.source }, dependencies.sha256);
          if (target.kind === "marketplace") return id === target.registrationId
            ? MarketplaceRegistrationRecordSchema.parse({ ...record, applicationOverride: change.mode === "inherit" ? undefined : change.mode }) : record;
          if (!target.plugin.endsWith(`@${record.marketplace}`)) return record;
          const installed = snapshot.installed.plugins.find((plugin) => plugin.plugin === target.plugin);
          const selected = installed?.revisions.find((revision) => revision.revision === installed.selectedRevision);
          if (selected?.evidence.source.pluginSourceIdentity === undefined) throw new Error("TARGET_STALE");
          const rest = record.pluginOverrides.filter((override) => override.plugin !== target.plugin);
          return MarketplaceRegistrationRecordSchema.parse({ ...record, pluginOverrides: change.mode === "inherit" ? rest : [...rest, { plugin: target.plugin, sourceIdentity: selected.evidence.source.pluginSourceIdentity, mode: change.mode }] });
        });
      }
      return parseStateMutation({
        scope: snapshot.scope,
        expectedGeneration: snapshot.generation,
        replace: { config: HostConfigDocumentSchema.parse({ ...snapshot.config, schemaVersion: 4, generation: snapshot.generation, global, scope, records }) },
      }, dependencies.sha256);
    }
    const scope = change.kind === "application" && change.target.kind === "scope"
      ? { ...snapshot.project.scope, application: change.mode === "inherit" ? undefined : change.mode }
      : snapshot.project.scope;
    let records = [...snapshot.project.marketplaceUpdates];
    if (change.kind === "application" && (change.target.kind === "marketplace" || change.target.kind === "plugin")) {
      const target = change.target;
      records = records.map((record) => {
        const reference = { kind: "project" as const, projectKey: snapshot.scope.projectKey };
        const id = deriveMarketplaceRegistrationId({ scope: reference, source: record.source }, dependencies.sha256);
        if (target.kind === "marketplace") return id === target.registrationId
          ? MarketplaceRegistrationRecordSchema.parse({ ...record, applicationOverride: change.mode === "inherit" ? undefined : change.mode }) : record;
        if (!target.plugin.endsWith(`@${record.marketplace}`)) return record;
        const installed = snapshot.project.plugins.find((plugin) => plugin.plugin === target.plugin);
        const selected = installed?.revisions.find((revision) => revision.revision === installed.selectedRevision);
        if (selected?.evidence.source.pluginSourceIdentity === undefined) throw new Error("TARGET_STALE");
        const rest = record.pluginOverrides.filter((override) => override.plugin !== target.plugin);
        return MarketplaceRegistrationRecordSchema.parse({ ...record, pluginOverrides: change.mode === "inherit" ? rest : [...rest, { plugin: target.plugin, sourceIdentity: selected.evidence.source.pluginSourceIdentity, mode: change.mode }] });
      });
    }
    return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { project: ProjectLocalStateDocumentSchema.parse({ ...snapshot.project, schemaVersion: 4, generation: snapshot.generation, scope, marketplaceUpdates: records }) } }, dependencies.sha256);
  }

  async function apply(request: NativeUpdatePolicyApplyRequest, signal: AbortSignal): Promise<NativeUpdatePolicyApplyResult> {
    const parsed = NativeUpdatePolicyApplyRequestSchema.parse(request);
    const checked = await preview(parsed.change, signal);
    if (checked.kind !== "previewed") return NativeUpdatePolicyApplyResultSchema.parse({ kind: "rejected", code: checked.code === "PROJECT_UNTRUSTED" ? "PROJECT_UNTRUSTED" : "STATE_UNAVAILABLE" });
    if (checked.preview.previewId !== parsed.expectedPreviewId) return NativeUpdatePolicyApplyResultSchema.parse({ kind: "stale", reason: "preview" });
    if (checked.preview.consent.required && parsed.consent?.consentId !== checked.preview.consent.consentId) {
      return NativeUpdatePolicyApplyResultSchema.parse({ kind: "rejected", code: parsed.consent === undefined ? "CONSENT_REQUIRED" : "CONSENT_INVALID" });
    }
    const reference = targetScope(parsed.change) ?? { kind: "user" as const };
    const context = parsed.change.kind === "cadence" || parsed.change.kind === "application" && parsed.change.target.kind === "global"
      ? { kind: "user" as const }
      : scopeContext(reference, dependencies.currentProject);
    if (context === undefined) return NativeUpdatePolicyApplyResultSchema.parse({ kind: "stale", reason: "project" });
    const projectBeforeRead = context.kind === "project" ? await authorizeCurrentScope(context, dependencies, signal) : undefined;
    if (projectBeforeRead?.kind === "project-stale") return NativeUpdatePolicyApplyResultSchema.parse({ kind: "stale", reason: "project" });
    if (projectBeforeRead?.kind === "project-untrusted") return NativeUpdatePolicyApplyResultSchema.parse({ kind: "stale", reason: "trust" });
    const loaded = await dependencies.state.read(context, signal);
    if (!loaded.ok) return NativeUpdatePolicyApplyResultSchema.parse({ kind: "rejected", code: "STATE_UNAVAILABLE" });
    const currentAuthority = context.kind === "user"
      ? loaded.snapshot.generation === checked.preview.authority.userGeneration
      : projectBeforeRead?.kind === "trusted" && projectBeforeRead.current !== undefined &&
        checked.preview.authority.projectEpoch === projectPolicyEpoch(projectBeforeRead.current, loaded.snapshot.generation, dependencies.sha256);
    if (!currentAuthority) return NativeUpdatePolicyApplyResultSchema.parse({ kind: "stale", reason: "generation" });
    const before = canonicalJson("config" in loaded.snapshot ? loaded.snapshot.config : loaded.snapshot.project);
    try {
      const result = await dependencies.mutations.runPreparedMutation(
        { scope: context, plugins: parsed.change.kind === "application" && parsed.change.target.kind === "plugin" ? [parsed.change.target.plugin] : [], expectedGeneration: loaded.snapshot.generation },
        async ({ snapshot }) => ({
          mutation: mutateSnapshot(snapshot, parsed.change),
          value: undefined,
          beforeCommit: async () => {
            if (context.kind === "user") return;
            const current = await authorizeCurrentScope(context, dependencies, signal);
            if (current.kind === "project-untrusted") throw new Error("PROJECT_TRUST_STALE");
            if (current.kind !== "trusted" || current.current === undefined || projectBeforeRead?.kind !== "trusted" || projectBeforeRead.current === undefined ||
                !sameProjectAuthority(current.current, projectBeforeRead.current)) {
              throw new Error("PROJECT_AUTHORITY_STALE");
            }
          },
        }),
        signal,
      );
      if (result.kind !== "committed") return NativeUpdatePolicyApplyResultSchema.parse({ kind: "stale", reason: "generation" });
      const after = canonicalJson("config" in result.snapshot ? result.snapshot.config : result.snapshot.project);
      return NativeUpdatePolicyApplyResultSchema.parse({ kind: before === after ? "unchanged" : "changed", previewId: checked.preview.previewId });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const reason = error instanceof Error && error.message === "TARGET_STALE" ? "source"
        : error instanceof Error && error.message === "PROJECT_TRUST_STALE" ? "trust"
        : error instanceof Error && error.message === "PROJECT_AUTHORITY_STALE" ? "project"
        : "generation";
      return NativeUpdatePolicyApplyResultSchema.parse({ kind: "stale", reason });
    }
  }

  const authorityPort: UpdatePolicyAuthorityPort = Object.freeze({
    async resolve(
      request: Parameters<UpdatePolicyAuthorityPort["resolve"]>[0],
      signal: AbortSignal,
    ) {
      const scope = ScopeContextSchema.parse(request.scope);
      const userLoad = await dependencies.state.read({ kind: "user" }, signal);
      if (scope.kind === "project" && (await authorizeCurrentScope(scope, dependencies, signal)).kind !== "trusted") {
        return resolveEffectiveUpdatePolicy({ plugin: request.plugin, record: createUnavailableRecord(request.plugin), global: "manual", marketplaceSourceIdentity: "legacy-unavailable", pluginSourceIdentity: "legacy-unavailable" });
      }
      const scopedLoad = scope.kind === "user" ? userLoad : await dependencies.state.read(scope, signal);
      if (!userLoad.ok || !scopedLoad.ok || !("config" in userLoad.snapshot)) return resolveEffectiveUpdatePolicy({
        plugin: request.plugin,
        record: createUnavailableRecord(request.plugin),
        global: "manual",
        marketplaceSourceIdentity: "legacy-unavailable",
        pluginSourceIdentity: "legacy-unavailable",
      });
      const record = marketplaceUpdateRecords(scopedLoad.snapshot).find((candidate) => deriveMarketplaceRegistrationId({ scope: toScopeReference(scope), source: candidate.source }, dependencies.sha256) === MarketplaceRegistrationIdSchema.parse(request.registrationId));
      if (record === undefined) return resolveEffectiveUpdatePolicy({ plugin: request.plugin, record: createUnavailableRecord(request.plugin), global: "manual", marketplaceSourceIdentity: "legacy-unavailable", pluginSourceIdentity: "legacy-unavailable" });
      const scopedOverride = scopeOverride(scopedLoad.snapshot);
      return resolveEffectiveUpdatePolicy({
        plugin: PluginKeySchema.parse(request.plugin),
        record,
        global: userLoad.snapshot.config.global.application,
        ...(scopedOverride === undefined ? {} : { scope: scopedOverride }),
        marketplaceSourceIdentity: StableSourceIdentitySchema.parse(request.marketplaceSourceIdentity),
        registeredMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity(record.source, dependencies.sha256),
        pluginSourceIdentity: StableSourceIdentitySchema.parse(request.pluginSourceIdentity),
      });
    },
  });

  async function status(request: NativeUpdateStatusRequest, signal: AbortSignal): Promise<NativeUpdatePolicyStatus> {
    const parsed = NativeUpdateStatusRequestSchema.parse(request);
    const authority = await load(signal);
    if (authority === undefined) return NativeUpdatePolicyStatusSchema.parse({ global: { application: "manual", cadence: "paused" }, scopes: [], policies: [], inventoryComplete: false });
    const selectedScopes = authority.scopes.filter((snapshot) => parsed.scope === "all-current" || snapshot.scope.kind === parsed.scope);
    const policies = selectedScopes.flatMap((snapshot) => installedRows(snapshot, dependencies.sha256))
        .filter((row) => parsed.plugin === undefined || row.plugin === parsed.plugin)
        .map((row) => ({
          scope: row.scope,
          plugin: row.plugin,
          ...(row.record.applicationOverride === undefined ? {} : { marketplaceOverride: row.record.applicationOverride }),
          ...(row.record.pluginOverrides.find((override) => override.plugin === row.plugin)?.mode === undefined ? {} : { pluginOverride: row.record.pluginOverrides.find((override) => override.plugin === row.plugin)!.mode }),
          effective: effective(row, authority.user.config.global.application, scopeOverride(selectedScopes.find((snapshot) => sameScope(toScopeReference(snapshot.scope), row.scope))!), dependencies.sha256),
        }));
      const now = dependencies.clock.nowEpochMilliseconds();
      const scheduler = dependencies.schedulerStatus?.snapshot();
      const scopes = selectedScopes.map((snapshot) => {
        const reference = toScopeReference(snapshot.scope);
        const projected = scheduler?.scopes.find((entry) => sameScope(entry.scope, reference));
        const durableNextAt = marketplaceUpdateRecords(snapshot).map((record) => record.refresh.schedule?.dueAt).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
        const nextAt = projected?.nextAt ?? durableNextAt;
        const regressed = marketplaceUpdateRecords(snapshot).some((record) => record.refresh.schedule !== undefined && now < record.refresh.schedule.anchorAt);
        return {
          scope: reference,
          ...(scopeOverride(snapshot) === undefined ? {} : { override: scopeOverride(snapshot) }),
          ownership: projected?.ownership ?? "none" as const,
          clock: regressed ? "regressed" as const : "current" as const,
          ...(nextAt === undefined ? {} : { nextAt }),
        };
      });
    // The status contract exposes only update policy; reconciliation
    // resolution preferences live on the same global object but are not part
    // of this strict view.
    return NativeUpdatePolicyStatusSchema.parse({ global: { application: authority.user.config.global.application, cadence: authority.user.config.global.cadence }, scopes, policies, inventoryComplete: authority.complete });
  }

  return Object.freeze({ preview, apply, status, authority: authorityPort });
}

function createUnavailableRecord(plugin: PluginKey): MarketplaceRegistrationRecord {
  const marketplace = plugin.slice(plugin.lastIndexOf("@") + 1);
  return MarketplaceRegistrationRecordSchema.parse({
    marketplace,
    source: { kind: "local-git", path: "/unavailable" },
    origin: { kind: "legacy" },
    pluginOverrides: [],
    refresh: { consecutiveFailures: 0 },
    notices: [],
  });
}

export { resolveEffectiveUpdatePolicy } from "./update-policy-resolution.js";
