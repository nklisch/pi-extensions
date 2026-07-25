import { canonicalJson } from "../../domain/canonical-json.js";
import { McpServerComponentSchema } from "../../domain/components.js";
import { createPluginStoreIdentityFromEvidence } from "../../domain/content-store.js";
import { verifyInstalledRevisionRecord } from "../../domain/state/installed-state.js";
import type { Sha256 } from "../../domain/source.js";
import { createMcpLaunchTemplate } from "../../domain/mcp-launch-template.js";
import { verifyMcpSourceRegistration } from "../../application/mcp-source-registration.js";
import type { LifecycleClock } from "../../application/ports/lifecycle-clock.js";
import type { McpLaunchActiveSelectionPort } from "../../application/ports/mcp-launch-context.js";
import {
  McpRuntimeServerBindingSchemaV1,
  type McpRuntimeLease,
  type McpRuntimeLeaseProvider,
  type McpSourceRegistration,
} from "../../application/ports/mcp-runtime.js";
import type { RevisionLease } from "../../application/ports/revision-lease-store.js";
import type { RevisionLeaseStore } from "../../application/ports/revision-lease-store.js";
import { verifyProjectionExpectation } from "../../application/ports/runtime-projection.js";

const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

class McpRevisionLeaseError extends Error {
  constructor() {
    super("MCP runtime revision lease is unavailable");
    this.name = "McpRevisionLeaseError";
  }
}

type LeaseState = {
  lease: RevisionLease;
  released: boolean;
  releasing: Promise<void> | undefined;
};

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function createOpaqueToken(states: WeakMap<object, LeaseState>, state: LeaseState): McpRuntimeLease {
  const token = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperties(token, {
    toString: { value: () => "[REDACTED]" },
    toJSON: { value: () => "[REDACTED]" },
    [inspectSymbol]: { value: () => "[REDACTED]" },
  });
  states.set(token, state);
  return Object.freeze(token) as McpRuntimeLease;
}

/**
 * Adapt one immutable MCP registration to the existing revision-retention
 * lease store. Selection authority remains owned by native composition; this
 * provider only pins its already-selected plugin and projection artifacts.
 */
export function createMcpRevisionLeaseProvider(input: Readonly<{
  source: McpSourceRegistration;
  active: McpLaunchActiveSelectionPort;
  leases: RevisionLeaseStore;
  clock: LifecycleClock;
  sessionId: string;
  sha256: Sha256;
}>): McpRuntimeLeaseProvider {
  if (input === null || typeof input !== "object" ||
      input.active === undefined || input.leases === undefined || input.clock === undefined ||
      typeof input.sessionId !== "string" || input.sessionId.length === 0 ||
      typeof input.sha256 !== "function") {
    throw new TypeError("MCP revision lease provider dependencies are required");
  }
  const registration = verifyMcpSourceRegistration(input.source, input.sha256);
  const states = new WeakMap<object, LeaseState>();
  // A strong set is intentional: it preserves cleanup ownership even when an
  // acquire cannot transfer an opaque token to its caller.
  const outstanding = new Set<LeaseState>();

  async function releaseState(state: LeaseState, signal: AbortSignal): Promise<void> {
    if (state.released) return;
    if (state.releasing !== undefined) return state.releasing;
    const releasing = (async () => {
      try {
        signal.throwIfAborted();
        await input.leases.release(
          state.lease,
          input.clock.nowEpochMilliseconds(),
          signal,
        );
        state.released = true;
        outstanding.delete(state);
      } catch {
        throw new McpRevisionLeaseError();
      } finally {
        state.releasing = undefined;
      }
    })();
    state.releasing = releasing;
    return releasing;
  }

  async function acquire(
    bindingInput: Parameters<McpRuntimeLeaseProvider["acquire"]>[0],
    signal: AbortSignal,
  ): Promise<McpRuntimeLease> {
    signal.throwIfAborted();
    let binding: ReturnType<typeof McpRuntimeServerBindingSchemaV1.parse>;
    try {
      binding = McpRuntimeServerBindingSchemaV1.parse(bindingInput);
    } catch {
      throw new McpRevisionLeaseError();
    }
    const server = registration.source.servers[binding.serverKey];
    if (!sameJson(binding.source, registration.source.identity) || server === undefined ||
        server.componentId !== binding.componentId || server.transport !== binding.transport) {
      throw new McpRevisionLeaseError();
    }

    let acquiredState: LeaseState | undefined;
    try {
      await input.active.withSelection(binding, signal, async (selection) => {
        if (acquiredState !== undefined) throw new McpRevisionLeaseError();
        signal.throwIfAborted();
        const expectation = verifyProjectionExpectation(selection.expectation, input.sha256);
        if (expectation.kind !== "active") throw new McpRevisionLeaseError();
        const revision = verifyInstalledRevisionRecord({
          ...selection.revision,
          scope: binding.source.scope,
        }, input.sha256);
        const component = McpServerComponentSchema.parse(selection.component);
        const selected = expectation.projection.components.mcpServers.filter((candidate) =>
          candidate.id === binding.componentId);
        const template = createMcpLaunchTemplate(component, expectation.projection.plugin);
        const currentProject = selection.currentProject;
        if (!sameJson(expectation.projection.scope, binding.source.scope) ||
            expectation.projection.plugin !== binding.source.plugin ||
            expectation.projection.revision !== binding.source.revision ||
            expectation.projection.digest !== binding.source.projectionDigest ||
            revision.revision !== binding.source.revision ||
            revision.evidence.plugin.key !== binding.source.plugin ||
            revision.contentRef !== expectation.projection.contentRef ||
            revision.dataRef !== expectation.projection.dataRef ||
            revision.configurationRef !== expectation.projection.configurationRef ||
            selected.length !== 1 || !sameJson(selected[0], component) ||
            template.transport !== binding.transport ||
            !sameJson(server.projection, {
              schemaVersion: 1,
              componentId: component.id,
              contentRef: expectation.projection.contentRef,
              dataRef: expectation.projection.dataRef,
              ...(expectation.projection.configurationRef === undefined
                ? {}
                : { configurationRef: expectation.projection.configurationRef }),
            }) ||
            currentProject === undefined || currentProject.trust.kind !== "trusted" ||
            (binding.source.scope.kind === "project" &&
              currentProject.projectKey !== binding.source.scope.projectKey)) {
          throw new McpRevisionLeaseError();
        }
        const pluginStore = createPluginStoreIdentityFromEvidence({
          sourceHash: revision.evidence.source.sourceHash,
          binding: revision.revision,
        }, input.sha256);
        const lease = await input.leases.acquire({
          sessionId: input.sessionId,
          artifacts: [
            { kind: "plugin", key: pluginStore.key },
            { kind: "projection", reference: expectation.projectionRef },
          ],
          at: input.clock.nowEpochMilliseconds(),
        }, signal);
        acquiredState = { lease, released: false, releasing: undefined };
        outstanding.add(acquiredState);
      });
      signal.throwIfAborted();
      if (acquiredState === undefined) throw new McpRevisionLeaseError();
      return createOpaqueToken(states, acquiredState);
    } catch {
      if (acquiredState !== undefined) {
        try {
          await releaseState(acquiredState, new AbortController().signal);
        } catch {
          // The state stays in `outstanding`; runtime replacement/removal owns
          // the deterministic drain retry before it can report cleanup success.
        }
      }
      throw new McpRevisionLeaseError();
    }
  }

  async function release(lease: McpRuntimeLease, signal: AbortSignal): Promise<void> {
    const state = states.get(lease as object);
    if (state === undefined) throw new McpRevisionLeaseError();
    return releaseState(state, signal);
  }

  async function drain(signal: AbortSignal): Promise<void> {
    let failed = false;
    const pending = [...outstanding]
      .sort((left, right) => left.lease.leaseId.localeCompare(right.lease.leaseId));
    for (const state of pending) {
      try {
        await releaseState(state, signal);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new McpRevisionLeaseError();
  }

  return Object.freeze({ acquire, release, drain });
}
