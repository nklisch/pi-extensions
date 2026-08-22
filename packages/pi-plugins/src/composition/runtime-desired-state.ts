import type { CompatibilityService } from "../application/compatibility-service.js";
import { createPluginMcpProjection } from "../application/mcp-plugin-projection.js";
import type { ContentStorePort } from "../application/ports/content-store.js";
import type { InstalledPluginLoader } from "../application/ports/installed-plugin-loader.js";
import {
  McpRuntimeCapabilitiesSchemaV1,
  type McpRuntimeCapabilities,
  type McpRuntimePort,
} from "../application/ports/mcp-runtime.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import {
  createActiveProjectionExpectation,
  createInactiveProjectionExpectation,
  createPluginRuntimeProjection,
} from "../application/ports/runtime-projection.js";
import type { RuntimeProjectionCachePort } from "../application/runtime-projection-cache.js";
import { CompatibilityReportSchema } from "../domain/compatibility.js";
import { createTrustCandidate } from "../domain/trust-policy.js";
import type { InstalledPluginRecord } from "../domain/state/installed-state.js";
import { toScopeReference, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { PiProjectContextAdapters } from "../pi/pi-project-context.js";
import { digestSkillHookContribution, type RuntimeProjectionSelection } from "../runtime/skill-hook/runtime-snapshot.js";
import type { SkillHookRuntimeSetRequest } from "../runtime/skill-hook/runtime-catalog.js";
import type { McpLifecycleState } from "../runtime/mcp/lifecycle-participant.js";
import type { RuntimeSelection } from "./runtime-selection-catalog.js";

/** Plugin-local runtime degradation. State remains authoritative; these fields
 * describe only the revision selected for this session and the revision that
 * actually supplied its runtime, if any. */
export type HostBlockedPlugin = Readonly<{
  plugin: string;
  scope?: ScopeReference;
  code: string;
  explanation: string;
  selectedRevision?: ContentDigest;
  runningRevision?: ContentDigest;
}>;

export type RuntimeDesiredStateOverride = Readonly<{
  scope: ScopeReference;
  plugin: string;
  record: InstalledPluginRecord | null;
}>;

export type RuntimeDesiredState = Readonly<{
  currentProject: ReturnType<PiProjectContextAdapters["current"]>;
  selections: readonly RuntimeSelection[];
  skillHook: SkillHookRuntimeSetRequest;
  mcp: readonly Readonly<{ from: McpLifecycleState; to: McpLifecycleState }>[];
  /** Degraded plugins are still exposed through `blocked` for U4 callers. */
  degraded: readonly HostBlockedPlugin[];
  blocked: readonly HostBlockedPlugin[];
}>;

const unavailableMcpCapabilities: McpRuntimeCapabilities = McpRuntimeCapabilitiesSchemaV1.parse({
  schemaVersion: 1,
  sourceLifecycle: {
    initialSourcesBeforeToolRegistration: false,
    isolatedFileDiscovery: false,
    localValidation: false,
    atomicReplace: false,
    exactRemove: false,
    inspect: false,
    cancellable: false,
    lateLaunchValues: false,
    runtimeLeases: false,
  },
  transports: { stdio: false, streamableHttp: false, legacySse: false, websocket: false },
  oauth: { authorizationCode: false, clientCredentials: false },
  features: {
    sampling: false,
    elicitationForm: false,
    elicitationUrl: false,
    toolApproval: false,
    resources: false,
    pluginToolAliases: false,
  },
});

function selected(record: InstalledPluginRecord) {
  return record.revisions.find((revision) => revision.revision === record.selectedRevision);
}

/** Rebuild exact desired runtime state from authority; caches are replaceable. */
export async function buildRuntimeDesiredState(input: Readonly<{
  installed: InstalledPluginLoader;
  compatibility: CompatibilityService;
  projections: RuntimeProjectionCachePort;
  project: PiProjectContextAdapters;
  mcp?: McpRuntimePort;
  state: LifecycleStateStore;
  content?: Pick<ContentStorePort, "resolvePlugin" | "ensureDataRoot">;
  userBaseDirectory: string;
  sha256: Sha256;
  /** False only when the one host-level subagent registration failed. */
  subagentRegistrationAvailable?: boolean;
}>, signal: AbortSignal, overrides: readonly RuntimeDesiredStateOverride[] = []): Promise<RuntimeDesiredState> {
  signal.throwIfAborted();
  const currentProject = await input.project.revalidate(signal);
  const user = await input.state.read({ kind: "user" }, signal);
  if (!user.ok) throw new Error("authoritative user state is corrupt");
  const authoritative = [user.snapshot];
  if (currentProject.trust.kind === "trusted") {
    const project = await input.state.read(input.project.scope, signal);
    if (!project.ok) throw new Error("authoritative current-project state is corrupt");
    authoritative.push(project.snapshot);
  }

  const trustRecords = authoritative.find((snapshot) => "trust" in snapshot && snapshot.scope.kind === "user");
  const records: Array<{ scope: ScopeContext; record: InstalledPluginRecord }> = [];
  for (const snapshot of authoritative) {
    if ("installed" in snapshot) {
      records.push(...snapshot.installed.plugins.map((record) => ({ scope: snapshot.scope, record })));
    } else {
      records.push(...snapshot.project.plugins.map((record) => ({ scope: snapshot.scope, record })));
    }
  }
  const authorityByScope = new Map(authoritative.map((snapshot) => [JSON.stringify(toScopeReference(snapshot.scope)), snapshot.scope]));
  const overrideByTarget = new Map(overrides.map((override) => [JSON.stringify([override.scope, override.plugin]), override]));
  const effectiveRecords = records.filter((entry) => {
    const key = JSON.stringify([toScopeReference(entry.scope), entry.record.plugin]);
    return !overrideByTarget.has(key);
  });
  for (const override of overrides) {
    if (override.record === null) continue;
    const scope = authorityByScope.get(JSON.stringify(override.scope));
    if (scope === undefined) throw new Error("runtime desired-state override is outside current authority");
    effectiveRecords.push({ scope, record: override.record });
  }

  if (typeof input.userBaseDirectory !== "string" || input.userBaseDirectory.length === 0) {
    throw new TypeError("runtime desired state requires a user configuration base directory");
  }
  const degraded: HostBlockedPlugin[] = [];
  const selections: RuntimeSelection[] = [];
  let trustedProjectRoot: Awaited<ReturnType<PiProjectContextAdapters["authority"]["acquire"]>> | undefined;
  const skillHookActive: RuntimeProjectionSelection[] = [];
  const mcpTransitions: Array<{ from: McpLifecycleState; to: McpLifecycleState }> = [];
  let runtimeCapabilities = unavailableMcpCapabilities;
  let mcpCapabilitiesFailed = false;
  if (input.mcp !== undefined) {
    try {
      runtimeCapabilities = McpRuntimeCapabilitiesSchemaV1.parse(await input.mcp.capabilities(signal));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // A broken optional MCP adapter must degrade only plugins that declare
      // MCP. Skill- and hook-only plugins remain loadable in the same session.
      mcpCapabilitiesFailed = true;
    }
  }
  const subagentRegistrationAvailable = input.subagentRegistrationAvailable !== false;

  class RuntimeLoadFailure extends Error {
    readonly failureCode: string;
    constructor(failureCode: string, message: string) {
      super(message);
      this.name = "RuntimeLoadFailure";
      this.failureCode = failureCode;
    }
  }
  function failureCode(error: unknown): string {
    if (error instanceof RuntimeLoadFailure) return error.failureCode;
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
    return "RUNTIME_RECONSTRUCTION_FAILED";
  }
  function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function hasSubagentHooks(plugin: Awaited<ReturnType<InstalledPluginLoader["load"]>>["plugin"]): boolean {
    return plugin.components.hooks.some((hook) => hook.event.value === "SubagentStart" || hook.event.value === "SubagentStop");
  }

  for (const entry of effectiveRecords) {
    signal.throwIfAborted();
    const record = entry.record;
    if (record.activation !== "enabled") continue;
    const selectedRevision = selected(record);
    const previous = record.previousRevision === undefined
      ? undefined
      : record.revisions.find((revision) => revision.revision === record.previousRevision);
    const candidates = [
      ...(selectedRevision === undefined ? [] : [{ revision: selectedRevision, fallback: false }]),
      ...(previous === undefined || previous.revision === selectedRevision?.revision ? [] : [{ revision: previous, fallback: true }]),
    ];
    let firstFailure: Readonly<{ code: string; explanation: string }> | undefined = selectedRevision === undefined
      ? Object.freeze({ code: "REVISION_UNAVAILABLE", explanation: "selected installed revision is unavailable" })
      : undefined;
    let runningRevision: ContentDigest | undefined;
    let loadedSelection: RuntimeSelection | undefined;
    let loadedSkillHook: RuntimeProjectionSelection | undefined;
    let loadedMcpTransition: { from: McpLifecycleState; to: McpLifecycleState } | undefined;

    for (const candidateRevision of candidates) {
      try {
        const revision = candidateRevision.revision;
        if (mcpCapabilitiesFailed && revision.evidence.components.some((component) => component.kind === "mcp-server")) {
          throw new RuntimeLoadFailure("MCP_RUNTIME_UNAVAILABLE", "MCP runtime capabilities could not be reconstructed");
        }
        const loaded = await input.installed.load({ scope: entry.scope, revision }, signal);
        // Re-assess with the install-time marketplace policy (stored on the
        // descriptor) so an unchanged runtime reproduces the install-time
        // report and projection digest exactly, while live capability probing
        // still fails closed when the runtime drifts. Assessing without the
        // policy diverges from the install-time digest and strands installs in
        // recovery-required; using the stored report verbatim would freeze
        // install-time capability availability into activation.
        const compatibility = await input.compatibility.assess({
          plugin: loaded.plugin,
          ...(loaded.installationPolicy === undefined ? {} : { marketplacePolicy: loaded.installationPolicy }),
        }, signal);
        if (!compatibility.activatable) {
          throw new RuntimeLoadFailure("CAPABILITY_UNAVAILABLE", "current runtime capabilities do not support the complete plugin");
        }
        if (!subagentRegistrationAvailable && hasSubagentHooks(loaded.plugin)) {
          throw new RuntimeLoadFailure("SUBAGENT_REGISTRATION_FAILED", "subagent hooks could not be registered for this session");
        }
        const scopeReference = toScopeReference(entry.scope);
        const expectation = createActiveProjectionExpectation(createPluginRuntimeProjection({
          scope: scopeReference,
          plugin: loaded.plugin,
          compatibility,
          revision,
          sha256: input.sha256,
        }), input.sha256);
        await input.projections.prepare(expectation, signal);
        const cached = await input.projections.read(expectation, signal);
        if (cached.kind !== "ready") throw new RuntimeLoadFailure(cached.kind === "failed" ? cached.code : "RUNTIME_PROJECTION_CANCELLED", "runtime projection cache could not be rebuilt");
        const skillHook: RuntimeProjectionSelection = Object.freeze({ prepared: cached.value, revision });
        const candidate = createTrustCandidate({
          scope: scopeReference,
          marketplaceSource: loaded.marketplaceSource,
          plugin: loaded.plugin,
          compatibility,
          content: loaded.content,
          materializationBinding: loaded.binding,
        }, input.sha256);
        const pathContext = entry.scope.kind === "project"
          ? Object.freeze({
              scope: entry.scope,
              trustedProjectRoot: trustedProjectRoot ??= await input.project.authority.acquire(signal),
            })
          : Object.freeze({ scope: entry.scope, trustedBaseDirectory: input.userBaseDirectory });
        const trust = trustRecords !== undefined && "trust" in trustRecords ? trustRecords.trust.records : [];
        const roots = input.content === undefined ? undefined : await Promise.all([
          input.content.resolvePlugin(revision, signal, scopeReference),
          input.content.ensureDataRoot({ scope: scopeReference, plugin: entry.record.plugin, dataRef: revision.dataRef }, signal),
        ]);
        const contributionDigest = digestSkillHookContribution({
          scope: scopeReference,
          plugin: entry.record.plugin,
          revision: revision.revision,
          projectionDigest: expectation.projection.digest,
          skills: expectation.projection.components.skills,
          hooks: expectation.projection.components.hooks,
        }, input.sha256);
        const hooks = roots === undefined ? [] : expectation.projection.components.hooks.map((component, hookOrdinal) => ({
          binding: {
            scope: scopeReference,
            plugin: entry.record.plugin,
            revision: revision.revision,
            projectionDigest: expectation.projection.digest,
            contributionDigest,
            componentId: component.id,
            sourceOrder: { snapshotOrdinal: selections.length, hookOrdinal },
          },
          pluginRoot: roots[0].root,
          pluginDataRoot: roots[1].root,
          currentProject,
          candidate,
          trustRecords: trust,
          configurationRef: revision.configurationRef,
          descriptors: loaded.plugin.configuration,
          pathContext,
        }));
        const mcpProjection = createPluginMcpProjection({
          projection: expectation.projection,
          compatibility,
          runtimeCapabilities,
          sha256: input.sha256,
        });
        if (mcpProjection.kind === "source" && input.mcp !== undefined) {
          const validation = await input.mcp.validateSource(mcpProjection.registration, signal);
          if (!validation.ok || !sameJson(validation.value, mcpProjection.registration)) {
            throw new RuntimeLoadFailure("MCP_REGISTRATION_FAILED", "MCP source registration was rejected by the runtime");
          }
        }
        const from: McpLifecycleState = {
          kind: "inactive",
          expectation: createInactiveProjectionExpectation({ scope: scopeReference, plugin: entry.record.plugin, sha256: input.sha256 }),
        };
        const to: McpLifecycleState = mcpProjection.kind === "none"
          ? { kind: "none", expectation, projection: mcpProjection }
          : { kind: "source", expectation, projection: mcpProjection, capabilities: runtimeCapabilities };
        const mcp = mcpProjection.kind === "none" ? [] : Object.entries(mcpProjection.registration.source.servers).map(([serverKey, server]) => {
          const component = expectation.projection.components.mcpServers.find((candidate) => candidate.id === server.componentId);
          if (component === undefined) throw new RuntimeLoadFailure("MCP_PROJECTION_FAILED", "MCP projection component is unavailable");
          return {
            binding: {
              schemaVersion: 1 as const,
              source: mcpProjection.registration.source.identity,
              serverKey: serverKey as never,
              componentId: server.componentId,
              transport: server.transport,
            },
            selection: {
              expectation,
              revision,
              component,
              currentProject,
              candidate,
              trustRecords: trust,
              descriptors: loaded.plugin.configuration,
              pathContext,
            },
          };
        });
        loadedSkillHook = skillHook;
        loadedMcpTransition = { from, to };
        loadedSelection = Object.freeze({
          scope: scopeReference,
          plugin: entry.record.plugin,
          revision,
          compatibility,
          skillHook,
          hooks: Object.freeze(hooks),
          mcp: Object.freeze(mcp),
        });
        runningRevision = candidateRevision.fallback ? revision.revision : undefined;
        break;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const code = failureCode(error);
        firstFailure ??= Object.freeze({ code, explanation: error instanceof RuntimeLoadFailure ? error.message : "installed plugin runtime evidence could not be reconstructed" });
      }
    }

    if (loadedSelection === undefined || loadedSkillHook === undefined || loadedMcpTransition === undefined) {
      const failure = firstFailure ?? Object.freeze({ code: "REVISION_UNAVAILABLE", explanation: "selected installed revision is unavailable" });
      degraded.push({
        plugin: record.plugin,
        scope: toScopeReference(entry.scope),
        code: failure.code,
        explanation: failure.explanation,
        selectedRevision: record.selectedRevision,
      });
      continue;
    }
    selections.push(loadedSelection);
    skillHookActive.push(loadedSkillHook);
    mcpTransitions.push(loadedMcpTransition);
    if (runningRevision !== undefined) {
      degraded.push({
        plugin: record.plugin,
        scope: toScopeReference(entry.scope),
        code: firstFailure?.code ?? "SELECTED_REVISION_UNAVAILABLE",
        explanation: firstFailure?.explanation ?? "selected revision was unavailable; running the previous revision for this session",
        selectedRevision: record.selectedRevision,
        runningRevision,
      });
    }
  }
  const frozenDegraded = Object.freeze(degraded);
  return Object.freeze({
    currentProject,
    selections: Object.freeze(selections),
    skillHook: Object.freeze({ active: Object.freeze(skillHookActive), currentProject }),
    mcp: Object.freeze(mcpTransitions),
    degraded: frozenDegraded,
    blocked: frozenDegraded,
  });
}
