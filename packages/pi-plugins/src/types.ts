export type MarketplaceSourceKind = "github" | "git" | "local";

export interface MarketplaceSource {
  readonly kind: MarketplaceSourceKind;
  readonly value: string;
  readonly ref?: string;
}

export type PluginSource =
  | Readonly<{ kind: "local"; path: string }>
  | Readonly<{ kind: "git" | "git-subdir"; url: string; path?: string; ref?: string }>;

export interface CatalogPlugin {
  readonly name: string;
  readonly source: PluginSource;
  readonly description?: string;
  readonly version?: string;
  readonly raw: Readonly<Record<string, unknown>> | string;
}

export interface MarketplaceCatalog {
  readonly name: string;
  readonly plugins: readonly CatalogPlugin[];
  readonly sources: readonly string[];
  readonly diagnostics?: readonly PluginDiagnostic[];
}

export interface PluginDiagnostic {
  readonly scope: string;
  readonly message: string;
  readonly cause?: unknown;
}

export interface MarketplaceInfo {
  readonly name: string;
  readonly source: MarketplaceSource;
  readonly root: string;
  readonly checkout: string;
}

export interface InstalledPluginInfo {
  readonly marketplace: string;
  readonly name: string;
  readonly root: string;
  readonly data: string;
  readonly enabled: boolean;
  readonly receipt?: Readonly<Record<string, unknown>>;
}

export interface PluginHookCommand {
  readonly event: SupportedHookEvent;
  readonly matcher?: string;
  readonly command: string;
  readonly timeoutMs: number;
}

export const SUPPORTED_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "Stop",
] as const;

export type SupportedHookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number];

export interface DiscoveredPlugin {
  readonly info: InstalledPluginInfo;
  readonly skillPaths: readonly string[];
  readonly hooks: readonly PluginHookCommand[];
  readonly mcp?: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface RuntimeSnapshot {
  readonly plugins: readonly DiscoveredPlugin[];
  readonly skillPaths: readonly string[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface PluginHostPaths extends Readonly<PluginHostPathsShape> {}

export interface PluginHostPathsShape {
  readonly agentDir: string;
  readonly hostRoot: string;
  readonly marketplaces: string;
  readonly plugins: string;
  readonly data: string;
}

export interface AddMarketplaceOptions {
  readonly ref?: string;
}

export interface PluginMutationOptions {
  readonly preserveDisabled?: boolean;
}

export interface PluginHost {
  readonly paths: PluginHostPaths;
  addMarketplace(source: string, options?: AddMarketplaceOptions): Promise<MarketplaceInfo>;
  listMarketplaces(): Promise<readonly MarketplaceInfo[]>;
  refreshMarketplace(name: string): Promise<MarketplaceInfo>;
  removeMarketplace(name: string): Promise<void>;
  browseMarketplace(name: string): Promise<MarketplaceCatalog>;
  listInstalled(): Promise<readonly InstalledPluginInfo[]>;
  installPlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo>;
  updatePlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo>;
  enablePlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo>;
  disablePlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo>;
  removePlugin(marketplace: string, plugin: string, deleteData?: boolean): Promise<void>;
  scanRuntime(): Promise<RuntimeSnapshot>;
  buildMcpConfig(snapshot?: RuntimeSnapshot): Promise<Readonly<{ mcpServers: Readonly<Record<string, unknown>> }>>;
}

export type HookOutput = Readonly<{
  additionalContext?: string;
  block?: boolean;
  reason?: string;
  continue?: boolean;
}>;

export interface HookExecutionResult {
  readonly ok: boolean;
  readonly output?: HookOutput;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: unknown;
}