import type { McpServerComponent } from "../../domain/components.js";
import { ErrorCodeRegistry, DomainContractError, type ErrorCode } from "../../domain/errors.js";
import type { PluginConfiguration } from "../../domain/configuration.js";
import type { InstalledRevisionRecord } from "../../domain/state/installed-state.js";
import type { TrustStateRecord } from "../../domain/state/trust-state.js";
import type { TrustCandidate } from "../../domain/trust-policy.js";
import type { ConfigurationPathContext } from "./configuration-path.js";
import type { CurrentProjectRuntimeContext } from "./project-trust.js";
import type { ProjectionExpectation } from "./runtime-projection.js";
import {
  McpRuntimeServerBindingSchemaV1,
  type McpBridgeTransport,
  type McpRuntimeServerBinding,
  type McpSourceIdentity,
  type McpSourceProjectionBinding,
} from "./mcp-runtime.js";
import type { ResolvedConfiguration } from "../resolved-configuration.js";
import type { McpLaunchTemplate } from "../../domain/mcp-launch-template.js";

export const McpLaunchBindingSchemaV1 = McpRuntimeServerBindingSchemaV1;
export type McpLaunchBinding = McpRuntimeServerBinding;

export type McpLaunchActiveSelection = Readonly<{
  expectation: Extract<ProjectionExpectation, { kind: "active" }>;
  revision: InstalledRevisionRecord;
  component: McpServerComponent;
  currentProject: CurrentProjectRuntimeContext;
  candidate: TrustCandidate;
  trustRecords: readonly TrustStateRecord[];
  descriptors: PluginConfiguration;
  pathContext: ConfigurationPathContext;
}>;

/**
 * Native composition must pin this exact selection for the callback lifetime.
 * Replacement/removal waits for it or rejects the callback; a get-only
 * snapshot is not a conforming implementation.
 */
export interface McpLaunchActiveSelectionPort {
  withSelection(
    binding: McpLaunchBinding,
    signal: AbortSignal,
    use: (selection: McpLaunchActiveSelection) => Promise<void>,
  ): Promise<void>;
}

export type ResolvedMcpLaunchContext = Readonly<{
  binding: McpLaunchBinding;
  pluginRoot: string;
  pluginDataRoot: string;
  projectRoot: string;
  projection: McpSourceProjectionBinding;
  template: McpLaunchTemplate;
  configuration: ResolvedConfiguration;
}>;

export interface McpLaunchContextPort {
  withContext(
    binding: McpLaunchBinding,
    signal: AbortSignal,
    use: (context: ResolvedMcpLaunchContext) => Promise<void>,
  ): Promise<void>;
}

export type McpLaunchConfigurationDependencies = Parameters<
  typeof import("../configuration-resolver.js").withResolvedPluginConfiguration
>[1];

export type McpLaunchContextPortDependencies = Readonly<{
  active: McpLaunchActiveSelectionPort;
  content: Pick<import("./content-store.js").ContentStorePort, "resolvePlugin" | "ensureDataRoot">;
  projectRoots: import("./project-root-authority.js").ProjectRootAuthorityPort;
  projectTrust: import("./project-trust.js").ProjectTrustPort;
  configuration: Readonly<{
    withResolvedPluginConfiguration: typeof import("../configuration-resolver.js").withResolvedPluginConfiguration;
    dependencies: McpLaunchConfigurationDependencies;
  }>;
  sha256: import("../../domain/source.js").Sha256;
}>;

export const McpLaunchErrorCodes = {
  authorityRejected: ErrorCodeRegistry.mcpLaunchAuthorityRejected,
  configurationFailed: ErrorCodeRegistry.mcpLaunchConfigurationFailed,
  environmentFailed: ErrorCodeRegistry.mcpLaunchEnvironmentFailed,
  valueInvalid: ErrorCodeRegistry.mcpLaunchValueInvalid,
  cancelled: ErrorCodeRegistry.mcpLaunchCancelled,
  timeout: ErrorCodeRegistry.mcpLaunchTimeout,
  cleanupFailed: ErrorCodeRegistry.mcpLaunchCleanupFailed,
} as const;

export class McpLaunchContextError extends DomainContractError {
  constructor(input: Readonly<{
    code: ErrorCode;
    source?: McpSourceIdentity;
    serverKey?: string;
    componentId?: string;
    transport?: McpBridgeTransport;
  }>) {
    super({
      code: input.code,
      operation: "resolveMcpLaunchContext",
      message: "MCP launch context is unavailable",
      ...(input.source === undefined ? {} : { plugin: input.source.plugin }),
      details: {
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.serverKey === undefined ? {} : { serverKey: input.serverKey }),
        ...(input.componentId === undefined ? {} : { componentId: input.componentId }),
        ...(input.transport === undefined ? {} : { transport: input.transport }),
      },
    });
    this.name = "McpLaunchContextError";
  }
}

export type { McpBridgeTransport, McpSourceIdentity };
