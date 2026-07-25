import { createMcpAdapter } from "@nklisch/pi-mcp-adapter/programmatic";
import { defineMcpRuntimeContract } from "./mcp-runtime.contract.js";
import type {
  McpLaunchValues,
  McpRuntimePort,
  McpSourceIdentity,
  McpSourceReplaceRequest,
} from "../../src/application/ports/mcp-runtime.js";
import { createPiMcpRuntime } from "../../src/runtime/mcp/pi-mcp-adapter-runtime.js";

function ownerKey(identity: McpSourceIdentity): string {
  return JSON.stringify({ scope: identity.scope, plugin: identity.plugin });
}

function exactKey(identity: McpSourceIdentity): string {
  return JSON.stringify(identity);
}

/**
 * The unchanged portable contract owns transport-independent callback checks.
 * Package/Pi integration tests exercise the concrete manager and tool boundary.
 */
function createHarness() {
  const concrete = createPiMcpRuntime({ packageFactory: createMcpAdapter, initialSources: [], fileDiscovery: "disabled" });
  const current = new Map<string, McpSourceReplaceRequest>();
  const active = new Map<string, Set<{ closed: boolean }>>();
  let rejectNext = false;

  const runtime: McpRuntimePort = {
    capabilities: (signal) => concrete.runtime.capabilities(signal),
    validateSource: (registration, signal) => concrete.runtime.validateSource(registration, signal),
    async replaceSource(request, signal) {
      signal.throwIfAborted();
      if (rejectNext) {
        rejectNext = false;
        return {
          kind: "rejected",
          diagnostics: [{
            code: "ADAPTER_FAILED",
            severity: "error",
            operation: "replaceMcpSource",
            message: "MCP source operation was rejected",
            details: { sourceOperation: "replaceMcpSource" },
          }],
        };
      }
      const key = ownerKey(request.registration.source.identity);
      const result = await concrete.runtime.replaceSource(request, signal);
      if (result.kind === "applied") {
        for (const execution of active.get(key) ?? []) execution.closed = true;
        active.delete(key);
        current.set(key, request);
      }
      return result;
    },
    async removeSource(identity, signal) {
      const key = ownerKey(identity);
      const result = await concrete.runtime.removeSource(identity, signal);
      if (result.kind === "removed") {
        for (const execution of active.get(key) ?? []) execution.closed = true;
        active.delete(key);
        current.delete(key);
      }
      return result;
    },
    inspectSource: (identity, signal) => concrete.runtime.inspectSource(identity, signal),
    inspectSources: (signal) => concrete.runtime.inspectSources(signal),
  };

  async function openExecution(
    identity: McpSourceIdentity,
    serverKey: string,
    signal: AbortSignal,
    consume: (values: McpLaunchValues) => void | Promise<void> = () => undefined,
  ) {
    signal.throwIfAborted();
    const key = ownerKey(identity);
    const request = current.get(key);
    if (request === undefined || exactKey(request.registration.source.identity) !== exactKey(identity)) {
      throw new Error("source is not registered");
    }
    const server = request.registration.source.servers[serverKey];
    if (server === undefined) throw new Error("server is not registered");
    const binding = {
      schemaVersion: 1 as const,
      source: identity,
      serverKey: serverKey as never,
      componentId: server.componentId,
      transport: server.transport,
    };
    let lease: Awaited<ReturnType<typeof request.runtimeLeases.acquire>> | undefined;
    let values: McpLaunchValues | undefined;
    let failure: unknown;
    try {
      lease = await request.runtimeLeases.acquire(binding, signal);
      values = await request.launchValues.resolve(binding, signal);
      signal.throwIfAborted();
      if (values.transport !== server.transport) throw new Error("launch transport mismatch");
      await consume(values);
    } catch (error) {
      failure = signal.aborted ? signal.reason : error;
    } finally {
      if (values !== undefined) {
        try { await request.launchValues.dispose(values); }
        catch (error) { failure ??= error; }
      }
      if (failure !== undefined && lease !== undefined) {
        try { await request.runtimeLeases.release(lease, new AbortController().signal); }
        catch (error) { failure ??= error; }
      }
    }
    if (failure !== undefined) throw failure;
    if (lease === undefined) throw new Error("runtime lease was not acquired");

    const execution = {
      closed: false,
      async close(closeSignal = new AbortController().signal) {
        if (execution.closed) return;
        await request.runtimeLeases.release(lease, closeSignal);
        execution.closed = true;
        active.get(key)?.delete(execution);
      },
    };
    let executions = active.get(key);
    if (executions === undefined) active.set(key, executions = new Set());
    executions.add(execution);
    return execution;
  }

  return {
    runtime,
    async launch(
      identity: McpSourceIdentity,
      serverKey: string,
      signal: AbortSignal,
      consume?: (values: McpLaunchValues) => void | Promise<void>,
    ) {
      const execution = await openExecution(identity, serverKey, signal, consume);
      await execution.close();
    },
    openExecution,
    failNextReplacement() { rejectNext = true; },
  };
}

defineMcpRuntimeContract("published @nklisch/pi-mcp-adapter", createHarness);
