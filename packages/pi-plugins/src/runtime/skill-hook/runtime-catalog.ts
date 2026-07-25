import {
  PluginKeySchema,
  type PluginKey,
} from "../../domain/identity.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "../../domain/state/scope.js";
import {
  CurrentProjectRuntimeContextSchema,
  type CurrentProjectRuntimeContext,
} from "../../application/ports/project-trust.js";
import type { SkillHookRuntimeSnapshot } from "./runtime-snapshot.js";

export type SkillHookRuntimeSetRequest = Readonly<{
  active: readonly import("./runtime-snapshot.js").RuntimeProjectionSelection[];
  currentProject: CurrentProjectRuntimeContext;
}>;

export type SkillHookReconcileResult =
  | Readonly<{ kind: "applied"; count: number }>
  | Readonly<{ kind: "failed"; code: "TARGET_COLLISION" | "SNAPSHOT_FAILED" | "ADAPTER_FAILED" }>
  | Readonly<{ kind: "cancelled" }>;

export interface SkillHookRuntimeCatalog {
  list(): readonly SkillHookRuntimeSnapshot[];
  get(scope: ScopeReference, plugin: PluginKey): SkillHookRuntimeSnapshot | undefined;
  currentProject(): CurrentProjectRuntimeContext | undefined;
}

export type RuntimeCatalogState = Readonly<{
  initialized: boolean;
  currentProject?: CurrentProjectRuntimeContext;
}>;

function scopeKey(scopeInput: ScopeReference): string {
  const scope = ScopeReferenceSchema.parse(scopeInput);
  return scope.kind === "user" ? "user" : `project:${scope.projectKey}`;
}

function targetKey(scope: ScopeReference, plugin: PluginKey): string {
  return `${scopeKey(scope)}\0${PluginKeySchema.parse(plugin)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function sameProject(left: CurrentProjectRuntimeContext, right: CurrentProjectRuntimeContext): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export type MutableSkillHookRuntimeCatalog = Readonly<{
  catalog: SkillHookRuntimeCatalog;
  state(): RuntimeCatalogState;
  lookup(scope: ScopeReference, plugin: PluginKey): SkillHookRuntimeSnapshot | undefined;
  publish(snapshots: readonly SkillHookRuntimeSnapshot[], currentProject: CurrentProjectRuntimeContext): void;
}>;

export function createSkillHookRuntimeCatalog(): MutableSkillHookRuntimeCatalog {
  let snapshots: readonly SkillHookRuntimeSnapshot[] = Object.freeze([]);
  let initialized = false;
  let currentProject: CurrentProjectRuntimeContext | undefined;
  const values = new Map<string, SkillHookRuntimeSnapshot>();

  function lookup(scope: ScopeReference, plugin: PluginKey): SkillHookRuntimeSnapshot | undefined {
    return values.get(targetKey(scope, plugin));
  }

  function publish(next: readonly SkillHookRuntimeSnapshot[], nextProject: CurrentProjectRuntimeContext): void {
    const parsedProject = CurrentProjectRuntimeContextSchema.parse(nextProject);
    const map = new Map<string, SkillHookRuntimeSnapshot>();
    for (const snapshot of next) {
      const parsed = snapshot;
      if (!hasSameCurrentProject(parsed.currentProject, parsedProject)) {
        throw new Error("runtime snapshot current-project context disagrees with the catalog");
      }
      const key = targetKey(parsed.scope, parsed.plugin);
      if (map.has(key)) throw new Error("runtime catalog target collision");
      map.set(key, parsed);
    }
    values.clear();
    for (const [key, snapshot] of map) values.set(key, snapshot);
    snapshots = Object.freeze([...next]);
    currentProject = parsedProject;
    initialized = true;
  }

  const catalog: SkillHookRuntimeCatalog = Object.freeze({
    list: () => snapshots,
    get: (scope: ScopeReference, plugin: PluginKey) => lookup(scope, plugin),
    currentProject: () => currentProject,
  });

  return Object.freeze({
    catalog,
    state: () => Object.freeze({
      initialized,
      ...(currentProject === undefined ? {} : { currentProject }),
    }),
    lookup,
    publish,
  });
}

export function hasSameCurrentProject(left: CurrentProjectRuntimeContext, right: CurrentProjectRuntimeContext): boolean {
  return sameProject(left, right);
}

export function runtimeTargetKey(scope: ScopeReference, plugin: PluginKey): string {
  return targetKey(scope, plugin);
}