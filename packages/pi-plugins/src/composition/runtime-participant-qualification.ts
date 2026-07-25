import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { satisfies, valid, validRange } from "semver";
import {
  McpRuntimeCapabilitiesSchemaV1,
  type McpRuntimeCapabilities,
  type McpRuntimePort,
} from "../application/ports/mcp-runtime.js";
import {
  SubagentLifecycleCapabilitiesSchemaV1,
  type SubagentLifecycleCapabilities,
  type SubagentLifecyclePort,
} from "../application/ports/subagent-lifecycle.js";

export const PACKAGED_HOST_NODE_RANGE = ">=24";
/**
 * Admission policy: any pre-1.0 Pi at or above the verified API floor. A
 * minor-version cap hard-broke every installed host on each Pi minor release
 * (MCP/subagent capabilities collapsed to unavailable behind it), which is
 * too brittle for a plugin-management host. The structural ExtensionAPI
 * shape check in hostApiStatus stays as the fail-closed guard against real
 * API drift; published adapter packages still enforce their own peer ranges.
 * The `<1.0.0-0` cap also excludes 1.0.0 prereleases, which would otherwise
 * satisfy the range under includePrerelease.
 */
export const PACKAGED_HOST_PI_RANGE = ">=0.80.0 <1.0.0-0";

export type RuntimeQualificationStatus = Readonly<{
  status: "available" | "unavailable";
  explanation: string;
}>;

export type RuntimeParticipantQualification = Readonly<{
  nodeVersion: string;
  piVersion: string;
  hostApi: RuntimeQualificationStatus;
  mcp: RuntimeQualificationStatus & Readonly<{
    runtime?: McpRuntimePort;
    capabilities?: McpRuntimeCapabilities;
  }>;
  subagents: RuntimeQualificationStatus & Readonly<{
    lifecycle?: SubagentLifecyclePort;
    capabilities?: SubagentLifecycleCapabilities;
  }>;
}>;

function unavailable(explanation: string): RuntimeQualificationStatus {
  return Object.freeze({ status: "unavailable", explanation });
}

function available(explanation: string): RuntimeQualificationStatus {
  return Object.freeze({ status: "available", explanation });
}

function runtimeSatisfies(version: string, range: string): boolean {
  return valid(version) !== null && validRange(range) !== null && satisfies(version, range, { includePrerelease: true });
}

function hostApiStatus(pi: ExtensionAPI, nodeVersion: string, piVersion: string): RuntimeQualificationStatus {
  const apiComplete = pi !== null && typeof pi === "object" &&
    typeof pi.on === "function" && typeof pi.sendMessage === "function" && typeof pi.setSessionName === "function";
  return apiComplete && runtimeSatisfies(nodeVersion, PACKAGED_HOST_NODE_RANGE) && runtimeSatisfies(piVersion, PACKAGED_HOST_PI_RANGE)
    ? available("the active Pi API and Node/Pi runtime ranges satisfy the packaged-host contract")
    : unavailable("the active Pi API or Node/Pi runtime range does not satisfy the packaged-host contract");
}

function publishedProviderCompatible(
  provider: Readonly<{ kind: string; version?: string; nodeEngine?: string; piPeerRange?: string }>,
  nodeVersion: string,
  piVersion: string,
): boolean {
  return provider.kind === "published-package" &&
    typeof provider.version === "string" && valid(provider.version) !== null &&
    typeof provider.nodeEngine === "string" && runtimeSatisfies(nodeVersion, provider.nodeEngine) &&
    typeof provider.piPeerRange === "string" && runtimeSatisfies(piVersion, provider.piPeerRange);
}

function pinnedMcp(runtime: McpRuntimePort, capabilities: McpRuntimeCapabilities): McpRuntimePort {
  return Object.freeze({
    capabilities: async (signal: AbortSignal) => { signal.throwIfAborted(); return capabilities; },
    validateSource: runtime.validateSource.bind(runtime),
    replaceSource: runtime.replaceSource.bind(runtime),
    removeSource: runtime.removeSource.bind(runtime),
    inspectSource: runtime.inspectSource.bind(runtime),
    inspectSources: runtime.inspectSources.bind(runtime),
  });
}

function pinnedSubagents(lifecycle: SubagentLifecyclePort, capabilities: SubagentLifecycleCapabilities): SubagentLifecyclePort {
  return Object.freeze({
    capabilities: async (signal: AbortSignal) => { signal.throwIfAborted(); return capabilities; },
    register: lifecycle.register.bind(lifecycle),
  });
}

/**
 * Make the one production qualification decision consumed by probing,
 * registration, desired-state construction, and startup reporting. Present but
 * malformed or contradictory evidence is unavailable everywhere, never partly
 * admitted by one consumer.
 */
export async function qualifyRuntimeParticipants(input: Readonly<{
  pi: ExtensionAPI;
  nodeVersion: string;
  piVersion: string;
  mcp?: McpRuntimePort;
  subagents?: SubagentLifecyclePort;
  signal: AbortSignal;
}>): Promise<RuntimeParticipantQualification> {
  input.signal.throwIfAborted();
  const hostApi = hostApiStatus(input.pi, input.nodeVersion, input.piVersion);
  let mcp: RuntimeParticipantQualification["mcp"] = unavailable("no qualified published MCP runtime is composed");
  let subagents: RuntimeParticipantQualification["subagents"] = unavailable("no qualified published subagent lifecycle is composed");

  if (hostApi.status === "available" && input.mcp !== undefined) {
    try {
      const capabilities = McpRuntimeCapabilitiesSchemaV1.parse(await input.mcp.capabilities(input.signal));
      const completeLifecycle = Object.values(capabilities.sourceLifecycle).every((value) => value === true);
      if (capabilities.provider !== undefined && completeLifecycle &&
          publishedProviderCompatible(capabilities.provider, input.nodeVersion, input.piVersion)) {
        mcp = Object.freeze({
          ...available(capabilities.features.pluginToolAliases
            ? "published MCP runtime evidence satisfies complete lifecycle and Node/Pi ranges"
            : "published MCP runtime evidence satisfies complete lifecycle and Node/Pi ranges; RUNTIME_ALIAS_UNAVAILABLE"),
          capabilities,
          runtime: pinnedMcp(input.mcp, capabilities),
        });
      }
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
    }
  }

  if (hostApi.status === "available" && input.subagents !== undefined) {
    try {
      const capabilities = SubagentLifecycleCapabilitiesSchemaV1.parse(await input.subagents.capabilities(input.signal));
      const complete = Object.values(capabilities.semantics).every((value) => value === true) &&
        Object.values(capabilities.coverage).every((value) => value === true);
      if (complete && publishedProviderCompatible(capabilities.provider, input.nodeVersion, input.piVersion)) {
        subagents = Object.freeze({
          ...available("published subagent lifecycle evidence satisfies complete semantics and Node/Pi ranges"),
          capabilities,
          lifecycle: pinnedSubagents(input.subagents, capabilities),
        });
      }
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
    }
  }

  return Object.freeze({
    nodeVersion: input.nodeVersion,
    piVersion: input.piVersion,
    hostApi,
    mcp,
    subagents,
  });
}
