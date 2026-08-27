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
  readonly autoUpdate: boolean;
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
  /** Component identifiers derived from the same load-time snapshot. */
  readonly skillNames: readonly string[];
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

export interface RefreshMarketplaceOptions {
  readonly signal?: AbortSignal;
  /** Bound network acquisition. Local checkouts still use the same seam. */
  readonly timeoutMs?: number;
}

export interface MarketplaceRefreshResult {
  readonly marketplace: string;
  readonly ok: boolean;
  readonly info?: MarketplaceInfo;
  readonly catalog?: MarketplaceCatalog;
  readonly diagnostics: readonly PluginDiagnostic[];
  readonly error?: string;
}

export interface PluginIdentity {
  readonly marketplace: string;
  readonly plugin: string;
}

export type PluginBatchAction = "install" | "update" | "enable" | "disable" | "remove";

export interface PluginUpdateOptions extends RefreshMarketplaceOptions {
  /** Batch and startup callers refresh the source once before updating. */
  readonly refresh?: boolean;
}

export interface PluginBatchItemResult {
  readonly action: PluginBatchAction;
  readonly identity: PluginIdentity;
  readonly ok: boolean;
  readonly info?: InstalledPluginInfo;
  readonly error?: string;
}

export interface PluginBatchOptions extends RefreshMarketplaceOptions {
  /** Install/update refresh each affected marketplace once before execution. */
  readonly refresh?: boolean;
  readonly deleteData?: boolean;
  /** Called at the item boundary, before the current item can be cancelled. */
  readonly onBeforeItem?: (identity: PluginIdentity) => void;
  readonly onItem?: (result: PluginBatchItemResult) => void;
}

export interface PluginBatchResult {
  readonly results: readonly PluginBatchItemResult[];
  readonly cancelled: boolean;
}

export interface MarkedPluginUpdateOptions extends RefreshMarketplaceOptions {
  /** The explicit command forces updates even when catalog versions are absent. */
  readonly force?: boolean;
  readonly onItem?: (result: MarkedPluginUpdateResult) => void;
}

export interface MarkedPluginUpdateResult {
  readonly identity: PluginIdentity;
  readonly ok: boolean;
  readonly updated: boolean;
  readonly skipped: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly info?: InstalledPluginInfo;
}

export interface MarkedPluginUpdateSummary {
  readonly refreshes: readonly MarketplaceRefreshResult[];
  readonly results: readonly MarkedPluginUpdateResult[];
}

export interface PluginHost {
  readonly paths: PluginHostPaths;
  addMarketplace(source: string, options?: AddMarketplaceOptions): Promise<MarketplaceInfo>;
  listMarketplaces(): Promise<readonly MarketplaceInfo[]>;
  refreshMarketplace(name: string, options?: RefreshMarketplaceOptions): Promise<MarketplaceInfo>;
  refreshMarketplaces(names: readonly string[], options?: RefreshMarketplaceOptions & {
    readonly concurrency?: number;
    readonly onResult?: (result: MarketplaceRefreshResult) => void;
  }): Promise<readonly MarketplaceRefreshResult[]>;
  removeMarketplace(name: string): Promise<void>;
  browseMarketplace(name: string): Promise<MarketplaceCatalog>;
  listInstalled(): Promise<readonly InstalledPluginInfo[]>;
  installPlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo>;
  updatePlugin(marketplace: string, plugin: string, options?: PluginUpdateOptions): Promise<InstalledPluginInfo>;
  enablePlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo>;
  disablePlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo>;
  removePlugin(marketplace: string, plugin: string, deleteData?: boolean): Promise<void>;
  setAutoUpdate(marketplace: string, plugin: string, enabled: boolean): Promise<InstalledPluginInfo>;
  getCheckOnOpen(): Promise<boolean>;
  setCheckOnOpen(enabled: boolean): Promise<void>;
  runPluginBatch(action: PluginBatchAction, identities: readonly PluginIdentity[], options?: PluginBatchOptions): Promise<PluginBatchResult>;
  updateMarkedPlugins(options?: MarkedPluginUpdateOptions): Promise<MarkedPluginUpdateSummary>;
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