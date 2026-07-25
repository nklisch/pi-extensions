import { canonicalJson, compareUtf8 } from "../domain/canonical-json.js";
import { hashContent, type ContentDigest } from "../domain/content-manifest.js";
import { parsePluginKey } from "../domain/identity.js";
import { serializeMarketplaceSource, type Sha256 } from "../domain/source.js";
import { PortableProjectDeclarationSchema, type PortablePluginDeclaration, type PortableProjectDeclaration } from "../domain/state/portable-project-declaration.js";
import type { ProjectGenerationSnapshot } from "./state-contract.js";
import { encodeProjectIntentDeclaration } from "./project-intent-codec.js";
import { deriveProjectSyncActionId, deriveProjectSyncConflictId } from "./native-lifecycle-operation-identifiers.js";
import {
  ProjectSyncActionKindRegistry,
  ProjectSyncConflictValueSchema,
  ProjectSyncPlanSchema,
  type ProjectIntentObservationId,
  type ProjectSyncAction,
  type ProjectSyncConflict,
  type ProjectSyncConflictResolution,
  type ProjectSyncMode,
  type ProjectSyncPlan,
  type ProjectSyncRequiredAction,
} from "./project-sync-contract.js";
import {
  deriveProjectSyncReadinessDigest,
  projectProjectSyncMachineState,
  type ProjectSyncMachineProjection,
  type ProjectSyncReadinessSnapshot,
} from "./project-sync-projection.js";
import { derivePluginSourceIdentity } from "../domain/update-policy.js";

const encoder = new TextEncoder();

export class ProjectSyncPlanningError extends Error {
  constructor(readonly code: "PROJECT_INTENT_MISSING" | "UNRESOLVED_MERGE" | "INVALID_RESOLUTION") { super(code); this.name = "ProjectSyncPlanningError"; }
}

export type ProjectSyncPlannerFile =
  | Readonly<{ status: "missing"; observationId: ProjectIntentObservationId }>
  | Readonly<{ status: "present"; observationId: ProjectIntentObservationId; declaration: PortableProjectDeclaration; digest: ContentDigest }>;

export type ProjectSyncPlannerContext = Readonly<{
  plan: ProjectSyncPlan;
  snapshot: ProjectGenerationSnapshot;
  machine: ProjectSyncMachineProjection;
  file: ProjectSyncPlannerFile;
  readiness: ProjectSyncReadinessSnapshot;
  desired?: PortableProjectDeclaration;
}>;

function digest(tag: string, value: unknown, sha256: Sha256): ContentDigest {
  return hashContent(encoder.encode(`${tag}\0${canonicalJson(value)}`), sha256);
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function sortedDeclaration(value: PortableProjectDeclaration): PortableProjectDeclaration { return PortableProjectDeclarationSchema.parse(value); }

function conflictValue(value: unknown, field: "source" | "enabled" | "constraint"): ProjectSyncConflict["file"] {
  if (value === undefined) return ProjectSyncConflictValueSchema.parse({ present: false });
  return ProjectSyncConflictValueSchema.parse(field === "source" ? { present: true, source: value }
    : field === "enabled" ? { present: true, enabled: value }
    : { present: true, constraint: value ?? null });
}

function mergeDeclarations(file: PortableProjectDeclaration, machine: PortableProjectDeclaration, sha256: Sha256): Readonly<{ desired: PortableProjectDeclaration; conflicts: readonly ProjectSyncConflict[] }> {
  const marketplaces = new Map(machine.marketplaces.map((entry) => [entry.marketplace, entry]));
  const plugins = new Map(machine.plugins.map((entry) => [entry.plugin, entry]));
  const conflicts: ProjectSyncConflict[] = [];
  for (const entry of file.marketplaces) {
    const local = marketplaces.get(entry.marketplace);
    if (local === undefined) marketplaces.set(entry.marketplace, entry);
    else if (serializeMarketplaceSource(local.source) !== serializeMarketplaceSource(entry.source)) {
      const evidence = { kind: "marketplace-source" as const, marketplace: entry.marketplace, file: conflictValue(entry.source, "source"), machine: conflictValue(local.source, "source") };
      conflicts.push({ ...evidence, id: deriveProjectSyncConflictId(evidence, sha256) });
    }
  }
  for (const entry of file.plugins) {
    const local = plugins.get(entry.plugin);
    if (local === undefined) plugins.set(entry.plugin, entry);
    else {
      if (local.enabled !== entry.enabled) {
        const evidence = { kind: "plugin-enabled" as const, plugin: entry.plugin, file: conflictValue(entry.enabled, "enabled"), machine: conflictValue(local.enabled, "enabled") };
        conflicts.push({ ...evidence, id: deriveProjectSyncConflictId(evidence, sha256) });
      }
      if (!same(local.constraint ?? null, entry.constraint ?? null)) {
        const evidence = { kind: "plugin-constraint" as const, plugin: entry.plugin, file: conflictValue(entry.constraint ?? null, "constraint"), machine: conflictValue(local.constraint ?? null, "constraint") };
        conflicts.push({ ...evidence, id: deriveProjectSyncConflictId(evidence, sha256) });
      }
    }
  }
  return {
    desired: sortedDeclaration({ schemaVersion: 1, marketplaces: [...marketplaces.values()], plugins: [...plugins.values()] }),
    conflicts: Object.freeze(conflicts.sort((left, right) => compareUtf8(left.id, right.id))),
  };
}

function applyResolutions(base: PortableProjectDeclaration, conflicts: readonly ProjectSyncConflict[], resolutions: readonly ProjectSyncConflictResolution[]): PortableProjectDeclaration {
  const byId = new Map(resolutions.map((resolution) => [resolution.conflictId, resolution]));
  if (byId.size !== resolutions.length || resolutions.some((resolution) => !conflicts.some((conflict) => conflict.id === resolution.conflictId)) || conflicts.some((conflict) => !byId.has(conflict.id))) {
    throw new ProjectSyncPlanningError("INVALID_RESOLUTION");
  }
  const marketplaces = new Map(base.marketplaces.map((entry) => [entry.marketplace, entry]));
  const plugins = new Map(base.plugins.map((entry) => [entry.plugin, entry]));
  for (const conflict of conflicts) {
    const choice = byId.get(conflict.id)!.choose;
    const selected = choice === "file" ? conflict.file : conflict.machine;
    if (conflict.kind === "marketplace-source") {
      const marketplace = conflict.marketplace!;
      if (choice === "omit" || !selected.present || selected.source === undefined) {
        marketplaces.delete(marketplace);
        for (const [plugin] of plugins) if (parsePluginKey(plugin).marketplace === marketplace) plugins.delete(plugin);
      } else marketplaces.set(marketplace, { marketplace, source: selected.source });
      continue;
    }
    const plugin = conflict.plugin!;
    if (choice === "omit" || !selected.present) { plugins.delete(plugin); continue; }
    const current = plugins.get(plugin);
    if (current === undefined) throw new ProjectSyncPlanningError("INVALID_RESOLUTION");
    if (conflict.kind === "plugin-enabled" && selected.enabled !== undefined) plugins.set(plugin, { ...current, enabled: selected.enabled });
    if (conflict.kind === "plugin-constraint" && selected.constraint !== undefined) {
      const { constraint: _constraint, ...without } = current;
      plugins.set(plugin, selected.constraint === null ? without : { ...without, constraint: selected.constraint });
    }
  }
  return sortedDeclaration({ schemaVersion: 1, marketplaces: [...marketplaces.values()], plugins: [...plugins.values()] });
}

function requiredAction(kind: ProjectSyncRequiredAction["kind"], owner: Readonly<{ plugin?: string; marketplace?: string }>, sha256: Sha256): ProjectSyncRequiredAction {
  const action = kind === "review-trust" ? "review-trust" : kind === "provide-configuration" ? "provide-configuration" : kind === "run-recovery" ? "run-recovery" : kind === "update-plugin" ? "review-update" : "inspect-source";
  const evidence = { kind, ...owner, action };
  return { id: deriveProjectSyncActionId(evidence, sha256), kind, ...owner, action } as ProjectSyncRequiredAction;
}

function constraintMatches(plugin: PortablePluginDeclaration, record: ProjectGenerationSnapshot["project"]["plugins"][number], sha256: Sha256): boolean {
  if (plugin.constraint === undefined) return true;
  const selected = record.revisions.find((revision) => revision.revision === record.selectedRevision);
  if (selected === undefined) return false;
  if (plugin.constraint.kind === "declared-version") return selected.evidence.source.declaredVersion === plugin.constraint.value;
  return selected.evidence.source.pluginSourceIdentity !== undefined && selected.evidence.source.pluginSourceIdentity === derivePluginSourceIdentity(plugin.constraint.source, sha256);
}

function prerequisites(desired: PortableProjectDeclaration, context: Readonly<{ snapshot: ProjectGenerationSnapshot; machine: ProjectSyncMachineProjection }>, sha256: Sha256): readonly ProjectSyncRequiredAction[] {
  const required = new Map<string, ProjectSyncRequiredAction>();
  const registrations = new Map(context.snapshot.project.marketplaceUpdates.map((entry) => [entry.marketplace, entry]));
  const records = new Map(context.snapshot.project.plugins.map((entry) => [entry.plugin, entry]));
  const readiness = new Map(context.machine.plugins.map((entry) => [entry.plugin, entry]));
  for (const marketplace of desired.marketplaces) {
    const current = registrations.get(marketplace.marketplace);
    if (current === undefined || serializeMarketplaceSource(current.source) !== serializeMarketplaceSource(marketplace.source)) {
      const action = requiredAction("register-marketplace", { marketplace: marketplace.marketplace }, sha256); required.set(action.id, action);
    }
  }
  for (const plugin of desired.plugins) {
    const record = records.get(plugin.plugin);
    if (record === undefined) { const action = requiredAction("install-plugin", { plugin: plugin.plugin }, sha256); required.set(action.id, action); continue; }
    const status = readiness.get(plugin.plugin);
    if (record.pendingTransition !== undefined || status?.pending) { const action = requiredAction("run-recovery", { plugin: plugin.plugin }, sha256); required.set(action.id, action); }
    if (!constraintMatches(plugin, record, sha256)) { const action = requiredAction("update-plugin", { plugin: plugin.plugin }, sha256); required.set(action.id, action); }
    if (status?.trust === "missing") { const action = requiredAction("review-trust", { plugin: plugin.plugin }, sha256); required.set(action.id, action); }
    if (status?.configuration === "missing") { const action = requiredAction("provide-configuration", { plugin: plugin.plugin }, sha256); required.set(action.id, action); }
  }
  for (const plugin of context.snapshot.project.plugins) if (plugin.pendingTransition !== undefined) { const action = requiredAction("run-recovery", { plugin: plugin.plugin }, sha256); required.set(action.id, action); }
  return Object.freeze([...required.values()].sort((left, right) => compareUtf8(left.id, right.id)));
}

function action(kind: ProjectSyncAction["kind"], owner: Readonly<{ plugin?: string; registrationId?: string }>, sha256: Sha256): ProjectSyncAction {
  const evidence = { kind, ...owner };
  return { id: deriveProjectSyncActionId(evidence, sha256), kind, ...owner } as ProjectSyncAction;
}

function executableActions(mode: ProjectSyncMode, desired: PortableProjectDeclaration, context: Readonly<{ snapshot: ProjectGenerationSnapshot; machine: ProjectSyncMachineProjection; file: ProjectSyncPlannerFile }>, sha256: Sha256): readonly ProjectSyncAction[] {
  const actions: ProjectSyncAction[] = [];
  const desiredPlugins = new Map(desired.plugins.map((entry) => [entry.plugin, entry]));
  const records = new Map(context.snapshot.project.plugins.map((entry) => [entry.plugin, entry]));
  const desiredMarkets = new Set(desired.marketplaces.map((entry) => entry.marketplace));
  const fileDifferent = context.file.status === "missing" || encodeProjectIntentDeclaration(context.file.declaration, sha256).digest !== encodeProjectIntentDeclaration(desired, sha256).digest;
  if ((mode === "publish-intent" || mode === "merge") && fileDifferent) actions.push(action("write-intent", {}, sha256));
  if (mode !== "publish-intent") {
    for (const record of context.snapshot.project.plugins) {
      const target = desiredPlugins.get(record.plugin);
      if (target === undefined) {
        // Uninstall already projects the complete plugin inactive before removing
        // authority, so a preceding disable would spend a second Pi reload.
        actions.push(action("uninstall-plugin", { plugin: record.plugin }, sha256));
      } else if (target.enabled !== (record.activation === "enabled")) {
        actions.push(action(target.enabled ? "enable-plugin" : "disable-plugin", { plugin: record.plugin }, sha256));
      }
    }
    for (const registration of context.machine.registrations) if (!desiredMarkets.has(registration.marketplace)) actions.push(action("remove-marketplace", { registrationId: registration.registrationId }, sha256));
  }
  const desiredDigest = encodeProjectIntentDeclaration(desired, sha256).digest;
  if (actions.length > 0 || context.snapshot.project.declarationDigest !== desiredDigest) actions.push(action("record-intent-digest", {}, sha256));
  const order = new Map(Object.values(ProjectSyncActionKindRegistry).map((entry) => [entry.tag, entry.order]));
  return Object.freeze(actions.sort((left, right) => (order.get(left.kind)! - order.get(right.kind)!) || compareUtf8(left.plugin ?? left.registrationId ?? left.id, right.plugin ?? right.registrationId ?? right.id)));
}

function buildPlan(input: Readonly<{
  mode: ProjectSyncMode;
  projectEpoch: ContentDigest;
  snapshot: ProjectGenerationSnapshot;
  machine: ProjectSyncMachineProjection;
  file: ProjectSyncPlannerFile;
  readiness: ProjectSyncReadinessSnapshot;
  desired?: PortableProjectDeclaration;
  conflicts: readonly ProjectSyncConflict[];
  sha256: Sha256;
}>): ProjectSyncPlan {
  const machineDigest = encodeProjectIntentDeclaration(input.machine.declaration, input.sha256).digest;
  const readinessDigest = deriveProjectSyncReadinessDigest(input.readiness, input.sha256);
  const desiredDigest = input.desired === undefined ? undefined : encodeProjectIntentDeclaration(input.desired, input.sha256).digest;
  const convergenceReadinessDigest = input.desired === undefined
    ? undefined
    : deriveProjectSyncReadinessDigest(input.readiness, input.sha256, new Set(input.desired.plugins.map((entry) => entry.plugin)));
  const requiredActions = input.desired === undefined ? [] : prerequisites(input.desired, input, input.sha256);
  const actions = input.desired === undefined || requiredActions.length > 0 ? [] : executableActions(input.mode, input.desired, input, input.sha256);
  const core = {
    mode: input.mode,
    projectKey: input.snapshot.scope.projectKey,
    projectEpoch: input.projectEpoch,
    stateGeneration: input.snapshot.generation,
    baselineDigest: input.snapshot.project.declarationDigest,
    file: { status: input.file.status, observationId: input.file.observationId, ...(input.file.status === "present" ? { digest: input.file.digest } : {}) },
    machineDigest,
    readinessDigest,
    ...(convergenceReadinessDigest === undefined ? {} : { convergenceReadinessDigest }),
    ...(desiredDigest === undefined ? {} : { desiredDigest }),
    actions,
    requiredActions,
    conflicts: input.conflicts,
  };
  return ProjectSyncPlanSchema.parse({ ...core, planDigest: digest("project-sync-plan-v1", core, input.sha256) });
}

export function createProjectSyncPlanningContext(input: Readonly<{
  mode: ProjectSyncMode;
  projectEpoch: ContentDigest;
  snapshot: ProjectGenerationSnapshot;
  file: ProjectSyncPlannerFile;
  readiness: ProjectSyncReadinessSnapshot;
  sha256: Sha256;
}>): ProjectSyncPlannerContext {
  if (input.mode === "apply-intent" && input.file.status === "missing") throw new ProjectSyncPlanningError("PROJECT_INTENT_MISSING");
  const existingFile = input.file.status === "present" ? input.file.declaration : undefined;
  const machine = projectProjectSyncMachineState({ snapshot: input.snapshot, readiness: input.readiness.plugins, ...(existingFile === undefined ? {} : { existingFile }), sha256: input.sha256 });
  let desired: PortableProjectDeclaration | undefined;
  let conflicts: readonly ProjectSyncConflict[] = [];
  if (input.mode === "apply-intent") desired = input.file.status === "present" ? input.file.declaration : undefined;
  else if (input.mode === "publish-intent") desired = machine.declaration;
  else if (input.file.status === "missing") desired = machine.declaration;
  else {
    const merged = mergeDeclarations(input.file.declaration, machine.declaration, input.sha256);
    conflicts = merged.conflicts;
    if (conflicts.length === 0) desired = merged.desired;
  }
  const plan = buildPlan({ ...input, machine, ...(desired === undefined ? {} : { desired }), conflicts });
  return Object.freeze({ plan, snapshot: input.snapshot, machine, file: input.file, readiness: input.readiness, ...(desired === undefined ? {} : { desired }) });
}

export function resolveProjectSyncConflicts(context: ProjectSyncPlannerContext, resolutions: readonly ProjectSyncConflictResolution[], sha256: Sha256): ProjectSyncPlannerContext {
  if (context.plan.mode !== "merge" || context.file.status !== "present" || context.plan.conflicts.length === 0) throw new ProjectSyncPlanningError("UNRESOLVED_MERGE");
  const base = mergeDeclarations(context.file.declaration, context.machine.declaration, sha256).desired;
  const desired = applyResolutions(base, context.plan.conflicts, resolutions);
  const plan = buildPlan({ mode: "merge", projectEpoch: context.plan.projectEpoch, snapshot: context.snapshot, machine: context.machine, file: context.file, readiness: context.readiness, desired, conflicts: [], sha256 });
  return Object.freeze({ ...context, desired, plan });
}
