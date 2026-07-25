import { isAbortRejection } from "./abort-rejection.js";
import { authorizeTrustCandidate } from "./trust-service.js";
import {
  CurrentProjectRuntimeContextSchema,
  ProjectTrustAssessmentSchema,
} from "./ports/project-trust.js";
import {
  McpLaunchBindingSchemaV1,
  McpLaunchContextError,
  McpLaunchErrorCodes,
  type McpLaunchActiveSelection,
  type McpLaunchBinding,
  type McpLaunchContextPort,
  type McpLaunchContextPortDependencies,
  type ResolvedMcpLaunchContext,
} from "./ports/mcp-launch-context.js";
import { verifyProjectionExpectation } from "./ports/runtime-projection.js";
import { McpSourceProjectionBindingSchemaV1 } from "./ports/mcp-runtime.js";
import { McpServerComponentSchema } from "../domain/components.js";
import { PluginConfigurationSchema } from "../domain/configuration.js";
import { createMcpLaunchTemplate } from "../domain/mcp-launch-template.js";
import { createPluginStoreIdentityFromEvidence } from "../domain/content-store.js";
import { verifyInstalledRevisionRecord } from "../domain/state/installed-state.js";
import {
  createScopeContext,
  ScopeReferenceSchema,
  type ScopeContext,
  type ScopeReference,
} from "../domain/state/scope.js";
import { verifyTrustCandidate } from "../domain/trust-policy.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  return left.kind === right.kind &&
    (left.kind === "user" || (right.kind === "project" && left.projectKey === right.projectKey));
}

function authorityError(binding?: McpLaunchBinding): McpLaunchContextError {
  return new McpLaunchContextError({
    code: McpLaunchErrorCodes.authorityRejected,
    ...(binding === undefined ? {} : {
      source: binding.source,
      serverKey: binding.serverKey,
      componentId: binding.componentId,
      transport: binding.transport,
    }),
  });
}

function configurationError(binding: McpLaunchBinding): McpLaunchContextError {
  return new McpLaunchContextError({
    code: McpLaunchErrorCodes.configurationFailed,
    source: binding.source,
    serverKey: binding.serverKey,
    componentId: binding.componentId,
    transport: binding.transport,
  });
}

function parseSelection(
  input: McpLaunchActiveSelection,
  binding: McpLaunchBinding,
  dependencies: McpLaunchContextPortDependencies,
): Readonly<{
  selection: McpLaunchActiveSelection;
  scope: ScopeContext;
  projection: ReturnType<typeof McpSourceProjectionBindingSchemaV1.parse>;
  template: ReturnType<typeof createMcpLaunchTemplate>;
}> {
  const expectation = verifyProjectionExpectation(input.expectation, dependencies.sha256);
  if (expectation.kind !== "active") throw authorityError(binding);
  const revision = verifyInstalledRevisionRecord({ ...input.revision, scope: binding.source.scope }, dependencies.sha256);
  const component = McpServerComponentSchema.parse(input.component);
  const currentProject = CurrentProjectRuntimeContextSchema.parse(input.currentProject);
  const candidate = verifyTrustCandidate(input.candidate, dependencies.sha256);
  const descriptors = PluginConfigurationSchema.parse(input.descriptors);
  const pathScope = createScopeContext(input.pathContext.scope, dependencies.sha256);
  const projection = expectation.projection;

  if (!sameScope(projection.scope, binding.source.scope) ||
      projection.plugin !== binding.source.plugin ||
      projection.revision !== binding.source.revision ||
      projection.digest !== binding.source.projectionDigest ||
      revision.revision !== projection.revision ||
      revision.evidence.plugin.key !== projection.plugin ||
      revision.contentRef !== projection.contentRef ||
      revision.dataRef !== projection.dataRef ||
      revision.configurationRef !== projection.configurationRef ||
      candidate.evidence.plugin !== projection.plugin ||
      !sameScope(ScopeReferenceSchema.parse(candidate.evidence.scope), projection.scope) ||
      candidate.evidence.immutableRevision !== revision.revision ||
      candidate.evidence.executableSurfaceDigest !== revision.evidence.trust.executableSurfaceDigest ||
      !sameScope(pathScope.kind === "user" ? { kind: "user" } : { kind: "project", projectKey: pathScope.projectKey }, projection.scope)) {
    throw authorityError(binding);
  }

  const selectedComponents = projection.components.mcpServers.filter((entry) => entry.id === binding.componentId);
  if (selectedComponents.length !== 1 || component.id !== binding.componentId ||
      !sameJson(selectedComponents[0], component)) throw authorityError(binding);

  const trustEntries = candidate.surface.entries.filter((entry) => entry.kind === "mcp-server" && entry.id === component.id);
  if (trustEntries.length !== 1) throw authorityError(binding);
  const trustEntry = trustEntries[0]!;
  if (trustEntry.kind !== "mcp-server" || trustEntry.nativeKey !== component.nativeKey.value ||
      !sameJson(trustEntry.declaration, component.declaration.value)) throw authorityError(binding);

  const template = createMcpLaunchTemplate(component, projection.plugin);
  if (template.transport !== binding.transport) throw authorityError(binding);
  const projectionBinding = McpSourceProjectionBindingSchemaV1.parse({
    schemaVersion: 1,
    componentId: component.id,
    contentRef: projection.contentRef,
    dataRef: projection.dataRef,
    ...(projection.configurationRef === undefined
      ? {}
      : { configurationRef: projection.configurationRef }),
  });

  return {
    selection: Object.freeze({
      expectation,
      revision,
      component,
      currentProject,
      candidate,
      trustRecords: Object.freeze([...input.trustRecords]),
      descriptors,
      pathContext: Object.freeze({ ...input.pathContext, scope: pathScope }),
    }),
    scope: pathScope,
    projection: projectionBinding,
    template,
  };
}

/**
 * Build the exact late-bound authority window used by MCP launch rendering.
 * Selection/trust are checked before root or data effects, while the existing
 * configuration resolver repeats trust, document, path, and secret checks
 * immediately around the consumer callback.
 */
export function createMcpLaunchContextPort(
  dependencies: McpLaunchContextPortDependencies,
): McpLaunchContextPort {
  if (dependencies === null || typeof dependencies !== "object" ||
      dependencies.active === undefined || dependencies.content === undefined ||
      dependencies.projectRoots === undefined || dependencies.projectTrust === undefined ||
      dependencies.configuration === undefined || typeof dependencies.sha256 !== "function") {
    throw new TypeError("MCP launch context dependencies are required");
  }

  async function withContext(
    bindingInput: McpLaunchBinding,
    signal: AbortSignal,
    use: (context: ResolvedMcpLaunchContext) => Promise<void>,
  ): Promise<void> {
    let binding: McpLaunchBinding;
    try {
      if (typeof use !== "function") throw new Error("callback is required");
      signal.throwIfAborted();
      binding = McpLaunchBindingSchemaV1.parse(bindingInput);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (isAbortRejection(error)) throw error;
      throw authorityError();
    }

    try {
      await dependencies.active.withSelection(binding, signal, async (selectionInput) => {
        signal.throwIfAborted();
        const { selection, scope, projection, template } = parseSelection(selectionInput, binding, dependencies);

        // Deny unauthorized executable evidence before resolving/creating roots.
        const authorization = await authorizeTrustCandidate({
          candidate: selection.candidate,
          records: selection.trustRecords,
          scope,
        }, dependencies, signal);
        signal.throwIfAborted();
        if (authorization.kind !== "authorized") throw authorityError(binding);

        const freshProjectTrust = ProjectTrustAssessmentSchema.parse(
          await dependencies.projectTrust.assess(selection.currentProject.projectKey, signal),
        );
        signal.throwIfAborted();
        if (freshProjectTrust.kind !== "trusted" || selection.currentProject.trust.kind !== "trusted") {
          throw authorityError(binding);
        }

        const projectCapability = await dependencies.projectRoots.acquire(signal);
        signal.throwIfAborted();
        const currentProjectScope = createScopeContext({
          kind: "project",
          identity: selection.currentProject.identity,
          projectKey: selection.currentProject.projectKey,
        }, dependencies.sha256);
        dependencies.projectRoots.verify(projectCapability, currentProjectScope);
        if (projectCapability.projectKey !== selection.currentProject.projectKey ||
            projectCapability.canonicalRoot !== selection.currentProject.identity.canonicalRoot ||
            !sameJson(projectCapability.identity, selection.currentProject.identity) ||
            (binding.source.scope.kind === "project" &&
              binding.source.scope.projectKey !== projectCapability.projectKey)) {
          throw authorityError(binding);
        }

        const content = await dependencies.content.resolvePlugin(
          selection.revision,
          signal,
          binding.source.scope,
        );
        signal.throwIfAborted();
        const expectedContentIdentity = createPluginStoreIdentityFromEvidence({
          sourceHash: selection.revision.evidence.source.sourceHash,
          binding: selection.revision.revision,
        }, dependencies.sha256);
        if (content.kind !== "plugin" || content.contentRef !== selection.revision.contentRef ||
            !sameJson(content.identity, expectedContentIdentity) ||
            content.manifest.rootDigest !== selection.revision.contentDigest ||
            typeof content.root !== "string" || content.root.length === 0 || content.root.includes("\0")) {
          throw authorityError(binding);
        }

        const data = await dependencies.content.ensureDataRoot({
          scope: binding.source.scope,
          plugin: binding.source.plugin,
          dataRef: selection.revision.dataRef,
        }, signal);
        signal.throwIfAborted();
        if (!sameScope(data.scope, binding.source.scope) || data.plugin !== binding.source.plugin ||
            data.dataRef !== selection.revision.dataRef || typeof data.root !== "string" ||
            data.root.length === 0 || data.root.includes("\0")) {
          throw authorityError(binding);
        }

        const pathContext = binding.source.scope.kind === "project"
          ? Object.freeze({
              scope: selection.pathContext.scope,
              trustedProjectRoot: projectCapability,
            })
          : Object.freeze({
              scope: selection.pathContext.scope,
              ...(selection.pathContext.trustedBaseDirectory === undefined
                ? {}
                : { trustedBaseDirectory: selection.pathContext.trustedBaseDirectory }),
            });
        try {
          await dependencies.configuration.withResolvedPluginConfiguration({
            candidate: selection.candidate,
            trustRecords: selection.trustRecords,
            configurationRef: selection.revision.configurationRef,
            descriptors: selection.descriptors,
            pathContext,
          }, {
            ...dependencies.configuration.dependencies,
            projectTrust: dependencies.projectTrust,
            projectRoots: dependencies.projectRoots,
            sha256: dependencies.sha256,
          }, signal, async (configuration) => {
            signal.throwIfAborted();
            await use(Object.freeze({
              binding: McpLaunchBindingSchemaV1.parse(binding),
              pluginRoot: content.root,
              pluginDataRoot: data.root,
              projectRoot: projectCapability.canonicalRoot,
              projection,
              template,
              configuration,
            }));
          });
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (isAbortRejection(error) || error instanceof McpLaunchContextError) throw error;
          throw configurationError(binding);
        }
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (isAbortRejection(error) || error instanceof McpLaunchContextError) throw error;
      throw authorityError(binding);
    }
  }

  return Object.freeze({ withContext });
}
