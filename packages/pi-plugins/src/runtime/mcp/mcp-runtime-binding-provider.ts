import { canonicalJson } from "../../domain/canonical-json.js";
import { verifyMcpSourceRegistration } from "../../application/mcp-source-registration.js";
import { McpRuntimeServerBindingSchemaV1, type McpRuntimeLease, type McpRuntimeLeaseProvider, type McpSourceRegistration } from "../../application/ports/mcp-runtime.js";
import type { McpLaunchActiveSelectionPort } from "../../application/ports/mcp-launch-context.js";
import { verifyProjectionExpectation } from "../../application/ports/runtime-projection.js";
import type { Sha256 } from "../../domain/source.js";

const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");
class McpRuntimeBindingError extends Error { constructor() { super("MCP runtime binding is unavailable"); this.name = "McpRuntimeBindingError"; } }
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function token(): McpRuntimeLease {
  const value = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperties(value, { toString: { value: () => "[REDACTED]" }, toJSON: { value: () => "[REDACTED]" }, [inspectSymbol]: { value: () => "[REDACTED]" } });
  return Object.freeze(value) as McpRuntimeLease;
}

/** Launch-time binding validation only; no durable artifact pinning is used. */
export function createMcpRuntimeBindingProvider(input: Readonly<{
  source: McpSourceRegistration;
  active: McpLaunchActiveSelectionPort;
  sessionId?: string;
  sha256: Sha256;
  leases?: unknown;
  clock?: unknown;
}>): McpRuntimeLeaseProvider {
  if (input === null || typeof input !== "object" || input.active === undefined || typeof input.sha256 !== "function") throw new TypeError("MCP runtime binding dependencies are required");
  const registration = verifyMcpSourceRegistration(input.source, input.sha256);
  const outstanding = new WeakSet<object>();
  async function acquire(bindingInput: Parameters<McpRuntimeLeaseProvider["acquire"]>[0], signal: AbortSignal): Promise<McpRuntimeLease> {
    signal.throwIfAborted();
    const binding = McpRuntimeServerBindingSchemaV1.parse(bindingInput);
    const server = registration.source.servers[binding.serverKey];
    if (server === undefined || !same(binding.source, registration.source.identity) || server.componentId !== binding.componentId || server.transport !== binding.transport) throw new McpRuntimeBindingError();
    let valid = false;
    await input.active.withSelection(binding, signal, async (selection) => {
      const expectation = verifyProjectionExpectation(selection.expectation, input.sha256);
      valid = expectation.kind === "active" && same(expectation.projection.scope, binding.source.scope) && expectation.projection.plugin === binding.source.plugin && expectation.projection.revision === binding.source.revision && expectation.projection.digest === binding.source.projectionDigest && selection.currentProject?.trust.kind === "trusted";
    });
    if (!valid) throw new McpRuntimeBindingError();
    const value = token(); outstanding.add(value as object); return value;
  }
  async function release(lease: McpRuntimeLease, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); if (!outstanding.has(lease as object)) throw new McpRuntimeBindingError(); }
  async function drain(_signal: AbortSignal): Promise<void> { /* tokens are session-local and need no durable cleanup */ }
  return Object.freeze({ acquire, release, drain });
}
