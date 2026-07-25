import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createMcpAdapter } from "@nklisch/pi-mcp-adapter/programmatic";

const pluginHostRoot = process.env.PLUGIN_HOST_ROOT;
if (!pluginHostRoot) throw new Error("PLUGIN_HOST_ROOT is required");
const contractUrl = pathToFileURL(resolve(
  pluginHostRoot,
  "test/contract/mcp-runtime.contract.ts",
)).href;
const { defineMcpRuntimeContract } = await import(contractUrl);

function ownerKey(identity: any): string {
  return JSON.stringify({ scope: identity.scope, plugin: identity.plugin });
}
function exactKey(identity: any): string {
  return JSON.stringify(identity);
}

function createHarness() {
  const packageRuntime: any = createMcpAdapter({ fileDiscovery: "disabled" }).runtime;
  const current = new Map<string, any>();
  const active = new Map<string, Set<any>>();
  let rejectNext = false;

  const runtime = {
    capabilities: (signal: AbortSignal) => packageRuntime.capabilities(signal),
    validateSource: (registration: any, signal: AbortSignal) => packageRuntime.validateSource(registration, signal),
    async replaceSource(request: any, signal: AbortSignal) {
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
      const result = await packageRuntime.replaceSource(request, signal);
      if (result.kind === "applied") {
        for (const execution of active.get(key) ?? []) execution.closed = true;
        active.delete(key);
        current.set(key, request);
      }
      return result;
    },
    async removeSource(identity: any, signal: AbortSignal) {
      const key = ownerKey(identity);
      const result = await packageRuntime.removeSource(identity, signal);
      if (result.kind === "removed") {
        for (const execution of active.get(key) ?? []) execution.closed = true;
        active.delete(key);
        current.delete(key);
      }
      return result;
    },
    inspectSource: (identity: any, signal: AbortSignal) => packageRuntime.inspectSource(identity, signal),
    inspectSources: (signal: AbortSignal) => packageRuntime.inspectSources(signal),
  };

  async function openExecution(identity: any, serverKey: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const key = ownerKey(identity);
    const request = current.get(key);
    if (!request || exactKey(request.registration.source.identity) !== exactKey(identity)) {
      throw new Error("source is not registered");
    }
    const server = request.registration.source.servers[serverKey];
    if (!server) throw new Error("server is not registered");
    const binding = {
      schemaVersion: 1,
      source: identity,
      serverKey,
      componentId: server.componentId,
      transport: server.transport,
    };
    let lease: any;
    let values: any;
    let failure: unknown;
    try {
      lease = await request.runtimeLeases.acquire(binding, signal);
      values = await request.launchValues.resolve(binding, signal);
      signal.throwIfAborted();
      if (values.transport !== server.transport) throw new Error("launch transport mismatch");
    } catch (error) {
      failure = signal.aborted ? signal.reason : error;
    } finally {
      if (values !== undefined) {
        try { await request.launchValues.dispose(values); }
        catch (error) { if (!failure) failure = error; }
      }
      if (failure && lease !== undefined) {
        try { await request.runtimeLeases.release(lease, new AbortController().signal); }
        catch (error) { if (!failure) failure = error; }
      }
    }
    if (failure) throw failure;
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
    if (!executions) active.set(key, executions = new Set());
    executions.add(execution);
    return execution;
  }

  return {
    runtime: runtime as any,
    async launch(identity: any, serverKey: string, signal: AbortSignal, consume?: (values: any) => unknown) {
      // The packed package's lifecycle owns storage/CAS/cleanup. This adapter
      // invokes the same provider contract for the host's transport-independent
      // execution checkpoint; package tests exercise the manager connect seam.
      const key = ownerKey(identity);
      const request = current.get(key);
      const originalResolve = request.launchValues.resolve;
      if (consume) {
        request.launchValues.resolve = async (...args: any[]) => {
          const values = await originalResolve.apply(request.launchValues, args);
          await consume(values);
          return values;
        };
      }
      try {
        const execution = await openExecution(identity, serverKey, signal);
        await execution.close();
      } finally {
        request.launchValues.resolve = originalResolve;
      }
    },
    openExecution,
    failNextReplacement() { rejectNext = true; },
  };
}

defineMcpRuntimeContract("packed @nklisch/pi-mcp-adapter", createHarness);
