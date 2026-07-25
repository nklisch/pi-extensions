import {
  McpRuntimeCapabilitiesSchemaV1,
  type McpRuntimeCapabilities,
} from "./ports/mcp-runtime.js";
import type { McpRuntimePort } from "./ports/mcp-runtime.js";
import type { RuntimeCapabilityProbe } from "./ports/runtime-capability-probe.js";
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
  type RuntimeCapabilityAvailability,
  type RuntimeCapabilitySnapshot,
} from "../domain/compatibility-policy.js";
import { BoundaryError, ErrorCodeRegistry } from "../domain/errors.js";
import { isAbortRejection } from "./abort-rejection.js";

const OPERATION = "probeMcpRuntimeCapabilities";

const mcpCapabilityIds = [
  RuntimeCapabilityRegistry.mcpRuntime.id,
  RuntimeCapabilityRegistry.mcpTransportStdio.id,
  RuntimeCapabilityRegistry.mcpTransportStreamableHttp.id,
  RuntimeCapabilityRegistry.mcpOAuthAuthorizationCode.id,
  RuntimeCapabilityRegistry.mcpOAuthClientCredentials.id,
  RuntimeCapabilityRegistry.mcpToolApproval.id,
  RuntimeCapabilityRegistry.mcpSampling.id,
  RuntimeCapabilityRegistry.mcpElicitationForm.id,
  RuntimeCapabilityRegistry.mcpElicitationUrl.id,
  RuntimeCapabilityRegistry.mcpResources.id,
] as const;

type McpCapabilityId = (typeof mcpCapabilityIds)[number];

function adapterFailure(cause: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation: OPERATION,
    message: "MCP runtime capability probe failed",
    cause,
  });
}

function status(
  value: boolean,
  availableExplanation: string,
  unavailableExplanation: string,
): RuntimeCapabilityAvailability {
  return {
    status: value ? "available" : "unavailable",
    explanation: value ? availableExplanation : unavailableExplanation,
  };
}

function snapshotWithMcpFacts(
  base: RuntimeCapabilitySnapshot,
  values: Readonly<Record<McpCapabilityId, RuntimeCapabilityAvailability>>,
  capturedBy: string,
): RuntimeCapabilitySnapshot {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: {
      ...base.capabilities,
      ...values,
    },
    capturedBy,
  });
}

function unavailableSnapshot(
  base: RuntimeCapabilitySnapshot,
  capturedBy: string,
  explanation: string,
): RuntimeCapabilitySnapshot {
  const values = Object.fromEntries(
    mcpCapabilityIds.map((id) => [id, status(false, explanation, explanation)]),
  ) as Record<McpCapabilityId, RuntimeCapabilityAvailability>;
  return snapshotWithMcpFacts(base, values, capturedBy);
}

function sourceLifecycleComplete(capabilities: McpRuntimeCapabilities): boolean {
  return Object.values(capabilities.sourceLifecycle).every((value) => value === true);
}

function mapRuntimeCapabilities(
  base: RuntimeCapabilitySnapshot,
  capabilities: McpRuntimeCapabilities,
  capturedBy: string,
): RuntimeCapabilitySnapshot {
  const runtimeAvailable = sourceLifecycleComplete(capabilities);
  const lifecycleExplanation = runtimeAvailable
    ? "MCP plugin-scoped source lifecycle is available"
    : "MCP runtime source lifecycle contract is incomplete";
  const exactFactUnavailable = "MCP runtime did not report this exact capability";
  const values: Record<McpCapabilityId, RuntimeCapabilityAvailability> = {
    [RuntimeCapabilityRegistry.mcpRuntime.id]: status(
      runtimeAvailable,
      lifecycleExplanation,
      lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpTransportStdio.id]: status(
      runtimeAvailable && capabilities.transports.stdio,
      "MCP standard-I/O transport is available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpTransportStreamableHttp.id]: status(
      runtimeAvailable && capabilities.transports.streamableHttp,
      "MCP Streamable HTTP transport is available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpOAuthAuthorizationCode.id]: status(
      runtimeAvailable && capabilities.oauth.authorizationCode,
      "MCP authorization-code OAuth is available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpOAuthClientCredentials.id]: status(
      runtimeAvailable && capabilities.oauth.clientCredentials,
      "MCP client-credentials OAuth is available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpToolApproval.id]: status(
      runtimeAvailable && capabilities.features.toolApproval,
      "MCP tool approval is available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpSampling.id]: status(
      runtimeAvailable && capabilities.features.sampling,
      "MCP sampling is available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpElicitationForm.id]: status(
      runtimeAvailable && capabilities.features.elicitationForm,
      "MCP form elicitation is available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpElicitationUrl.id]: status(
      runtimeAvailable && capabilities.features.elicitationUrl,
      "MCP URL elicitation is available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
    [RuntimeCapabilityRegistry.mcpResources.id]: status(
      runtimeAvailable && capabilities.features.resources,
      "MCP resources are available",
      runtimeAvailable ? exactFactUnavailable : lifecycleExplanation,
    ),
  };
  return snapshotWithMcpFacts(base, values, capturedBy);
}

/**
 * Decorate the existing complete capability probe without moving any MCP
 * policy into the adapter. Absence is a valid composition choice; malformed
 * present runtime evidence is an adapter failure and must not be downgraded.
 */
export function createMcpRuntimeCapabilityProbe(input: Readonly<{
  base: RuntimeCapabilityProbe;
  runtime?: Pick<McpRuntimePort, "capabilities">;
  capturedBy: string;
}>): RuntimeCapabilityProbe {
  if (input.base === null || typeof input.base !== "object" || typeof input.base.snapshot !== "function") {
    throw new TypeError("MCP runtime capability probe requires a base probe");
  }
  if (typeof input.capturedBy !== "string" || input.capturedBy.length === 0) {
    throw new TypeError("MCP runtime capability probe requires a non-empty capture identity");
  }

  return {
    async snapshot(signal: AbortSignal): Promise<RuntimeCapabilitySnapshot> {
      signal.throwIfAborted();

      let base: RuntimeCapabilitySnapshot;
      try {
        base = RuntimeCapabilitySnapshotSchema.parse(await input.base.snapshot(signal));
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        if (isAbortRejection(cause)) throw cause;
        throw adapterFailure(cause);
      }
      signal.throwIfAborted();

      if (input.runtime === undefined) {
        return unavailableSnapshot(base, input.capturedBy, "MCP runtime package is unavailable");
      }

      let rawCapabilities: unknown;
      try {
        rawCapabilities = await input.runtime.capabilities(signal);
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        if (isAbortRejection(cause)) throw cause;
        throw adapterFailure(cause);
      }
      signal.throwIfAborted();

      let capabilities: McpRuntimeCapabilities;
      try {
        capabilities = McpRuntimeCapabilitiesSchemaV1.parse(rawCapabilities);
      } catch (cause) {
        throw adapterFailure(cause);
      }
      return mapRuntimeCapabilities(base, capabilities, input.capturedBy);
    },
  };
}
