import { createHash } from "node:crypto";
import type {
  HookExecutionActiveSelection,
  HookExecutionActiveSelectionPort,
  HookExecutionBinding,
} from "../application/ports/hook-execution-context.js";
import {
  McpLaunchBindingSchemaV1,
  type McpLaunchActiveSelection,
  type McpLaunchActiveSelectionPort,
  type McpLaunchBinding,
} from "../application/ports/mcp-launch-context.js";
import {
  CurrentProjectRuntimeContextSchema,
  type CurrentProjectRuntimeContext,
} from "../application/ports/project-trust.js";
import type { PluginKey } from "../domain/identity.js";
import type { CompatibilityReport } from "../domain/compatibility.js";
import type { InstalledRevisionRecord } from "../domain/state/installed-state.js";
import type { ScopeReference } from "../domain/state/scope.js";
import type { RuntimeProjectionSelection } from "../runtime/skill-hook/runtime-snapshot.js";

export type RuntimeSelection = Readonly<{
  scope: ScopeReference;
  plugin: PluginKey;
  revision: InstalledRevisionRecord;
  compatibility: CompatibilityReport;
  skillHook: RuntimeProjectionSelection;
  hooks: readonly HookExecutionActiveSelection[];
  mcp: readonly Readonly<{
    binding: McpLaunchBinding;
    selection: McpLaunchActiveSelection;
  }>[];
}>;

export interface RuntimeSelectionCatalog
  extends HookExecutionActiveSelectionPort, McpLaunchActiveSelectionPort {
  snapshot(): Readonly<{
    epoch: import("../domain/content-manifest.js").ContentDigest;
    currentProject: CurrentProjectRuntimeContext;
    selections: readonly RuntimeSelection[];
  }>; 
  replace(next: readonly RuntimeSelection[], currentProject: CurrentProjectRuntimeContext): Promise<void>;
  beginCandidate(next: readonly RuntimeSelection[], currentProject?: CurrentProjectRuntimeContext): Readonly<{
    commit(): void;
    rollback(): void;
  }>;
  rollbackCandidate(): void;
  close(): Promise<void>;
}

type Epoch = {
  readonly id: number;
  readonly currentProject: CurrentProjectRuntimeContext;
  readonly selections: readonly RuntimeSelection[];
  pins: number;
  retired: boolean;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function epochDigest(epoch: Epoch): import("../domain/content-manifest.js").ContentDigest {
  const evidence = {
    epoch: epoch.id,
    currentProject: {
      projectKey: epoch.currentProject.projectKey,
      trust: epoch.currentProject.trust,
    },
    selections: epoch.selections.map((selection) => ({
      scope: selection.scope,
      plugin: selection.plugin,
      revision: selection.revision.revision,
      compatibility: selection.revision.evidence.compatibility.fingerprint,
      projection: selection.skillHook.prepared.expectation.projection.digest,
      hooks: selection.hooks.map((hook) => hook.binding),
      mcp: selection.mcp.map((entry) => entry.binding),
    })),
  };
  return `sha256:${createHash("sha256").update(`runtime-selection-epoch-v1\0${canonical(evidence)}`).digest("hex")}` as import("../domain/content-manifest.js").ContentDigest;
}

function hookSelection(epoch: Epoch, binding: HookExecutionBinding): HookExecutionActiveSelection | undefined {
  const matches = epoch.selections.flatMap((selection) => selection.hooks)
    .filter((selection) => same(selection.binding, binding));
  return matches.length === 1 ? matches[0] : undefined;
}

function mcpSelection(epoch: Epoch, binding: McpLaunchBinding): McpLaunchActiveSelection | undefined {
  const matches = epoch.selections.flatMap((selection) => selection.mcp)
    .filter((entry) => same(entry.binding, binding));
  return matches.length === 1 ? matches[0]!.selection : undefined;
}

function immutableSelections(input: readonly RuntimeSelection[]): readonly RuntimeSelection[] {
  const targets = new Set<string>();
  const hookBindings = new Set<string>();
  const mcpBindings = new Set<string>();
  const values = input.map((selection) => {
    const target = canonical({ scope: selection.scope, plugin: selection.plugin });
    if (targets.has(target)) throw new Error("runtime selection target collision");
    targets.add(target);
    for (const hook of selection.hooks) {
      const key = canonical(hook.binding);
      if (hookBindings.has(key)) throw new Error("runtime hook binding collision");
      hookBindings.add(key);
    }
    for (const mcp of selection.mcp) {
      McpLaunchBindingSchemaV1.parse(mcp.binding);
      const key = canonical(mcp.binding);
      if (mcpBindings.has(key)) throw new Error("runtime MCP binding collision");
      mcpBindings.add(key);
    }
    return Object.freeze({
      ...selection,
      hooks: Object.freeze([...selection.hooks]),
      mcp: Object.freeze(selection.mcp.map((entry) => Object.freeze({ ...entry }))),
    });
  });
  return Object.freeze(values);
}

/** One session-owned immutable selection epoch with callback pinning. */
export function createRuntimeSelectionCatalog(
  initialProject: CurrentProjectRuntimeContext,
): RuntimeSelectionCatalog {
  let nextEpochId = 1;
  let current: Epoch = {
    id: 0,
    currentProject: CurrentProjectRuntimeContextSchema.parse(initialProject),
    selections: Object.freeze([]),
    pins: 0,
    retired: false,
  };
  const retired = new Set<Epoch>();
  let closing = false;
  let closed = false;
  let pending: Readonly<{ previous: Epoch; candidate: Epoch }> | undefined;
  const drainWaiters = new Set<() => void>();

  function collect(epoch: Epoch): void {
    if (epoch.retired && epoch.pins === 0) retired.delete(epoch);
    if (closing && current.pins === 0 && [...retired].every((candidate) => candidate.pins === 0)) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    }
  }

  const catalog: RuntimeSelectionCatalog = {
    get(binding) {
      if (closing || closed) return undefined;
      return hookSelection(current, binding);
    },
    currentProject() {
      return current.currentProject;
    },
    async withSelection(bindingInput, signal, use) {
      signal.throwIfAborted();
      if (closing || closed) throw new Error("runtime selection catalog is closed");
      const binding = McpLaunchBindingSchemaV1.parse(bindingInput);
      const epoch = current;
      const selection = mcpSelection(epoch, binding);
      if (selection === undefined) throw new Error("active MCP selection is unavailable");
      epoch.pins += 1;
      try {
        signal.throwIfAborted();
        await use(selection);
      } finally {
        epoch.pins -= 1;
        collect(epoch);
      }
    },
    snapshot() {
      return Object.freeze({
        epoch: epochDigest(current),
        currentProject: current.currentProject,
        selections: current.selections,
      });
    },
    async replace(next, project) {
      if (closing || closed || pending !== undefined) throw new Error("runtime selection catalog is unavailable");
      const parsedProject = CurrentProjectRuntimeContextSchema.parse(project);
      const selections = immutableSelections(next);
      const previous = current;
      current = {
        id: nextEpochId++,
        currentProject: parsedProject,
        selections,
        pins: 0,
        retired: false,
      };
      previous.retired = true;
      if (previous.pins > 0) retired.add(previous);
      collect(previous);
    },
    beginCandidate(next, project = current.currentProject) {
      if (closing || closed || pending !== undefined) throw new Error("runtime selection candidate is unavailable");
      const previous = current;
      const candidate: Epoch = {
        id: nextEpochId++,
        currentProject: CurrentProjectRuntimeContextSchema.parse(project),
        selections: immutableSelections(next),
        pins: 0,
        retired: false,
      };
      pending = { previous, candidate };
      current = candidate;
      let settled = false;
      return Object.freeze({
        commit(): void {
          if (settled || pending?.candidate !== candidate || current !== candidate) throw new Error("runtime selection candidate is stale");
          settled = true;
          pending = undefined;
          previous.retired = true;
          if (previous.pins > 0) retired.add(previous);
          collect(previous);
        },
        rollback(): void {
          if (settled) return;
          settled = true;
          if (pending?.candidate !== candidate || current !== candidate) throw new Error("runtime selection candidate is stale");
          pending = undefined;
          candidate.retired = true;
          if (candidate.pins > 0) retired.add(candidate);
          current = previous;
          collect(candidate);
        },
      });
    },
    rollbackCandidate() {
      if (pending === undefined) return;
      const { previous, candidate } = pending;
      pending = undefined;
      candidate.retired = true;
      if (candidate.pins > 0) retired.add(candidate);
      current = previous;
      collect(candidate);
    },
    async close() {
      if (closed) return;
      if (closing) {
        await new Promise<void>((resolve) => drainWaiters.add(resolve));
        return;
      }
      closing = true;
      if (current.pins > 0 || [...retired].some((epoch) => epoch.pins > 0)) {
        await new Promise<void>((resolve) => drainWaiters.add(resolve));
      }
      current = { ...current, selections: Object.freeze([]) };
      retired.clear();
      closed = true;
    },
  };
  return Object.freeze(catalog);
}
