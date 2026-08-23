import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHookFailureLog } from "../runtime/hooks/hook-failure-log.js";
import { VERSION as PI_VERSION, getAgentDir, type ExtensionCommandContext, type ExtensionContext, type SessionShutdownEvent, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { createCompatibilityService } from "../application/compatibility-service.js";
import { createMarketplaceInspectionService } from "../application/marketplace-inspection-service.js";
import { createMarketplacePluginProbe } from "../application/marketplace-plugin-probe.js";
import { createPluginLifecycleComposition } from "../application/plugin-lifecycle-service.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { hashContent } from "../domain/content-manifest.js";
import { verifyPluginConfigurationDocument } from "../domain/configured-values.js";
import { createTrustCandidate } from "../domain/trust-policy.js";
import { toScopeReference } from "../domain/state/scope.js";
import { createRuntimeProjectionCache } from "../infrastructure/filesystem/runtime-projection-cache.js";
import { createNodeLifecycleStateAdapters } from "../infrastructure/state/sqlite-lifecycle-state-store.js";
import { createSqlitePluginConfigurationStore } from "../infrastructure/configuration/sqlite-plugin-configuration-store.js";
import { createNodeConfigurationPathPort } from "../infrastructure/configuration/node-configuration-path.js";
import { createNodeHostIdentifiers } from "../infrastructure/node/node-identifiers.js";
import { createNodeLifecycleClock } from "../infrastructure/node/node-lifecycle-clock.js";
import { createNodeContentInfrastructure } from "../infrastructure/filesystem/create-content-store.js";
import { createNodeConvergenceService } from "../infrastructure/convergence/create-node-convergence.js";
import { createPendingDeleteMarkerStore } from "../infrastructure/cleanup/pending-data-deletion.js";
import { createPlatformSecretStore } from "../infrastructure/secrets/create-platform-secret-store.js";
import { createNodeMcpLaunchEnvironment } from "../infrastructure/environment/node-mcp-launch-environment.js";
import { createNodeHookExecutableResolver } from "../infrastructure/process/hook-executable-resolver.js";
import { createNodeCommandRunner } from "../infrastructure/process/command-runner.js";
import { createProcessRefreshClaimOwner } from "../infrastructure/process/refresh-claim-owner.js";
import { createNodeSourceMaterializers } from "../infrastructure/source/create-source-materializers.js";
import { networkEgressPolicyOptionsFromEnvironment } from "../infrastructure/network/network-egress-policy.js";
import { createManifestContentReader } from "../infrastructure/filesystem/manifest-content-reader.js";
import { readClaudeMarketplace } from "../formats/claude/marketplace-reader.js";
import { readCodexMarketplace } from "../formats/codex/marketplace-reader.js";
import { mergeMarketplaces } from "../formats/marketplace-merger.js";
import { createNodePluginInspector } from "./create-plugin-inspector.js";
import { createNodeMarketplaceDiscoveryComposition } from "./create-marketplace-discovery-services.js";
import { createCandidateContentLeasePort } from "./candidate-content-lease.js";
import { createNativeInspectionComposition } from "./create-native-inspection-service.js";
import { createComposedTrustedInstallationService } from "./create-trusted-installation-service.js";
import { createComposedNativeLifecycleOperationService } from "./create-native-lifecycle-operation-service.js";
import { createNodeProjectIntentFilePort } from "../infrastructure/project/node-project-intent-file.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../application/native-inspection-identifiers.js";
import { createHostConfigurationServices } from "./create-host-configuration.js";
import { createNodePiRuntimeCapabilityProbe } from "./node-pi-runtime-capability-probe.js";
import { createPublishedSubagentLifecyclePort } from "./create-subagent-lifecycle.js";
import { buildRuntimeDesiredState, type HostBlockedPlugin, type RuntimeDesiredState } from "./runtime-desired-state.js";
import { createRuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import { createAgentOrientationFactsCollector } from "./agent-orientation-facts.js";
import { createAgentOrientationPublisher, type AgentOrientationPublisher } from "../pi/agent-orientation-publisher.js";
import { assembleAgentOrientation, AgentOrientationUnavailableError } from "../application/agent-orientation.js";
import { createComposedSkillHookRuntime } from "./create-skill-hook-runtime.js";
import { createComposedMcpRuntime } from "./create-mcp-runtime.js";
import { createCompletePluginReloadPort } from "./complete-plugin-reload.js";
import { createInstalledTrustGrantService } from "../application/installed-trust-grant-service.js";
import { createExactTrustGrantService } from "../application/exact-trust-grant-service.js";
import { createPiProjectContextAdapters } from "../pi/pi-project-context.js";
import { createPiSessionBinding } from "../pi/pi-session-binding.js";
import { createPluginHostBootstrap, claimPackagedPluginHostComposition } from "../pi/plugin-host-bootstrap.js";
import { createPluginHostRuntimeDelegates } from "../pi/plugin-host-runtime-delegates.js";
import { createPiReloadBroker, type PiReloadTicket } from "../pi/pi-reload-broker.js";
import {
  PackagedPluginHostError,
  PackagedPluginHostErrorCode,
  type HostStartupResult,
  type PackagedPluginHost,
  type PackagedPluginHostApplication,
  type PackagedPluginHostOptions,
  type StartedPackagedPluginHost,
} from "./packaged-plugin-host-contract.js";
import { createPluginHostPathPlan } from "./plugin-host-paths.js";
import { qualifyRuntimeParticipants, type RuntimeQualificationStatus } from "./runtime-participant-qualification.js";
import { disposeSequentially } from "./sequential-cleanup.js";
import { createHostStatusService } from "./host-status-service.js";
import { createBackgroundUpdateCoordinator } from "./background-update-coordinator.js";
import { createNativeUpdateManagementComposition } from "./create-native-update-management-service.js";
import { createAutomaticUpdateLifecycleAdapter } from "./automatic-update-lifecycle-adapter.js";
import { createNativeControlService } from "./create-native-control-service.js";
import { createHostPrecedenceProvider, createHostPrecedenceService } from "../application/host-precedence-service.js";
import { createHookContextVisibilityProvider, createHookVisibilityService } from "../application/hook-visibility-service.js";
import { createNativeControlCurrentProjectPort } from "./create-native-control-current-project.js";
import { createNodeControlTimeoutPort } from "../infrastructure/node/node-control-timeout.js";
import type { NativePluginControlService } from "../application/native-control-service.js";
import type { SkillResourceDiscoveryPort } from "../runtime/skills/resource-discovery.js";
import type { SuccessorActivationReport } from "../application/ports/lifecycle-reload.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

async function readPiPluginsPackageVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Render a compact `A <- B <- C` description of thrown values and their cause chains. */
function describeErrorChain(errors: readonly unknown[]): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (value instanceof Error) {
      parts.push(value.message);
      if (value.cause !== undefined) visit(value.cause);
      return;
    }
    parts.push(String(value));
  };
  for (const error of errors) visit(error);
  return parts.join(" <- ");
}

type Cleanup = () => Promise<void>;
type PiApplicationOperationFrame = {
  readonly context: ExtensionContext;
  reloadContext: ExtensionContext | undefined;
};

export function startupResult(input: Readonly<{
  blocked: readonly HostBlockedPlugin[];
  reconcileReport?: SuccessorActivationReport;
  mcp: RuntimeQualificationStatus;
  subagents: RuntimeQualificationStatus;
  piReload: RuntimeQualificationStatus;
  secrets: "available" | "unavailable";
}>): HostStartupResult {
  const blocked = [...input.blocked, ...(input.reconcileReport?.degraded ?? [])];
  const uniqueBlocked = [...new Map(blocked.map((entry) => [
    JSON.stringify([entry.scope, entry.plugin, entry.selectedRevision, entry.runningRevision, entry.code]),
    entry,
  ])).values()];
  const secrets = input.secrets === "available"
    ? { status: "available" as const, explanation: "encrypted operating-system secret custody is available" }
    : { status: "unavailable" as const, explanation: "encrypted operating-system secret custody is unavailable" };
  return Object.freeze({
    status: uniqueBlocked.length === 0 ? "ready" : "degraded",
    blocked: Object.freeze(uniqueBlocked.map((entry) => Object.freeze({ ...entry }))),
    capabilities: Object.freeze({
      mcp: Object.freeze({ status: input.mcp.status, explanation: input.mcp.explanation }),
      subagents: Object.freeze({ status: input.subagents.status, explanation: input.subagents.explanation }),
      piReload: Object.freeze({ status: input.piReload.status, explanation: input.piReload.explanation }),
      secrets: Object.freeze(secrets),
    }),
  });
}

/** Construct the Pi package boundary. All filesystem/runtime work remains inside explicit start(). */
export function createPackagedPluginHost(options: PackagedPluginHostOptions): PackagedPluginHost {
  if (options === null || typeof options !== "object" || options.pi === undefined) {
    throw new PackagedPluginHostError(PackagedPluginHostErrorCode.invalidOptions, "packaged plugin host options are required");
  }
  const paths = createPluginHostPathPlan(options.agentDir ?? getAgentDir());
  const claim = claimPackagedPluginHostComposition(options.pi);
  const broker = createPiReloadBroker();
  const operationContexts = new AsyncLocalStorage<PiApplicationOperationFrame>();
  let bootstrap: ReturnType<typeof createPluginHostBootstrap>;
  let delegates: ReturnType<typeof createPluginHostRuntimeDelegates>;
  try {
    bootstrap = createPluginHostBootstrap(options.pi);
    delegates = createPluginHostRuntimeDelegates(options.pi);
  } catch (error) {
    claim.release();
    throw error;
  }
  let started: StartedPackagedPluginHost | undefined;
  let activeBinding: ReturnType<typeof createPiSessionBinding> | undefined;
  let startPromise: Promise<StartedPackagedPluginHost> | undefined;
  let reloadSuccessor: Readonly<{ ticket: PiReloadTicket; reload: ReturnType<typeof createCompletePluginReloadPort> }> | undefined;
  let terminal = false;
  let operationAdmission = true;
  let admittedOperations = 0;
  let operationDrain: Promise<void> | undefined;
  let resolveOperationDrain: (() => void) | undefined;
  let closeRuntime: (() => Promise<void>) | undefined;
  let closeApplication: (() => Promise<void>) | undefined;
  let runtimeShutdownPromise: Promise<void> | undefined;
  let finalClosePromise: Promise<void> | undefined;
  let sessionStartDispatch: Promise<void> | undefined;
  let sessionEndPromise: Promise<void> | undefined;
  let quiesceTrustedInstallation: (() => void) | undefined;
  let quiesceOperations: (() => void) | undefined;
  let quiesceControl: (() => void) | undefined;
  let activeResources: SkillResourceDiscoveryPort | undefined;
  let stopBackground: (() => Promise<void>) | undefined;
  let wakeBackground: (() => void) | undefined;
  let refreshOrientation: (() => Promise<void>) | undefined;
  let publishUnavailableOrientation: ((error: unknown, context: ExtensionContext) => Promise<void>) | undefined;
  let orientationPackageVersion = "unknown";
  let orientationBriefPaths: readonly string[] = [paths.orientationBrief({ kind: "user" })];
  let orientationPublisher: AgentOrientationPublisher | undefined;
  try {
    orientationPublisher = createAgentOrientationPublisher({ pi: options.pi });
  } catch {
    // Orientation is advisory. A host without the optional delivery method
    // still starts and retains every lifecycle capability.
  }

  async function start(_event: SessionStartEvent, context: ExtensionContext): Promise<StartedPackagedPluginHost> {
    if (terminal) throw new PackagedPluginHostError(PackagedPluginHostErrorCode.terminal, "packaged plugin host is terminal");
    if (started !== undefined) {
      activeBinding?.assertContext(context);
      return started;
    }
    if (startPromise !== undefined) {
      activeBinding?.assertContext(context);
      return startPromise;
    }
    startPromise = (async () => {
      const cleanup: Cleanup[] = [];
      let startupSuccessor: PiReloadTicket | undefined;
      const own = (dispose: Cleanup): void => { cleanup.push(dispose); };
      try {
        const binding = createPiSessionBinding(context);
        activeBinding = binding;
        orientationPackageVersion = await readPiPluginsPackageVersion();
        const startupSignal = new AbortController().signal;
        // The packaged host has one lifecycle package selection. Test fakes
        // exercise the package-neutral port below its composition boundary.
        const subagentLifecycle = await createPublishedSubagentLifecyclePort();
        const qualification = await qualifyRuntimeParticipants({
          pi: options.pi,
          nodeVersion: process.versions.node,
          piVersion: PI_VERSION,
          ...(options.runtime?.mcp === undefined ? {} : { mcp: options.runtime.mcp }),
          ...(options.runtime?.mcpUnavailable === undefined ? {} : { mcpUnavailable: options.runtime.mcpUnavailable }),
          ...(subagentLifecycle === undefined ? {} : { subagents: subagentLifecycle }),
          signal: startupSignal,
        });
        const successor = broker.claimSuccessor(binding.current());
        startupSuccessor = successor;
        claim.claimSession(binding.current().sessionId, successor?.id);
        own(async () => claim.releaseSession());
        delegates.bindSession(binding);
        own(async () => delegates.clear());

        const project = await createPiProjectContextAdapters({ binding, sha256, git: createNodeCommandRunner() });
        orientationBriefPaths = Object.freeze([
          paths.orientationBrief({ kind: "user" }),
          paths.orientationBrief(toScopeReference(project.scope)),
        ]);
        const state = await createNodeLifecycleStateAdapters({ paths, currentProject: project.scope, sha256 });
        own(() => state.close());
        // Host precedence is read through the state store at call time so a
        // preference change applies to the next inspection without restart.
        const hostPrecedence = createHostPrecedenceProvider(state.state);
        const hookVisibility = createHookContextVisibilityProvider(state.state);
        const configurations = await createSqlitePluginConfigurationStore({ root: paths.configurationRoot });
        own(async () => configurations[Symbol.asyncDispose]());
        const content = await createNodeContentInfrastructure({ hostRoot: paths.hostRoot });
        const manifestContentReader = createManifestContentReader(sha256);
        const secrets = await createPlatformSecretStore();
        own(() => secrets.close());
        const identifiers = createNodeHostIdentifiers();
        const refreshClaimOwners = createProcessRefreshClaimOwner();
        const clock = createNodeLifecycleClock();
        const configurationPaths = createNodeConfigurationPathPort({ binding, projectRoots: project.authority });
        const projectFiles = createNodeProjectIntentFilePort({ projectRoots: project.authority, sha256 });
        const configuration = createHostConfigurationServices({
          configurations,
          secrets: secrets.store,
          paths: configurationPaths,
          projectRoots: project.authority,
          projectTrust: project.trust,
          writeIds: identifiers.configurationWriteIds,
          sha256,
        });
        const executableResolver = createNodeHookExecutableResolver();
        const capabilityProbe = createNodePiRuntimeCapabilityProbe({
          executables: executableResolver,
          qualification,
        });
        // One immutable host-epoch capture is shared by compatibility,
        // desired-state reconstruction, and inspection. Inspection never
        // probes independently or observes a capability set unlike runtime.
        const capabilitySnapshot = await capabilityProbe.snapshot(startupSignal);
        const capabilities = Object.freeze({
          async snapshot(signal: AbortSignal) {
            signal.throwIfAborted();
            return capabilitySnapshot;
          },
        });
        const compatibility = createCompatibilityService(capabilities);
        const inspection = createNodePluginInspector({ hostPrecedence });
        const projections = createRuntimeProjectionCache({ content: content.content, sha256 });
        const selections = createRuntimeSelectionCatalog(project.current());
        own(() => selections.close());
        const skillHook = await createComposedSkillHookRuntime({
          pi: options.pi,
          binding,
          delegates,
          selection: selections,
          content,
          project,
          configuration: configuration.execution,
          hookVisibility,
          sha256,
          failureLog: createHookFailureLog({ file: join(paths.hostRoot, "logs", "hooks.jsonl") }),
          ...(qualification.subagents.lifecycle === undefined ? {} : { subagents: qualification.subagents.lifecycle }),
        });
        own(() => skillHook.close());
        const mcp = createComposedMcpRuntime({
          ...(qualification.mcp.runtime === undefined ? {} : { runtime: qualification.mcp.runtime }),
          selections,
          content: content.content,
          project,
          configuration: configuration.execution,
          environment: createNodeMcpLaunchEnvironment(),
          sha256,
        });
        own(() => mcp.close());
        let closeRuntimeResources: Promise<void> | undefined;
        closeRuntime = () => {
          closeRuntimeResources ??= (async () => {
            skillHook.quiesce();
            await disposeSequentially([() => mcp.close(), () => skillHook.close(), () => selections.close()], "packaged plugin runtime cleanup failed");
          })();
          return closeRuntimeResources;
        };
        let latestDesired: RuntimeDesiredState | undefined;
        const desired = Object.freeze({
          async load(signal: AbortSignal, overrides = []): Promise<RuntimeDesiredState> {
            latestDesired = await buildRuntimeDesiredState({
              installed: content.installed,
              compatibility,
              projections,
              project,
              ...(qualification.mcp.runtime === undefined ? {} : { mcp: qualification.mcp.runtime }),
              ...(qualification.mcp.status === "unavailable" && qualification.mcp.code !== undefined
                ? { mcpUnavailable: { code: qualification.mcp.code, explanation: qualification.mcp.explanation } }
                : {}),
              state: state.state,
              content: content.content,
              userBaseDirectory: binding.current().cwd,
              sha256,
              subagentRegistrationAvailable: skillHook.subagentRegistrationAvailable,
            }, signal, overrides);
            return latestDesired;
          },
        });
        const reload = createCompletePluginReloadPort({
          binding,
          operationContext: {
            takeReloadContext: () => {
              const frame = operationContexts.getStore();
              const context = frame?.reloadContext;
              if (frame !== undefined) frame.reloadContext = undefined;
              return context;
            },
          },
          broker,
          desired,
          selections,
          skillHook,
          mcp,
          markDraining: claim.markDraining,
          sha256,
        });
        const mutations = state.state;
        const hostPrecedenceConfig = createHostPrecedenceService({ state: state.state, mutations, sha256 });
        const hookVisibilityConfig = createHookVisibilityService({ state: state.state, mutations, sha256 });
        const sourceOptions = {
          ...(options.source ?? {}),
          networkPolicy: options.source?.networkPolicy ?? networkEgressPolicyOptionsFromEnvironment(process.env),
        };
        const materializers = createNodeSourceMaterializers(sourceOptions);
        const pendingDeletes = createPendingDeleteMarkerStore({ root: join(paths.hostRoot, "cleanup", "v1", "pending-deletes") });
        const lifecycleComposition = createPluginLifecycleComposition({
          state: state.state,
          content: content.content,
          materializer: materializers.plugins,
          inspector: inspection,
          compatibility,
          installed: content.installed,
          projections,
          reload,
          projectTrust: project.trust,
          projectRoots: project.authority,
          configurations,
          secrets: secrets.store,
          paths: configurationPaths,
          pendingDeletes,
          dataRemoval: content.dataRemoval,
          sha256,
        });
        const lifecycle = lifecycleComposition.application;
        const convergence = createNodeConvergenceService({
          state: state.state,
          inventory: state.inventory,
          hostRoot: paths.hostRoot,
          dataRemoval: content.dataRemoval,
          sha256,
          clock,
          projectionReferences: () => latestDesired === undefined ? undefined : new Set(latestDesired.selections.flatMap((selection) => selection.skillHook.prepared.expectation.kind === "active" ? [selection.skillHook.prepared.expectation.projectionRef.slice(selection.skillHook.prepared.expectation.projectionRef.lastIndexOf(":") + 1)] : [])),
        });
        const marketplaceInspection = createMarketplaceInspectionService({
          content: manifestContentReader,
          readers: { claude: readClaudeMarketplace, codex: readCodexMarketplace, merge: mergeMarketplaces },
          sha256,
          hostPrecedence,
        });
        const marketplaceProbe = createMarketplacePluginProbe({
          state: state.state,
          content: content.content,
          materializer: materializers.plugins,
          inspector: inspection,
          compatibility,
          sha256,
        });
        const marketplaceComposition = createNodeMarketplaceDiscoveryComposition({
          inventory: state.inventory,
          state: state.state,
          mutations,
          clock,
          claimIds: identifiers.refreshClaimIds,
          claimOwners: refreshClaimOwners,
          updateSchedulerLeaseIds: identifiers.updateSchedulerLeaseIds,
          materializers,
          inspection: marketplaceInspection,
          content: content.content,
          currentProject: project.scope,
          projectTrust: project.trust,
          revalidateCurrentProject: project.revalidate,
          sha256,
          probe: marketplaceProbe,
          lifecycle,
        });
        const marketplace = marketplaceComposition.application;

        const runtimeStartupBlocked: HostBlockedPlugin[] = [];
        let runtimeStartupReport: SuccessorActivationReport | undefined;
        const recordStartupReport = (report: SuccessorActivationReport): void => {
          // MCP apply failures are part of the successor report, not the
          // desired-state snapshot. Keep that report in startup visibility so
          // a plugin cannot look healthy merely because skills reconstructed.
          runtimeStartupReport = report;
        };
        if (successor === undefined) {
          try {
            recordStartupReport(await reload.reconcileCurrent(startupSignal));
          } catch (error) {
            if (startupSignal.aborted) throw error;
            runtimeStartupBlocked.push({
              plugin: "host-runtime",
              code: "RUNTIME_RECONSTRUCTION_FAILED",
              explanation: "local runtime reconstruction failed; read-only inspection remains available",
            });
          }
        } else {
          try {
            recordStartupReport(await reload.acceptSuccessor(successor, startupSignal));
            reloadSuccessor = Object.freeze({ ticket: successor, reload });
          } catch (error) {
            reload.failSuccessor(successor, error);
            runtimeStartupBlocked.push({
              plugin: "host-runtime",
              code: "RUNTIME_RECONSTRUCTION_FAILED",
              explanation: "reload successor reconstruction failed; convergence will retry on the next start",
            });
          }
        }
        const convergenceResult = await convergence.sweep({ scopes: [{ kind: "user" }, project.scope], signal: startupSignal });
        const unresolvedConvergence: HostBlockedPlugin[] = convergenceResult.results.filter((result) => result.kind !== "completed").map((result) => ({ plugin: result.plugin ?? "convergence", code: `CONVERGENCE_${result.code}`, explanation: "startup convergence retained work for a later pass" }));
        const runtimeBlocked = [...(latestDesired?.degraded ?? []), ...(runtimeStartupReport?.degraded ?? []), ...runtimeStartupBlocked];
        const startup = startupResult({
          blocked: [...(latestDesired?.degraded ?? []), ...unresolvedConvergence, ...runtimeStartupBlocked],
          ...(runtimeStartupReport === undefined ? {} : { reconcileReport: runtimeStartupReport }),
          mcp: qualification.mcp,
          subagents: qualification.subagents,
          piReload: qualification.hostApi,
          secrets: secrets.availability.status,
        });
        const hostStatus = createHostStatusService({
          startup,
          convergence: unresolvedConvergence.length === 0 ? "settled" : "degraded",
          runtime: runtimeBlocked.length === 0 ? "reconciled" : "degraded",
          schedulerStatus: marketplaceComposition.updates.schedulerStatus,
        });
        const orientationFacts = createAgentOrientationFactsCollector({
          paths,
          packageVersion: orientationPackageVersion,
          state: state.state,
          project,
          installed: content.installed,
          content: content.content,
          contentReader: manifestContentReader,
          selections,
          startup,
          latestDesired: () => latestDesired,
          sha256,
        });
        refreshOrientation = async (): Promise<void> => {
          if (orientationPublisher === undefined) return;
          const signal = new AbortController().signal;
          const collected = await orientationFacts.collect(signal);
          const orientation = assembleAgentOrientation(collected.input);
          // Recheck after pure assembly and immediately before the adapter
          // write. No lock is introduced; a later mutation is picked up by
          // the next admitted-operation refresh.
          if (!await orientationFacts.isCurrent(collected, signal)) return;
          await orientationPublisher.publish(orientation, collected.input.briefPath, context);
        };
        publishUnavailableOrientation = async (error: unknown, unavailableContext: ExtensionContext): Promise<void> => {
          if (orientationPublisher === undefined) return;
          const code = error instanceof AgentOrientationUnavailableError
            ? error.code
            : "ORIENTATION_STATE_UNAVAILABLE";
          for (const briefPath of orientationBriefPaths) {
            await orientationPublisher.publishUnavailable({
              briefPath,
              code,
              packageVersion: orientationPackageVersion,
              sha256,
              context: unavailableContext,
            });
          }
        };
        const candidateContent = createCandidateContentLeasePort({ content: content.content, materializer: materializers.plugins });
        const nativeInspection = createNativeInspectionComposition({
          state: state.state,
          scopes: [{ kind: "user" }, project.scope],
          revalidateProject: project.revalidate,
          selections,
          desired: () => latestDesired,
          skillHook: skillHook.participant,
          mcp: mcp.participant,
          capabilities: capabilitySnapshot,
          convergence: convergenceResult,
          startup,
          status: hostStatus,
          configurations,
          projectTrust: project.trust,
          secretCustody: startup.capabilities.secrets,
          installed: content.installed,
          candidateContent,
          bundleInspector: inspection,
          marketplace: marketplaceComposition.inspection,
          clock,
          sha256,
        });
        const automaticLifecycle = createAutomaticUpdateLifecycleAdapter({
          state: state.state,
          catalog: marketplaceComposition.inspection.catalog,
          inspection: nativeInspection.application,
          evidence: nativeInspection.evidence,
          lifecycle,
          projectTrust: project.trust,
          projectRoots: project.authority,
          currentProject: project.scope,
          userBaseDirectory: binding.current().cwd,
          sha256,
        });
        const updates = createNativeUpdateManagementComposition({
          state: state.state,
          inventory: state.inventory,
          mutations,
          clock,
          sha256,
          scheduler: marketplaceComposition.updates.scheduler,
          schedulerStatus: marketplaceComposition.updates.schedulerStatus,
          lifecycle: automaticLifecycle,
          installed: content.installed,
          currentProject: project.scope,
          projectTrust: project.trust,
          revalidateCurrentProject: project.revalidate,
          ...(options.update?.publisher === undefined ? {} : { publisher: options.update.publisher }),
          onCounts: (counts) => hostStatus.update(counts),
        });
        const hostEpochId = await identifiers.operationIds.create(startupSignal);
        const hostEpoch = hashContent(new TextEncoder().encode(`native-operation-host-epoch-v1\0${hostEpochId}`), sha256);
        const operations = createComposedNativeLifecycleOperationService({
          catalog: marketplaceComposition.inspection.catalog,
          candidateContent,
          inspector: inspection,
          readiness: nativeInspection.readiness,
          async syncReadiness(snapshot, signal) {
            const captured = await nativeInspection.evidence.capture(signal);
            const state = captured.states.find((result) => result.ok && result.snapshot.scope.kind === "project" && result.snapshot.scope.projectKey === snapshot.scope.projectKey);
            const capabilityDigest = captured.binding.capability.digest;
            if (state === undefined || !state.ok || state.snapshot.generation !== snapshot.generation || capabilityDigest === undefined) throw new Error("project inspection evidence changed during sync preview");
            const snapshotId = deriveInspectionEvidenceSnapshotId(captured.binding, sha256);
            const values = [];
            for (const record of snapshot.project.plugins) {
              const detailId = deriveInspectionDetailId({ version: 1, subject: "installed", scope: { kind: "project", projectKey: snapshot.scope.projectKey }, plugin: record.plugin, selectedRevision: record.selectedRevision }, sha256);
              const detail = await nativeInspection.application.detail({ snapshotId, detailId }, signal);
              const selected = record.revisions.find((revision) => revision.revision === record.selectedRevision);
              if (detail.kind !== "found" || selected === undefined) throw new Error("project plugin readiness is unavailable");
              const loaded = await content.installed.load({ scope: snapshot.scope, revision: selected }, signal);
              const trustCandidate = createTrustCandidate({
                scope: toScopeReference(snapshot.scope),
                marketplaceSource: loaded.marketplaceSource,
                plugin: loaded.plugin,
                compatibility: loaded.compatibility,
                content: loaded.content,
                materializationBinding: loaded.binding,
              }, sha256);
              const trustFingerprint = hashContent(new TextEncoder().encode(`project-sync-trust-v1\0${trustCandidate.subject}`), sha256);
              let configurationRevision: import("../domain/content-manifest.js").ContentDigest | null = null;
              if (selected.configurationRef !== undefined) {
                const read = await configurations.read(selected.configurationRef, signal);
                if (read.kind === "found") {
                  try {
                    const document = verifyPluginConfigurationDocument(read.document, loaded.plugin.configuration, sha256);
                    if (document.plugin === record.plugin && document.configurationRef === selected.configurationRef) configurationRevision = document.revision;
                  } catch { /* exact invalid configuration remains a missing readiness prerequisite */ }
                }
              }
              const configurationReady = !detail.detail.configuration.some((field) => field.state === "invalid" || field.required && (field.state === "missing" || field.state === "unavailable"));
              values.push({
                plugin: record.plugin,
                trust: detail.detail.trust === "authorized" ? "ready" as const : "missing" as const,
                trustFingerprint,
                configuration: configurationReady && (selected.configurationRef === undefined || configurationRevision !== null) ? "ready" as const : "missing" as const,
                configurationRevision,
              });
            }
            return Object.freeze({
              capabilityDigest,
              projectTrustFingerprint: hashContent(new TextEncoder().encode(`project-sync-project-trust-v1\0${canonicalJson(captured.binding.currentProject)}`), sha256),
              plugins: Object.freeze(values),
            });
          },
          evidence: nativeInspection.evidence,
          configuration: configuration.application,
          configurations,
          configurationPaths,
          secretCustody: startup.capabilities.secrets,
          userBaseDirectory: binding.current().cwd,
          state: state.state,
          mutations,
          projectTrust: project.trust,
          projectRoots: project.authority,
          projectFiles,
          projectWriteIds: identifiers.projectIntentWriteIds,
          registrations: marketplaceComposition.application.registration,
          lifecycle: lifecycleComposition,
          clock,
          sessionIds: identifiers.operationIds,
          hostEpoch,
          sha256,
        });
        quiesceOperations = operations.quiesce;
        own(() => operations.close());
        const trustedInstallation = createComposedTrustedInstallationService({
          catalog: marketplaceComposition.inspection.catalog,
          candidateContent,
          candidate: operations.candidate,
          inspector: inspection,
          readiness: nativeInspection.readiness,
          evidence: nativeInspection.evidence,
          configuration: configuration.application,
          configurations,
          configurationPaths,
          secretCustody: startup.capabilities.secrets,
          userBaseDirectory: binding.current().cwd,
          state: state.state,
          mutations,
          projectTrust: project.trust,
          projectRoots: project.authority,
          lifecycle: lifecycleComposition,
          clock,
          sessionIds: identifiers.operationIds,
          hostEpoch,
          sha256,
        });
        quiesceTrustedInstallation = trustedInstallation.quiesce;
        own(() => trustedInstallation.close());
        const requireOperationContext = <Args extends unknown[], Result>(
          operation: (...args: Args) => Result,
        ) => (...args: Args): Result => {
          if (operationContexts.getStore() === undefined) throw new PackagedPluginHostError(PackagedPluginHostErrorCode.reloadContextUnavailable, "native operation requires a Pi operation context");
          return operation(...args);
        };
        const operationApplication = Object.freeze({
          preview: requireOperationContext(operations.application.preview),
          apply: requireOperationContext(operations.application.apply),
          run: requireOperationContext(operations.application.run),
          status: requireOperationContext(operations.application.status),
          cancel: requireOperationContext(operations.application.cancel),
        });
        const background = createBackgroundUpdateCoordinator({
          convergence: { sweep: async (signal) => { await convergence.sweep({ scopes: [{ kind: "user" }, project.scope], signal }); } },
          scheduler: marketplaceComposition.updates.scheduler,
          schedulerStatus: marketplaceComposition.updates.schedulerStatus,
          notifications: updates.notifications,
          automatic: updates.automatic,
          status: hostStatus,
        });
        stopBackground = background.close;
        wakeBackground = background.wake;
        own(() => background.close());
        const applyPolicyAndWake: typeof updates.application.applyPolicy = async (request, signal) => {
          const result = await updates.application.applyPolicy(request, signal);
          if (result.kind === "changed") background.wake();
          return result;
        };
        const addMarketplaceAndWake: typeof marketplace.registration.add = async (request, signal) => {
          const result = await marketplace.registration.add(request, signal);
          if (result.kind === "added" || result.kind === "unchanged") background.wake();
          return result;
        };
        const importMarketplaceAndWake: typeof marketplace.adoption.import = async (request, signal) => {
          const result = await marketplace.adoption.import(request, signal);
          if (result.outcomes.some((outcome) => outcome.outcome.kind === "added" || outcome.outcome.kind === "unchanged")) background.wake();
          return result;
        };
        const updateApplication = Object.freeze({
          previewPolicy: requireOperationContext(updates.application.previewPolicy),
          applyPolicy: requireOperationContext(applyPolicyAndWake),
          status: requireOperationContext(updates.application.status),
          notifications: requireOperationContext(updates.application.notifications),
          acknowledge: requireOperationContext(updates.application.acknowledge),
          runAutomatic: requireOperationContext(updates.application.runAutomatic),
        });
        const installedTrustGrant = createInstalledTrustGrantService({
          state: state.state,
          installed: content.installed,
          compatibility,
          trust: createExactTrustGrantService({ state: state.state, mutations, projectTrust: project.trust, projectRoots: project.authority, sha256 }),
          projectRoots: project.authority,
          projectScope: project.scope,
          sha256,
        });
        const refreshAndWake: typeof marketplace.refresh.refresh = async (request, signal) => {
          const result = await marketplace.refresh.refresh(request, signal);
          background.wake();
          return result;
        };
        const publicMarketplace = Object.freeze({
          registration: Object.freeze({ ...marketplace.registration, add: addMarketplaceAndWake }),
          refresh: Object.freeze({ ...marketplace.refresh, refresh: refreshAndWake }),
          catalog: marketplace.catalog,
          adoption: Object.freeze({ ...marketplace.adoption, import: importMarketplaceAndWake }),
        });
        const controlLifetime = createNativeControlService({
          applications: {
            marketplace: publicMarketplace,
            inspection: nativeInspection.application,
            trustedInstallation: trustedInstallation.application,
            operations: operationApplication,
            trustGrant: Object.freeze({ grant: requireOperationContext(installedTrustGrant.grant) }),
            updates: updateApplication,
            config: Object.freeze({ hostPrecedence: hostPrecedenceConfig, hookVisibility: hookVisibilityConfig }),
            status: hostStatus,
            currentProject: createNativeControlCurrentProjectPort({
              scope: project.scope,
              current: project.current,
              revalidate: project.revalidate,
              trust: project.trust,
            }),
          },
          ids: identifiers.controlExecutionIds,
          timeouts: createNodeControlTimeoutPort(),
        });
        quiesceControl = controlLifetime.quiesce;
        own(() => controlLifetime.close());
        const requireControlContext = <Args extends unknown[], Result>(operation: (...args: Args) => Result) => (...args: Args): Result => {
          if (operationContexts.getStore() === undefined) throw new PackagedPluginHostError(PackagedPluginHostErrorCode.reloadContextUnavailable, "native control execution requires a Pi operation context");
          return operation(...args);
        };
        const control: NativePluginControlService = Object.freeze({
          grammarVersion: controlLifetime.grammarVersion,
          parseArgv: controlLifetime.parseArgv,
          parseText: controlLifetime.parseText,
          help: controlLifetime.help,
          complete: controlLifetime.complete,
          execute: requireControlContext(controlLifetime.execute),
          runArgv: requireControlContext(controlLifetime.runArgv),
          runText: requireControlContext(controlLifetime.runText),
          poll: requireControlContext(controlLifetime.poll),
          cancel: requireControlContext(controlLifetime.cancel),
        });
        activeResources = skillHook.resources;
        const application: PackagedPluginHostApplication = Object.freeze({ control });
        let applicationClosePromise: Promise<void> | undefined;
        closeApplication = () => {
          applicationClosePromise ??= (async () => {
            try { await disposeSequentially([...cleanup].reverse(), "packaged plugin host cleanup failed"); }
            finally { cleanup.length = 0; }
          })();
          return applicationClosePromise;
        };
        const value: StartedPackagedPluginHost = Object.freeze({
          application,
          startup,
          close: () => dispose("quit"),
        });
        started = value;
        // Background maintenance is detached: session_start returns from local
        // convergence even if a remote adapter or publisher hangs.
        void background.start();
        return value;
      } catch (error) {
        terminal = true;
        if (startupSuccessor !== undefined) {
          try { broker.fail(startupSuccessor, error); } catch { /* preserve startup failure */ }
        }
        const errors: unknown[] = [error];
        for (const dispose of [...cleanup].reverse()) {
          try { await dispose(); } catch (cleanupError) { errors.push(cleanupError); }
        }
        // Host surfaces (Pi extension runner) print only Error.message, so the
        // cause chain must be inlined or the real startup reason is invisible.
        if (errors.length > 1) throw new AggregateError(errors, `packaged plugin host startup failed: ${describeErrorChain(errors)}`);
        throw new PackagedPluginHostError(PackagedPluginHostErrorCode.startupFailed, `packaged plugin host startup failed: ${describeErrorChain([error])}`, error);
      }
    })();
    return startPromise;
  }

  function waitForOperations(): Promise<void> {
    if (admittedOperations === 0) return Promise.resolve();
    operationDrain ??= new Promise<void>((resolve) => { resolveOperationDrain = resolve; });
    return operationDrain;
  }

  function ensureFinalClose(): Promise<void> {
    finalClosePromise ??= (async () => {
      try {
        await waitForOperations();
        if (closeApplication !== undefined) await closeApplication();
        else if (startPromise !== undefined) await startPromise.then(() => closeApplication?.(), () => undefined);
      } finally {
        activeBinding = undefined;
        activeResources = undefined;
        orientationBriefPaths = [paths.orientationBrief({ kind: "user" })];
        refreshOrientation = undefined;
        publishUnavailableOrientation = undefined;
        if (reloadSuccessor !== undefined) {
          try { reloadSuccessor.reload.failSuccessor(reloadSuccessor.ticket); } catch { /* ticket may already be settled */ }
          reloadSuccessor = undefined;
        }
        bootstrap.clear(target);
        delegates.clear();
        claim.release();
      }
    })();
    return finalClosePromise;
  }

  async function beginSessionShutdown(
    event?: SessionShutdownEvent,
    context?: ExtensionContext,
    reason: SessionShutdownEvent["reason"] = event?.reason ?? "quit",
  ): Promise<void> {
    terminal = true;
    operationAdmission = false;
    quiesceControl?.();
    quiesceTrustedInstallation?.();
    quiesceOperations?.();
    await stopBackground?.();
    // A reload operation cannot wait for itself from predecessor shutdown;
    // every other shutdown drains admitted foreground work before closing the
    // runtime and durable adapters those operations may still need.
    if (reason !== "reload") await waitForOperations();
    started = undefined;
    if (event !== undefined && context !== undefined) {
      sessionEndPromise ??= delegates.dispatchSessionEnd(event, context);
      await sessionEndPromise;
    }
    delegates.quiesce();
    runtimeShutdownPromise ??= closeRuntime?.() ?? Promise.resolve();
    try {
      await runtimeShutdownPromise;
    } finally {
      // Do not await durable cleanup here: ctx.reload() cannot start the
      // successor while Pi is blocked in predecessor session_shutdown.
      void ensureFinalClose().catch(() => undefined);
    }
  }

  async function dispose(reason: SessionShutdownEvent["reason"]): Promise<void> {
    await beginSessionShutdown(undefined, undefined, reason);
    await ensureFinalClose();
  }

  const host: PackagedPluginHost = {
    start,
    current: () => started,
    async runWithPiOperationContext<T>(
      context: ExtensionContext,
      signal: AbortSignal,
      use: (application: PackagedPluginHostApplication) => Promise<T>,
    ): Promise<T> {
      signal.throwIfAborted();
      const current = started;
      if (!operationAdmission || current === undefined) throw new PackagedPluginHostError(PackagedPluginHostErrorCode.terminal, "packaged plugin host is not started");
      activeBinding?.assertContext(context);
      admittedOperations += 1;
      const frame: PiApplicationOperationFrame = { context, reloadContext: context };
      try {
        return await operationContexts.run(frame, () => use(current.application));
      } finally {
        // A committed foreground mutation is the completion boundary for the
        // derived brief. The refresh is advisory, but awaiting it ensures a
        // successful operation does not return before its orientation write is
        // attempted. State-generation checks make read-only operations cheap.
        await refreshOrientation?.().catch(() => undefined);
        // Lifecycle/local operations may settle installed state and notices.
        // Wake the one owner without coupling the foreground result to it.
        wakeBackground?.();
        admittedOperations -= 1;
        if (admittedOperations === 0) {
          resolveOperationDrain?.();
          resolveOperationDrain = undefined;
          operationDrain = undefined;
        }
      }
    },
    dispose,
  };
  const target = Object.freeze({
    async sessionStart(event: SessionStartEvent, context: ExtensionContext): Promise<void> {
      try {
        await start(event, context);
      } catch (error) {
        // Startup failure must not strand an old brief. Replace it with an
        // honest marker, then preserve the host's existing startup error.
        try {
          if (orientationPublisher !== undefined) {
            for (const briefPath of orientationBriefPaths) {
              await orientationPublisher.publishUnavailable({
                briefPath,
                code: error instanceof AgentOrientationUnavailableError ? error.code : "ORIENTATION_STATE_UNAVAILABLE",
                packageVersion: orientationPackageVersion,
                sha256,
                context,
              });
            }
          }
        } catch {
          // Orientation cannot turn a host startup failure into a second error.
        }
        throw error;
      }
      try {
        await refreshOrientation?.();
      } catch (error) {
        try { await publishUnavailableOrientation?.(error, context); } catch { /* informational surface only */ }
      }
      sessionStartDispatch ??= delegates.dispatchSessionStart(event, context);
      await sessionStartDispatch;
    },
    async resourcesDiscover(_event: Readonly<{ type: "resources_discover"; cwd: string; reason: "startup" | "reload" }>, context: ExtensionContext) {
      const current = started;
      if (current === undefined) return;
      activeBinding?.assertContext(context);
      const resources = activeResources as { discover(request: Readonly<{ reason: "startup" | "reload"; projectTrusted: boolean }>, signal: AbortSignal): Promise<Readonly<{ kind: string; skillPaths?: readonly string[] }>> };
      const result = await resources.discover({ reason: _event.reason, projectTrusted: activeBinding?.isProjectTrusted() === true }, new AbortController().signal);
      if (result.kind === "ready" && reloadSuccessor !== undefined) {
        const successor = reloadSuccessor;
        try {
          successor.reload.publishSuccessor(successor.ticket);
        } catch (error) {
          try { successor.reload.failSuccessor(successor.ticket, error); } catch { /* broker may already be settled */ }
        } finally {
          reloadSuccessor = undefined;
        }
      } else if (result.kind !== "ready" && reloadSuccessor !== undefined) {
        const successor = reloadSuccessor;
        try { successor.reload.failSuccessor(successor.ticket, new Error("Pi reload resource publication failed")); } catch { /* broker may already be settled */ }
        reloadSuccessor = undefined;
      }
      return result.kind === "ready" ? { skillPaths: [...(result.skillPaths ?? [])] } : undefined;
    },
    async sessionShutdown(event: SessionShutdownEvent, context: ExtensionContext): Promise<void> {
      activeBinding?.assertContext(context);
      await beginSessionShutdown(event, context);
    },
  });
  bootstrap.activate(target);
  return Object.freeze(host);
}
