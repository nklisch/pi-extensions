import type { PluginConfiguration, ConfigurationOption } from "../../domain/configuration.js";
import type { HookExecutionBinding } from "../../domain/hook-execution-binding.js";
export type { HookExecutionBinding } from "../../domain/hook-execution-binding.js";
import type { TrustCandidate } from "../../domain/trust-policy.js";
import type { TrustStateRecord } from "../../domain/state/trust-state.js";
import type { ConfigurationPathContext } from "./configuration-path.js";
import type { CurrentProjectRuntimeContext } from "./project-trust.js";
import type { ResolvedConfiguration } from "../resolved-configuration.js";

export type HookExecutionContextRequest = Readonly<{
  binding: HookExecutionBinding;
  sessionCwd: string;
  plannedPluginRoot: string;
  plannedPluginDataRoot: string;
  currentProject: CurrentProjectRuntimeContext;
}>;

export type ResolvedHookExecutionContext = Readonly<{
  cwd: string;
  projectRoot: string;
  pluginRoot: string;
  pluginDataRoot: string;
  configuration: ResolvedConfiguration;
}>;

export interface HookExecutionContextPort {
  withContext(
    request: HookExecutionContextRequest,
    signal: AbortSignal,
    use: (context: ResolvedHookExecutionContext) => Promise<void>,
  ): Promise<void>;
}

/** The active selection authority supplied by native lifecycle composition. */
export type HookExecutionActiveSelection = Readonly<{
  binding: HookExecutionBinding;
  pluginRoot: string;
  pluginDataRoot: string;
  /** Optional callback cwd evidence supplied by the native composition. */
  currentCwd?: string;
  currentProject: CurrentProjectRuntimeContext;
  candidate: TrustCandidate;
  trustRecords: readonly TrustStateRecord[];
  configurationRef: import("../../domain/state/references.js").PluginConfigurationRef | undefined;
  descriptors: PluginConfiguration;
  pathContext: ConfigurationPathContext;
}>;

export interface HookExecutionActiveSelectionPort {
  get(binding: HookExecutionBinding): HookExecutionActiveSelection | undefined;
  currentProject(): CurrentProjectRuntimeContext;
}

export type HookExecutionContextFailureCode =
  | "INVALID_REQUEST"
  | "ACTIVE_BINDING_UNAVAILABLE"
  | "BINDING_MISMATCH"
  | "CURRENT_PROJECT_MISMATCH"
  | "PROJECT_ROOT_UNAVAILABLE"
  | "CONFIGURATION_FAILED";

export class HookExecutionContextError extends Error {
  constructor(readonly code: HookExecutionContextFailureCode) {
    super("hook execution context is unavailable");
    this.name = "HookExecutionContextError";
  }
}

export type HookExecutionConfigurationDependencies = Parameters<
  typeof import("../configuration-resolver.js").withResolvedPluginConfiguration
>[1];

export type HookExecutionContextPortDependencies = Readonly<{
  active: HookExecutionActiveSelectionPort;
  projectRoots: import("./project-root-authority.js").ProjectRootAuthorityPort;
  configuration: Readonly<{
    withResolvedPluginConfiguration: typeof import("../configuration-resolver.js").withResolvedPluginConfiguration;
    dependencies: HookExecutionConfigurationDependencies;
  }>;
}>;

export type HookExecutionConfigurationOption = ConfigurationOption;
