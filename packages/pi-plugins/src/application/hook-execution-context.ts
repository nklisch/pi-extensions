import {
  CurrentProjectRuntimeContextSchema,
  type CurrentProjectRuntimeContext,
} from "./ports/project-trust.js";
import {
  HookExecutionContextError,
  type HookExecutionActiveSelection,
  type HookExecutionBinding,
  type HookExecutionContextPort,
  type HookExecutionContextPortDependencies,
  type HookExecutionContextRequest,
} from "./ports/hook-execution-context.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import { PluginKeySchema } from "../domain/identity.js";
import { ContentDigestSchema } from "../domain/content-manifest.js";
import { ComponentIdSchema } from "../domain/components.js";

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateBinding(input: HookExecutionBinding): HookExecutionBinding {
  return {
    scope: ScopeReferenceSchema.parse(input.scope),
    plugin: PluginKeySchema.parse(input.plugin),
    revision: ContentDigestSchema.parse(input.revision),
    projectionDigest: ContentDigestSchema.parse(input.projectionDigest),
    contributionDigest: ContentDigestSchema.parse(input.contributionDigest),
    componentId: ComponentIdSchema.parse(input.componentId),
    sourceOrder: {
      snapshotOrdinal: Number.isSafeInteger(input.sourceOrder.snapshotOrdinal) && input.sourceOrder.snapshotOrdinal >= 0
        ? input.sourceOrder.snapshotOrdinal
        : (() => { throw new HookExecutionContextError("INVALID_REQUEST"); })(),
      hookOrdinal: Number.isSafeInteger(input.sourceOrder.hookOrdinal) && input.sourceOrder.hookOrdinal >= 0
        ? input.sourceOrder.hookOrdinal
        : (() => { throw new HookExecutionContextError("INVALID_REQUEST"); })(),
    },
  };
}

function sameBinding(left: HookExecutionBinding, right: HookExecutionBinding): boolean {
  return sameJson(left.scope, right.scope) && left.plugin === right.plugin &&
    left.revision === right.revision && left.projectionDigest === right.projectionDigest &&
    left.contributionDigest === right.contributionDigest && left.componentId === right.componentId &&
    left.sourceOrder.snapshotOrdinal === right.sourceOrder.snapshotOrdinal &&
    left.sourceOrder.hookOrdinal === right.sourceOrder.hookOrdinal;
}

function validateSelection(selection: HookExecutionActiveSelection): HookExecutionActiveSelection {
  const binding = validateBinding(selection.binding);
  const currentProject = CurrentProjectRuntimeContextSchema.parse(selection.currentProject);
  if (typeof selection.pluginRoot !== "string" || selection.pluginRoot.length === 0 ||
      typeof selection.pluginDataRoot !== "string" || selection.pluginDataRoot.length === 0) {
    throw new HookExecutionContextError("BINDING_MISMATCH");
  }
  return { ...selection, binding, currentProject };
}

export function createHookExecutionContextPort(
  dependencies: HookExecutionContextPortDependencies,
): HookExecutionContextPort {
  if (dependencies === null || typeof dependencies !== "object" ||
      dependencies.active === undefined || dependencies.projectRoots === undefined ||
      dependencies.configuration === undefined) {
    throw new TypeError("hook execution context dependencies are required");
  }

  async function withContext(
    requestInput: HookExecutionContextRequest,
    signal: AbortSignal,
    use: (context: import("./ports/hook-execution-context.js").ResolvedHookExecutionContext) => Promise<void>,
  ): Promise<void> {
    let request: HookExecutionContextRequest;
    try {
      if (signal === null || typeof signal.aborted !== "boolean" || typeof use !== "function") {
        throw new HookExecutionContextError("INVALID_REQUEST");
      }
      const binding = validateBinding(requestInput.binding);
      const currentProject = CurrentProjectRuntimeContextSchema.parse(requestInput.currentProject);
      if (typeof requestInput.sessionCwd !== "string" || requestInput.sessionCwd.length === 0 ||
          typeof requestInput.plannedPluginRoot !== "string" || requestInput.plannedPluginRoot.length === 0 ||
          typeof requestInput.plannedPluginDataRoot !== "string" || requestInput.plannedPluginDataRoot.length === 0) {
        throw new HookExecutionContextError("INVALID_REQUEST");
      }
      request = { ...requestInput, binding, currentProject };
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof HookExecutionContextError) throw error;
      throw new HookExecutionContextError("INVALID_REQUEST");
    }

    let nativeProject: CurrentProjectRuntimeContext;
    let selected: HookExecutionActiveSelection;
    try {
      nativeProject = CurrentProjectRuntimeContextSchema.parse(dependencies.active.currentProject());
      if (!sameJson(nativeProject, request.currentProject)) throw new HookExecutionContextError("CURRENT_PROJECT_MISMATCH");
      const found = dependencies.active.get(request.binding);
      if (found === undefined) throw new HookExecutionContextError("ACTIVE_BINDING_UNAVAILABLE");
      selected = validateSelection(found);
      if (!sameBinding(selected.binding, request.binding) ||
          !sameJson(selected.currentProject, nativeProject) ||
          (selected.currentCwd !== undefined && selected.currentCwd !== request.sessionCwd) ||
          (request.binding.scope.kind === "project" && nativeProject.trust.kind !== "trusted") ||
          selected.pluginRoot !== request.plannedPluginRoot ||
          selected.pluginDataRoot !== request.plannedPluginDataRoot ||
          selected.pathContext.scope.kind !== request.binding.scope.kind ||
          (selected.pathContext.scope.kind === "project" && request.binding.scope.kind === "project" &&
            selected.pathContext.scope.projectKey !== request.binding.scope.projectKey)) {
        throw new HookExecutionContextError("BINDING_MISMATCH");
      }
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof HookExecutionContextError) throw error;
      throw new HookExecutionContextError("ACTIVE_BINDING_UNAVAILABLE");
    }

    let projectRoot: string;
    try {
      throwIfAborted(signal);
      const capability = await dependencies.projectRoots.acquire(signal);
      throwIfAborted(signal);
      if (capability.projectKey !== nativeProject.projectKey ||
          !sameJson(capability.identity, nativeProject.identity) ||
          typeof capability.canonicalRoot !== "string" || capability.canonicalRoot.length === 0) {
        throw new HookExecutionContextError("CURRENT_PROJECT_MISMATCH");
      }
      projectRoot = capability.canonicalRoot;
      const pathContext = selected.pathContext.scope.kind === "project"
        ? { ...selected.pathContext, trustedProjectRoot: capability }
        : selected.pathContext;

      await dependencies.configuration.withResolvedPluginConfiguration(
        {
          candidate: selected.candidate,
          trustRecords: selected.trustRecords,
          configurationRef: selected.configurationRef,
          descriptors: selected.descriptors,
          pathContext,
        },
        { ...dependencies.configuration.dependencies, projectRoots: dependencies.projectRoots },
        signal,
        async (configuration) => {
          await use(Object.freeze({
            cwd: request.sessionCwd,
            projectRoot,
            pluginRoot: selected.pluginRoot,
            pluginDataRoot: selected.pluginDataRoot,
            configuration,
          }));
        },
      );
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof HookExecutionContextError) throw error;
      throw new HookExecutionContextError("CONFIGURATION_FAILED");
    }
  }

  return Object.freeze({ withContext });
}
