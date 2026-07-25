import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHookExecutionContextPort } from "../application/hook-execution-context.js";
import {
  SubagentLifecycleCapabilitiesSchemaV1,
  type SubagentLifecyclePort,
} from "../application/ports/subagent-lifecycle.js";
import type { LifecycleClock } from "../application/ports/lifecycle-clock.js";
import type { RevisionLease, RevisionLeaseStore } from "../application/ports/revision-lease-store.js";
import type { RegisteredSubagentHookRuntime } from "../application/subagent-hook-runtime.js";
import { registerSubagentHookRuntime } from "../application/subagent-hook-runtime.js";
import { createPluginStoreIdentityFromEvidence } from "../domain/content-store.js";
import type { Sha256 } from "../domain/source.js";
import { createManifestContentReader } from "../infrastructure/filesystem/manifest-content-reader.js";
import { createManifestSkillPathVerifier } from "../infrastructure/filesystem/manifest-skill-path-verifier.js";
import type { NodeContentInfrastructure } from "../infrastructure/filesystem/create-content-store.js";
import { createNodeCommandRunner } from "../infrastructure/process/command-runner.js";
import { createNodeHookExecutableResolver } from "../infrastructure/process/hook-executable-resolver.js";
import type { PiSessionBindingPort } from "./packaged-plugin-host-contract.js";
import type { HostConfigurationDependencies } from "./create-host-configuration.js";
import type { PiProjectContextAdapters } from "../pi/pi-project-context.js";
import { createPiHookDecisionAdapter } from "../pi/hooks/pi-hook-decision-adapter.js";
import { createPiHookEventAdapter } from "../pi/hooks/pi-hook-event-adapter.js";
import { registerPiCommandHookRuntime } from "../pi/hooks/pi-command-hook-runtime.js";
import {
  createPluginHostRuntimeDelegates,
  type PluginHostRuntimeDelegates,
} from "../pi/plugin-host-runtime-delegates.js";
import { createNullHookFailureLog, type HookFailureLog } from "../runtime/hooks/hook-failure-log.js";
import { createPiSubagentSessionContext } from "../pi/pi-subagent-session-context.js";
import { createGuardedCommandHookExecutor, type GuardedCommandHookExecutor } from "../runtime/hooks/guarded-command-executor.js";
import { createHookEventPlanner } from "../runtime/hooks/hook-event-planner.js";
import { createStopContinuationGuard } from "../runtime/hooks/stop-continuation-guard.js";
import { createSkillHookRuntimeParticipant } from "../runtime/skill-hook/lifecycle-participant.js";
import type { SkillHookRuntimeCatalog } from "../runtime/skill-hook/runtime-catalog.js";
import { createSkillHookSnapshotLoader } from "../runtime/skill-hook/runtime-snapshot.js";
import { createSkillResourceDiscoveryRuntime, type SkillResourceDiscoveryPort } from "../runtime/skills/resource-discovery.js";
import { createSubagentHookCoordinator, type SubagentHookCoordinator } from "../runtime/subagents/subagent-hook-coordinator.js";
import type { RuntimeSelection, RuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import { disposeSequentially } from "./sequential-cleanup.js";

export type ComposedSkillHookRuntime = Readonly<{
  participant: ReturnType<typeof createSkillResourceDiscoveryRuntime>["participant"];
  resources: SkillResourceDiscoveryPort;
  hooks: GuardedCommandHookExecutor;
  catalog: SkillHookRuntimeCatalog;
  subagent?: RegisteredSubagentHookRuntime;
  replaceSessionLease(selections: readonly RuntimeSelection[], signal: AbortSignal): Promise<void>;
  quiesce(): void;
  resume(): void;
  close(): Promise<void>;
}>;

function retainedArtifacts(selections: readonly RuntimeSelection[], sha256: Sha256) {
  // The store key can be recovered directly from the prepared content
  // selection without opening the filesystem. Deduplicate exact references.
  const references = selections.flatMap((selection) => [
    { kind: "plugin" as const, key: createPluginStoreIdentityFromEvidence({
      sourceHash: selection.revision.evidence.source.sourceHash,
      binding: selection.revision.revision,
    }, sha256).key },
    { kind: "projection" as const, reference: selection.skillHook.prepared.expectation.projectionRef },
  ]);
  return Object.freeze([...new Map(references.map((reference) => [JSON.stringify(reference), reference])).values()]);
}

/** Compose the existing skill/hook/subagent seams for one exact Pi session. */
export async function createComposedSkillHookRuntime(input: Readonly<{
  pi: ExtensionAPI;
  binding: PiSessionBindingPort;
  content: NodeContentInfrastructure;
  selection: RuntimeSelectionCatalog;
  project: PiProjectContextAdapters;
  configuration: HostConfigurationDependencies;
  leases: RevisionLeaseStore;
  clock: LifecycleClock;
  subagents?: SubagentLifecyclePort;
  sha256: Sha256;
  delegates?: PluginHostRuntimeDelegates;
  failureLog?: HookFailureLog;
}>): Promise<ComposedSkillHookRuntime> {
  const runtimeAbort = new AbortController();
  const delegates = input.delegates ?? createPluginHostRuntimeDelegates(input.pi);
  const failureLog = input.failureLog ?? createNullHookFailureLog();
  let lease: RevisionLease | undefined;
  let subagent: RegisteredSubagentHookRuntime | undefined;
  let coordinator: SubagentHookCoordinator | undefined;
  let closePromise: Promise<void> | undefined;
  try {
    delegates.bindSession(input.binding);
    const loader = createSkillHookSnapshotLoader({
      content: input.content.content,
      projectRoots: input.project.authority,
      projectTrust: input.project.trust,
      sha256: input.sha256,
    });
    const source = createSkillHookRuntimeParticipant({ loader, sha256: input.sha256 });
    const resources = createSkillResourceDiscoveryRuntime({
      snapshots: source.participant,
      catalog: source.catalog,
      paths: createManifestSkillPathVerifier({ content: createManifestContentReader(input.sha256) }),
      sha256: input.sha256,
    });
    const planner = createHookEventPlanner({ catalog: source.catalog });
    const hookContext = createHookExecutionContextPort({
      active: input.selection,
      projectRoots: input.project.authority,
      configuration: input.configuration,
    });
    const executableResolver = createNodeHookExecutableResolver();
    const executor = createGuardedCommandHookExecutor({
      context: hookContext,
      command: createNodeCommandRunner(),
      executables: executableResolver,
    });
    const events = createPiHookEventAdapter({ planner, currentProject: () => input.project.current() });
    const decisions = createPiHookDecisionAdapter({ pi: input.pi });
    registerPiCommandHookRuntime({
      pi: delegates.pi,
      events,
      executor,
      decisions,
      continuation: createStopContinuationGuard(),
      currentProject: () => input.project.current(),
      runtimeSignal: runtimeAbort.signal,
      failureLog,
    });

    if (input.subagents !== undefined) {
      const qualification = SubagentLifecycleCapabilitiesSchemaV1.parse(
        await input.subagents.capabilities(runtimeAbort.signal),
      );
      // Production composition passes only the centrally-qualified, pinned
      // lifecycle port. Re-checking provider facts here would let registration
      // disagree with capability and desired-state decisions.
      coordinator = createSubagentHookCoordinator({
        planner,
        executor,
        sessions: createPiSubagentSessionContext({ binding: input.binding, project: input.project }),
        runtimeSignal: runtimeAbort.signal,
        continuationBudget: 3,
        failureLog,
      });
      subagent = await registerSubagentHookRuntime({
        lifecycle: input.subagents,
        qualification,
        coordinator,
        runtimeSignal: runtimeAbort.signal,
      });
    }

    async function replaceSessionLease(selections: readonly RuntimeSelection[], signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const artifacts = retainedArtifacts(selections, input.sha256);
      const at = input.clock.nowEpochMilliseconds();
      lease = lease === undefined
        ? await input.leases.acquire({ sessionId: input.binding.current().sessionId, artifacts, at }, signal)
        : await input.leases.replace(lease, artifacts, at, signal);
    }

    async function close(): Promise<void> {
      closePromise ??= (async () => {
        if (!runtimeAbort.signal.aborted) runtimeAbort.abort(new DOMException("skill/hook runtime closed", "AbortError"));
        delegates.clear();
        function* cleanupDisposers() {
          yield () => subagent?.dispose();
          yield () => coordinator?.dispose();
          if (lease === undefined) return;
          const sessionLease = lease;
          yield async () => {
            try { await input.leases.release(sessionLease, input.clock.nowEpochMilliseconds(), new AbortController().signal); }
            finally { lease = undefined; }
          };
        }
        await disposeSequentially(cleanupDisposers(), "skill/hook runtime cleanup failed");
      })();
      return closePromise;
    }

    return Object.freeze({
      participant: resources.participant,
      resources: resources.resources,
      hooks: executor,
      catalog: source.catalog,
      ...(subagent === undefined ? {} : { subagent }),
      replaceSessionLease,
      quiesce: delegates.quiesce,
      resume: delegates.resume,
      close,
    });
  } catch (error) {
    if (!runtimeAbort.signal.aborted) runtimeAbort.abort(error);
    delegates.clear();
    try { await subagent?.dispose(); } catch { /* preserve construction failure */ }
    try { await coordinator?.dispose(); } catch { /* preserve construction failure */ }
    if (lease !== undefined) {
      try { await input.leases.release(lease, input.clock.nowEpochMilliseconds(), new AbortController().signal); }
      catch { /* preserve construction failure */ }
    }
    throw error;
  }
}
