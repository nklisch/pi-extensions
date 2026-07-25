import type { ContentStorePort } from "../application/ports/content-store.js";
import type { LifecycleClock } from "../application/ports/lifecycle-clock.js";
import type { McpLaunchEnvironmentPort } from "../application/ports/mcp-launch-environment.js";
import type { McpRuntimePort } from "../application/ports/mcp-runtime.js";
import type { RevisionLeaseStore } from "../application/ports/revision-lease-store.js";
import { createMcpLaunchContextPort } from "../application/mcp-launch-context.js";
import { createInactiveProjectionExpectation } from "../application/ports/runtime-projection.js";
import type { Sha256 } from "../domain/source.js";
import type { PiProjectContextAdapters } from "../pi/pi-project-context.js";
import { createTrustedMcpLaunchValueProvider } from "../runtime/mcp/launch-value-provider.js";
import { createVerifiedPiMcpRuntimeCandidate } from "../runtime/mcp/pi-mcp-adapter-package.js";
import type { PiMcpRuntimeAdapter } from "../runtime/mcp/pi-mcp-adapter-runtime.js";
import {
  createMcpLifecycleParticipant,
  type McpLifecycleParticipant,
  type McpLifecycleReconcileResult,
  type McpLifecycleState,
  type McpLifecycleTransitionRequest,
} from "../runtime/mcp/lifecycle-participant.js";
import { createMcpRevisionLeaseProvider } from "../runtime/mcp/revision-lease-provider.js";
import type { HostConfigurationDependencies } from "./create-host-configuration.js";
import type { RuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import { disposeSequentially } from "./sequential-cleanup.js";

export type ComposedMcpRuntime = Readonly<{
  participant: McpLifecycleParticipant;
  reconcileAll(
    transitions: readonly Readonly<{ from: McpLifecycleState; to: McpLifecycleState }>[],
    signal: AbortSignal,
  ): Promise<readonly McpLifecycleReconcileResult[]>;
  close(): Promise<void>;
}>;

/**
 * Select the exact published candidate at the outer composition boundary.
 * Central runtime qualification remains the single authority that can admit it;
 * an empty initial set preserves full-bundle reconciliation as source authority.
 */
export function createProductionMcpRuntimeCandidate(): Promise<PiMcpRuntimeAdapter | undefined> {
  return createVerifiedPiMcpRuntimeCandidate();
}

function stateKey(state: McpLifecycleState): string {
  const owner = state.kind === "inactive"
    ? { scope: state.expectation.scope, plugin: state.expectation.plugin }
    : { scope: state.expectation.projection.scope, plugin: state.expectation.projection.plugin };
  return JSON.stringify(owner);
}

export function createComposedMcpRuntime(input: Readonly<{
  runtime?: McpRuntimePort;
  selections: RuntimeSelectionCatalog;
  content: ContentStorePort;
  project: PiProjectContextAdapters;
  configuration: HostConfigurationDependencies;
  environment: McpLaunchEnvironmentPort;
  leases: RevisionLeaseStore;
  clock: LifecycleClock;
  sessionId: string;
  sha256: Sha256;
}>): ComposedMcpRuntime {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function" ||
      typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    throw new TypeError("MCP runtime composition dependencies are required");
  }
  const context = createMcpLaunchContextPort({
    active: input.selections,
    content: input.content,
    projectRoots: input.project.authority,
    projectTrust: input.project.trust,
    configuration: input.configuration,
    sha256: input.sha256,
  });
  const leaseProviders = new Set<ReturnType<typeof createMcpRevisionLeaseProvider>>();
  const participant = createMcpLifecycleParticipant({
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    launchValues(registration) {
      return createTrustedMcpLaunchValueProvider({
        source: registration.source,
        context,
        environment: input.environment,
        platform: process.platform === "win32" ? "windows" : "posix",
      });
    },
    runtimeLeases(registration) {
      const provider = createMcpRevisionLeaseProvider({
        source: registration,
        active: input.selections,
        leases: input.leases,
        clock: input.clock,
        sessionId: input.sessionId,
        sha256: input.sha256,
      });
      leaseProviders.add(provider);
      return provider;
    },
    sha256: input.sha256,
  });
  const owned = new Map<string, McpLifecycleState>();
  let closePromise: Promise<void> | undefined;

  async function reconcileAll(
    transitions: readonly Readonly<{ from: McpLifecycleState; to: McpLifecycleState }>[],
    signal: AbortSignal,
  ): Promise<readonly McpLifecycleReconcileResult[]> {
    const results: McpLifecycleReconcileResult[] = [];
    for (const transition of transitions) {
      signal.throwIfAborted();
      const request: McpLifecycleTransitionRequest = {
        ...transition,
        currentProject: input.project.current(),
      };
      const result = await participant.reconcile(request, signal);
      results.push(result);
      if (result.kind === "applied" || result.kind === "unchanged") {
        const key = stateKey(transition.to);
        if (transition.to.kind === "source") owned.set(key, transition.to);
        else owned.delete(key);
      }
    }
    return Object.freeze(results);
  }

  async function close(): Promise<void> {
    closePromise ??= (async () => {
      function* cleanupDisposers() {
        for (const state of [...owned.values()].reverse()) {
          if (state.kind !== "source") continue;
          const inactive: McpLifecycleState = {
            kind: "inactive",
            expectation: createInactiveProjectionExpectation({
              scope: state.expectation.projection.scope,
              plugin: state.expectation.projection.plugin,
              sha256: input.sha256,
            }),
          };
          yield async () => {
            const result = await participant.reconcile({
              from: state,
              to: inactive,
              currentProject: input.project.current(),
            }, new AbortController().signal);
            if (result.kind !== "applied" && result.kind !== "unchanged") throw new Error("MCP source cleanup remains ambiguous");
            owned.delete(stateKey(state));
          };
        }
        for (const provider of leaseProviders) yield () => provider.drain(new AbortController().signal);
      }
      try { await disposeSequentially(cleanupDisposers(), "MCP runtime cleanup failed"); }
      finally { leaseProviders.clear(); }
    })();
    return closePromise;
  }

  return Object.freeze({ participant, reconcileAll, close });
}
