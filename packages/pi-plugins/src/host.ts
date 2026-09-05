import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { mergeMarketplaceCatalogs, readMarketplaceCatalog, type MarketplaceCatalogRead } from "./catalog.js";
import {
  assertNoSymlinks,
  assertSafeName,
  assertSafeRelativePath,
  createPluginHostPaths,
  resolveContainedExistingPath,
  resolveContainedPath,
} from "./paths.js";
import { buildMcpConfig } from "./mcp.js";
import { scanInstalledPlugins } from "./runtime-discovery.js";
import { installedPluginVersion, readPluginMetadata } from "./plugin-metadata.js";
import type {
  AddMarketplaceOptions,
  CatalogPlugin,
  InstalledPluginInfo,
  MarketplaceCatalog,
  MarketplaceInfo,
  MarketplaceRefreshResult,
  MarketplaceSource,
  MarkedPluginUpdateOptions,
  MarkedPluginUpdateResult,
  MarkedPluginUpdateSummary,
  PluginBatchAction,
  PluginBatchItemResult,
  PluginBatchOptions,
  PluginBatchResult,
  PluginHost,
  PluginIdentity,
  PluginUpdateOptions,
  RefreshMarketplaceOptions,
  RuntimeSnapshot,
} from "./types.js";
import type { PluginHostPaths } from "./types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const CHECK_ON_OPEN_MARKER = ".check-on-open";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason instanceof Error ? signal.reason.message : "operation cancelled");
  error.name = "AbortError";
  throw error;
}

type SourceFile = Readonly<{
  kind: MarketplaceSource["kind"];
  value: string;
  ref?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceFile(source: MarketplaceSource): SourceFile {
  return Object.freeze({
    kind: source.kind,
    value: source.value,
    ...(source.ref === undefined ? {} : { ref: source.ref }),
  });
}

function parseSourceFile(value: unknown): MarketplaceSource {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.value !== "string") {
    throw new Error("source.json must contain kind and value strings");
  }
  if (value.kind !== "github" && value.kind !== "git" && value.kind !== "local") {
    throw new Error(`unsupported marketplace source kind: ${value.kind}`);
  }
  return Object.freeze({
    kind: value.kind,
    value: value.value,
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
  });
}

function isGithubShorthand(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/u.test(value) && !value.startsWith(".");
}

function isGitUrl(value: string): boolean {
  return /^(?:https?|ssh|git):\/\//u.test(value) || /^[^@/\s]+@[^:/\s]+:.+$/u.test(value);
}

async function normalizeMarketplaceSource(value: string, ref?: string): Promise<MarketplaceSource> {
  const input = value.trim();
  if (input.length === 0) throw new Error("marketplace source is required");
  if (isGitUrl(input)) return Object.freeze({ kind: "git", value: input, ...(ref === undefined ? {} : { ref }) });
  const local = input.startsWith("file://") ? new URL(input) : undefined;
  const localPath = local === undefined ? resolve(input) : resolve(decodeURIComponent(local.pathname));
  try {
    const stat = await lstat(localPath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`local marketplace source is not a directory: ${input}`);
    const actual = await realpath(localPath);
    return Object.freeze({ kind: "local", value: actual, ...(ref === undefined ? {} : { ref }) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (isGithubShorthand(input)) return Object.freeze({ kind: "github", value: input, ...(ref === undefined ? {} : { ref }) });
  throw new Error(`marketplace source is not a Git URL, GitHub shorthand, or existing local repository: ${input}`);
}

async function readSource(root: string): Promise<MarketplaceSource> {
  return parseSourceFile(JSON.parse(await readFile(join(root, "source.json"), "utf8")) as unknown);
}

async function runGitClone(source: MarketplaceSource, destination: string, options: RefreshMarketplaceOptions = {}): Promise<void> {
  throwIfAborted(options.signal);
  const gitSource = source.kind === "github" ? `https://github.com/${source.value}.git` : source.value;
  const args = ["clone", "--quiet", "--no-tags"];
  if (source.ref !== undefined) args.push("--branch", source.ref);
  args.push(gitSource, destination);
  await execFileAsync("git", args, {
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  throwIfAborted(options.signal);
}

async function makeOwnerWritable(root: string): Promise<void> {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await chmod(root, stat.mode | 0o200);
    return;
  }
  await chmod(root, stat.mode | 0o700);
  for (const entry of await readdir(root)) await makeOwnerWritable(join(root, entry));
}

async function removeOwnedTree(root: string): Promise<void> {
  try {
    await makeOwnerWritable(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(root, { recursive: true, force: true });
}

async function materializeMarketplace(source: MarketplaceSource, destination: string, options: RefreshMarketplaceOptions = {}): Promise<void> {
  throwIfAborted(options.signal);
  if (source.kind === "local") {
    await cp(source.value, destination, { recursive: true, dereference: false, force: true });
  } else {
    await runGitClone(source, destination, options);
  }
  throwIfAborted(options.signal);
  await makeOwnerWritable(destination);
}

async function ensureRoots(paths: PluginHostPaths): Promise<void> {
  await mkdir(paths.marketplaces, { recursive: true });
  await mkdir(paths.plugins, { recursive: true });
  await mkdir(paths.data, { recursive: true });
}

async function validateCatalogPaths(catalog: MarketplaceCatalog, checkout: string): Promise<void> {
  for (const plugin of catalog.plugins) {
    if (plugin.source.kind === "local") {
      // Lexical validation stops `..`; realpath validation stops a catalog path
      // that crosses a symlink in the checkout (the actual escape threat).
      const path = resolveContainedPath(checkout, plugin.source.path, `${plugin.name} source`);
      try {
        const actual = await realpath(path);
        if (!path.startsWith(`${resolve(checkout)}/`) && path !== resolve(checkout)) throw new Error("source escapes checkout");
        if (!actual.startsWith(`${resolve(checkout)}/`) && actual !== resolve(checkout)) {
          throw new Error(`${plugin.name} source escapes marketplace checkout through a symlink`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

async function catalogForCheckout(checkout: string): Promise<MarketplaceCatalogRead> {
  const result = await readMarketplaceCatalog(checkout);
  await validateCatalogPaths(result.catalog, checkout);
  const plugins = await Promise.all(result.catalog.plugins.map(async (entry) => {
    if (entry.source.kind !== "local") return entry;
    try {
      const root = await resolveContainedExistingPath(checkout, entry.source.path, `${entry.name} source`);
      const metadata = await readPluginMetadata(root);
      return Object.freeze({ ...entry, ...metadata, ...(entry.description === undefined ? {} : { description: entry.description }) });
    } catch {
      // Missing local bundles remain visible; installation reports the source error.
      return entry;
    }
  }));
  return Object.freeze({ ...result, catalog: Object.freeze({ ...result.catalog, plugins: Object.freeze(plugins) }) });
}

function marketplaceInfo(paths: PluginHostPaths, name: string, source: MarketplaceSource): MarketplaceInfo {
  const safe = assertSafeName(name, "marketplace name");
  return Object.freeze({
    name: safe,
    source,
    root: join(paths.marketplaces, safe),
    checkout: join(paths.marketplaces, safe, "checkout"),
  });
}

async function replaceDirectory(staged: string, target: string): Promise<void> {
  // Deleting the live copy before rename loses a working install if publication
  // fails. Retain it only for this replacement, not as a persistent rollback store.
  const holding = await mkdtemp(join(dirname(target), ".replacing-"));
  const previous = join(holding, "previous");
  let movedPrevious = false;
  let retainPrevious = false;
  try {
    try {
      await rename(target, previous);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staged, target);
    } catch (error) {
      if (movedPrevious) {
        try { await rename(previous, target); }
        catch (restoreError) {
          retainPrevious = true;
          throw new AggregateError([error, restoreError], `Replacement failed; previous copy retained at ${previous}`);
        }
      }
      throw error;
    }
  } finally {
    if (!retainPrevious) await removeOwnedTree(holding);
  }
}

async function readReceipt(root: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, ".pi-plugin.json"), "utf8")) as unknown;
    return isRecord(value) ? Object.freeze({ ...value }) : undefined;
  } catch {
    return undefined;
  }
}

async function hasRegularMarker(root: string, marker: string): Promise<boolean> {
  try {
    const stat = await lstat(join(root, marker));
    if (stat.isSymbolicLink()) throw new Error(`${marker} must not be a symlink: ${root}`);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function setRegularMarker(root: string, marker: string, enabled: boolean): Promise<void> {
  const path = join(root, marker);
  if (enabled) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`${marker} must not be a symlink: ${root}`);
      if (!stat.isFile()) throw new Error(`${marker} must be a regular file: ${root}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(path, "", { encoding: "utf8", flag: "wx" });
    }
    return;
  }
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`${marker} must not be a symlink: ${root}`);
    if (!stat.isFile()) throw new Error(`${marker} must be a regular file: ${root}`);
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function installedInfo(paths: PluginHostPaths, marketplace: string, plugin: string): Promise<InstalledPluginInfo> {
  const market = assertSafeName(marketplace, "marketplace name");
  const name = assertSafeName(plugin, "plugin name");
  const root = join(paths.plugins, market, name);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`installed plugin is not a directory: ${name}@${market}`);
  const data = join(paths.data, market, name);
  const disabled = await hasRegularMarker(root, ".disabled");
  const autoUpdate = await hasRegularMarker(root, ".auto-update");
  const receipt = await readReceipt(root);
  const metadata = await readPluginMetadata(root);
  return Object.freeze({ marketplace: market, name, root, data, enabled: !disabled, autoUpdate, ...metadata, ...(receipt === undefined ? {} : { receipt }) });
}

function pluginPath(paths: PluginHostPaths, marketplace: string, plugin: string): string {
  return join(paths.plugins, assertSafeName(marketplace, "marketplace name"), assertSafeName(plugin, "plugin name"));
}

async function findCatalogPlugin(paths: PluginHostPaths, marketplace: string, plugin: string): Promise<{ info: MarketplaceInfo; catalog: MarketplaceCatalog; entry: CatalogPlugin }> {
  const name = assertSafeName(marketplace, "marketplace name");
  const pluginName = assertSafeName(plugin, "plugin name");
  const info = marketplaceInfo(paths, name, await readSource(join(paths.marketplaces, name)));
  const result = await catalogForCheckout(info.checkout);
  const entry = result.catalog.plugins.find((candidate) => candidate.name === pluginName);
  if (entry === undefined) throw new Error(`plugin is not in marketplace catalog: ${pluginName}@${name}`);
  return { info, catalog: result.catalog, entry };
}

async function resolvePluginSource(paths: PluginHostPaths, info: MarketplaceInfo, entry: CatalogPlugin, options: RefreshMarketplaceOptions = {}): Promise<{ root: string; cleanup(): Promise<void> }> {
  if (entry.source.kind === "local") {
    const root = await resolveContainedExistingPath(info.checkout, entry.source.path, `${entry.name} source`);
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`plugin source is not a directory: ${entry.name}`);
    return { root, cleanup: async () => undefined };
  }
  await mkdir(paths.plugins, { recursive: true });
  const sourceStage = await mkdtemp(join(paths.plugins, ".plugin-source-"));
  try {
    const source: MarketplaceSource = { kind: "git", value: entry.source.url, ...(entry.source.ref === undefined ? {} : { ref: entry.source.ref }) };
    await materializeMarketplace(source, sourceStage, options);
    const root = entry.source.path === undefined
      ? sourceStage
      : await resolveContainedExistingPath(sourceStage, entry.source.path, `${entry.name} Git source`);
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Git plugin source is not a directory: ${entry.name}`);
    return { root, cleanup: async () => rm(sourceStage, { recursive: true, force: true }) };
  } catch (error) {
    await rm(sourceStage, { recursive: true, force: true });
    throw error;
  }
}

async function copyPluginBundle(
  paths: PluginHostPaths,
  source: string,
  marketplace: string,
  plugin: string,
  entry: CatalogPlugin,
  preserveDisabled: boolean,
  preserveAutoUpdate: boolean,
): Promise<InstalledPluginInfo> {
  await assertNoSymlinks(source);
  const market = assertSafeName(marketplace, "marketplace name");
  const name = assertSafeName(plugin, "plugin name");
  const parent = join(paths.plugins, market);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, `.${name}-`));
  try {
    for (const item of await readdir(source, { withFileTypes: true })) {
      // These files are host authority, not bundle content. In particular, a
      // catalog must not be able to grant automatic executable updates by
      // shipping its own marker.
      if (item.name === ".git" || item.name === ".pi-plugin.json" || item.name === ".disabled" || item.name === ".auto-update") continue;
      await cp(join(source, item.name), join(stage, item.name), { recursive: true, dereference: false, force: true });
    }
    await makeOwnerWritable(stage);
    const metadata = await readPluginMetadata(stage);
    await writeFile(join(stage, ".pi-plugin.json"), `${JSON.stringify({
      marketplace: market,
      plugin: name,
      description: entry.description ?? metadata.description,
      version: metadata.version ?? entry.version,
      source: entry.source,
    }, null, 2)}\n`, "utf8");
    if (preserveDisabled) await writeFile(join(stage, ".disabled"), "", "utf8");
    if (preserveAutoUpdate) await writeFile(join(stage, ".auto-update"), "", "utf8");
    await assertNoSymlinks(stage);
    const target = pluginPath(paths, market, name);
    await replaceDirectory(stage, target);
    await mkdir(join(paths.data, market, name), { recursive: true });
    return installedInfo(paths, market, name);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export function createPluginHost(agentDir: string): PluginHost {
  const paths = createPluginHostPaths(agentDir);

  async function addMarketplace(sourceValue: string, options: AddMarketplaceOptions = {}): Promise<MarketplaceInfo> {
    await ensureRoots(paths);
    const source = await normalizeMarketplaceSource(sourceValue, options.ref);
    const stageRoot = await mkdtemp(join(paths.marketplaces, ".marketplace-"));
    try {
      const checkout = join(stageRoot, "checkout");
      // Adding a user-selected source may need to clone substantially more
      // history than a routine refresh. Node's zero timeout leaves this
      // foreground acquisition user-controlled instead of applying the
      // manager/startup refresh budget.
      await materializeMarketplace(source, checkout, { timeoutMs: 0 });
      const result = await catalogForCheckout(checkout);
      const info = marketplaceInfo(paths, result.catalog.name, source);
      await writeFile(join(stageRoot, "source.json"), `${JSON.stringify(sourceFile(source), null, 2)}\n`, "utf8");
      await replaceDirectory(stageRoot, info.root);
      return info;
    } catch (error) {
      await rm(stageRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async function listMarketplaces(): Promise<readonly MarketplaceInfo[]> {
    await ensureRoots(paths);
    const values: MarketplaceInfo[] = [];
    for (const entry of await readdir(paths.marketplaces, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const source = await readSource(join(paths.marketplaces, entry.name));
        values.push(marketplaceInfo(paths, entry.name, source));
      } catch {
        // A broken marketplace is omitted from the concise list; browse/refresh
        // reports its concrete source or catalog error when selected.
      }
    }
    return Object.freeze(values.sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function refreshMarketplace(nameValue: string, options: RefreshMarketplaceOptions = {}): Promise<MarketplaceInfo> {
    const name = assertSafeName(nameValue, "marketplace name");
    await ensureRoots(paths);
    throwIfAborted(options.signal);
    const root = join(paths.marketplaces, name);
    const source = await readSource(root);
    const stageRoot = await mkdtemp(join(paths.marketplaces, ".marketplace-refresh-"));
    try {
      const checkout = join(stageRoot, "checkout");
      await materializeMarketplace(source, checkout, options);
      const result = await catalogForCheckout(checkout);
      if (result.catalog.name !== name) throw new Error(`refreshed marketplace declares ${result.catalog.name}, expected ${name}`);
      throwIfAborted(options.signal);
      await replaceDirectory(checkout, join(root, "checkout"));
      return marketplaceInfo(paths, name, source);
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }

  async function refreshMarketplaces(
    names: readonly string[],
    options: RefreshMarketplaceOptions & {
      readonly concurrency?: number;
      readonly onResult?: (result: MarketplaceRefreshResult) => void;
    } = {},
  ): Promise<readonly MarketplaceRefreshResult[]> {
    const uniqueNames = [...new Set(names)].map((name) => assertSafeName(name, "marketplace name"));
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, uniqueNames.length || 1));
    const results: MarketplaceRefreshResult[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next++;
        const name = uniqueNames[index];
        if (name === undefined) return;
        let result: MarketplaceRefreshResult;
        if (options.signal?.aborted) {
          result = Object.freeze({ marketplace: name, ok: false, diagnostics: Object.freeze([]), error: "operation cancelled" });
        } else {
          try {
            const info = await refreshMarketplace(name, options);
            const catalog = await catalogForCheckout(info.checkout);
            result = Object.freeze({
              marketplace: name,
              ok: true,
              info,
              catalog: Object.freeze({ ...catalog.catalog, diagnostics: catalog.diagnostics }),
              diagnostics: catalog.diagnostics,
            });
          } catch (error) {
            result = Object.freeze({ marketplace: name, ok: false, diagnostics: Object.freeze([]), error: errorMessage(error) });
          }
        }
        results[index] = result;
        try { options.onResult?.(result); } catch { /* UI observers cannot change filesystem truth. */ }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return Object.freeze(results.filter((result): result is MarketplaceRefreshResult => result !== undefined));
  }

  async function removeMarketplace(nameValue: string): Promise<void> {
    const name = assertSafeName(nameValue, "marketplace name");
    const root = join(paths.marketplaces, name);
    await removeOwnedTree(root);
  }

  async function browseMarketplace(nameValue: string): Promise<MarketplaceCatalog> {
    const name = assertSafeName(nameValue, "marketplace name");
    const result = await catalogForCheckout(join(paths.marketplaces, name, "checkout"));
    return Object.freeze({ ...result.catalog, diagnostics: result.diagnostics });
  }

  async function listInstalled(): Promise<readonly InstalledPluginInfo[]> {
    await ensureRoots(paths);
    const result: InstalledPluginInfo[] = [];
    for (const market of await readdir(paths.plugins, { withFileTypes: true })) {
      if (market.name.startsWith(".") || !market.isDirectory() || market.isSymbolicLink()) continue;
      for (const plugin of await readdir(join(paths.plugins, market.name), { withFileTypes: true })) {
        if (plugin.name.startsWith(".") || !plugin.isDirectory() || plugin.isSymbolicLink()) continue;
        try { result.push(await installedInfo(paths, market.name, plugin.name)); } catch { /* local listing remains useful */ }
      }
    }
    return Object.freeze(result.sort((a, b) => `${a.marketplace}/${a.name}`.localeCompare(`${b.marketplace}/${b.name}`)));
  }

  async function mutatePlugin(marketplace: string, plugin: string, update: boolean, options: PluginUpdateOptions = {}): Promise<InstalledPluginInfo> {
    await ensureRoots(paths);
    let currentInfo: InstalledPluginInfo | undefined;
    try {
      currentInfo = await installedInfo(paths, marketplace, plugin);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (update && currentInfo === undefined) {
      throw new Error(`plugin is not installed: ${plugin}@${marketplace}`);
    }
    const preserveDisabled = currentInfo?.enabled === false;
    const preserveAutoUpdate = currentInfo?.autoUpdate === true;
    if (update && options.refresh !== false) {
      await refreshMarketplace(marketplace, options);
    }
    throwIfAborted(options.signal);
    const { info, entry } = await findCatalogPlugin(paths, marketplace, plugin);
    const source = await resolvePluginSource(paths, info, entry, options);
    try {
      return await copyPluginBundle(paths, source.root, info.name, entry.name, entry, preserveDisabled, preserveAutoUpdate);
    } finally {
      await source.cleanup();
    }
  }

  async function enablePlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo> {
    const info = await installedInfo(paths, marketplace, plugin);
    const marker = join(info.root, ".disabled");
    try {
      const stat = await lstat(marker);
      if (stat.isSymbolicLink()) throw new Error(`disabled marker is a symlink: ${marker}`);
      await rm(marker, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return installedInfo(paths, marketplace, plugin);
  }

  async function disablePlugin(marketplace: string, plugin: string): Promise<InstalledPluginInfo> {
    const info = await installedInfo(paths, marketplace, plugin);
    const marker = join(info.root, ".disabled");
    try {
      const stat = await lstat(marker);
      if (stat.isSymbolicLink()) throw new Error(`disabled marker is a symlink: ${marker}`);
      if (!stat.isFile()) throw new Error(`disabled marker is not a file: ${marker}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(marker, "", { encoding: "utf8", flag: "w" });
    return installedInfo(paths, marketplace, plugin);
  }

  async function setAutoUpdate(marketplace: string, plugin: string, enabled: boolean): Promise<InstalledPluginInfo> {
    const info = await installedInfo(paths, marketplace, plugin);
    await setRegularMarker(info.root, ".auto-update", enabled);
    return installedInfo(paths, marketplace, plugin);
  }

  async function getCheckOnOpen(): Promise<boolean> {
    await ensureRoots(paths);
    return hasRegularMarker(paths.hostRoot, CHECK_ON_OPEN_MARKER);
  }

  async function setCheckOnOpen(enabled: boolean): Promise<void> {
    await ensureRoots(paths);
    await setRegularMarker(paths.hostRoot, CHECK_ON_OPEN_MARKER, enabled);
  }

  async function removePlugin(marketplace: string, plugin: string, deleteData = false): Promise<void> {
    const root = pluginPath(paths, marketplace, plugin);
    await removeOwnedTree(root);
    if (deleteData) {
      const data = join(paths.data, assertSafeName(marketplace, "marketplace name"), assertSafeName(plugin, "plugin name"));
      await removeOwnedTree(data);
    }
  }

  async function scanRuntime(): Promise<RuntimeSnapshot> {
    await ensureRoots(paths);
    return scanInstalledPlugins(paths);
  }

  async function runPluginBatch(
    action: PluginBatchAction,
    identities: readonly PluginIdentity[],
    options: PluginBatchOptions = {},
  ): Promise<PluginBatchResult> {
    const refreshRequired = options.refresh ?? (action === "install" || action === "update");
    const refreshes = refreshRequired
      ? await refreshMarketplaces(identities.map((identity) => identity.marketplace), options)
      : [];
    const refreshByMarketplace = new Map(refreshes.map((result) => [result.marketplace, result]));
    const results: PluginBatchItemResult[] = [];
    let cancelled = false;

    for (const identity of identities) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      try { options.onBeforeItem?.(identity); } catch { /* observers cannot change filesystem truth */ }
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      let result: PluginBatchItemResult;
      try {
        const marketplace = assertSafeName(identity.marketplace, "marketplace name");
        const plugin = assertSafeName(identity.plugin, "plugin name");
        const refresh = refreshByMarketplace.get(marketplace);
        if (refreshRequired && refresh?.ok !== true) {
          throw new Error(`marketplace refresh failed: ${refresh?.error ?? "unknown error"}`);
        }
        let info: InstalledPluginInfo | undefined;
        if (action === "install") info = await mutatePlugin(marketplace, plugin, false, options);
        if (action === "update") {
          const updateOptions: PluginUpdateOptions = {
            refresh: false,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          };
          info = await mutatePlugin(marketplace, plugin, true, updateOptions);
        }
        if (action === "enable") info = await enablePlugin(marketplace, plugin);
        if (action === "disable") info = await disablePlugin(marketplace, plugin);
        if (action === "remove") await removePlugin(marketplace, plugin, options.deleteData === true);
        result = Object.freeze({ action, identity: Object.freeze({ marketplace, plugin }), ok: true, ...(info === undefined ? {} : { info }) });
      } catch (error) {
        result = Object.freeze({
          action,
          identity: Object.freeze({ ...identity }),
          ok: false,
          error: errorMessage(error),
        });
      }
      // The scan is deliberately after each settled item, including failures:
      // the next item and the result page both observe current filesystem truth.
      await scanRuntime().catch(() => undefined);
      results.push(result);
      try { options.onItem?.(result); } catch { /* a view observer cannot change the batch result */ }
    }
    return Object.freeze({ results: Object.freeze(results), cancelled });
  }

  async function updateMarkedPlugins(options: MarkedPluginUpdateOptions = {}): Promise<MarkedPluginUpdateSummary> {
    const marked = (await listInstalled()).filter((plugin) => plugin.autoUpdate);
    const refreshes = await refreshMarketplaces(
      [...new Set(marked.map((plugin) => plugin.marketplace))],
      options,
    );
    const refreshByMarketplace = new Map(refreshes.map((result) => [result.marketplace, result]));
    const results: MarkedPluginUpdateResult[] = [];
    const force = options.force === true;

    for (const installed of marked) {
      if (options.signal?.aborted) break;
      const identity = Object.freeze({ marketplace: installed.marketplace, plugin: installed.name });
      const refresh = refreshByMarketplace.get(installed.marketplace);
      let result: MarkedPluginUpdateResult;
      try {
        if (refresh?.ok !== true || refresh.catalog === undefined) {
          throw new Error(`marketplace refresh failed: ${refresh?.error ?? "unknown error"}`);
        }
        const entry = refresh.catalog.plugins.find((candidate) => candidate.name === installed.name);
        if (entry === undefined) throw new Error(`plugin is not in marketplace catalog: ${installed.name}@${installed.marketplace}`);
        const installedVersion = installedPluginVersion(installed);
        const marketInfo = refresh.info ?? marketplaceInfo(paths, installed.marketplace, await readSource(join(paths.marketplaces, installed.marketplace)));
        // Remote entries may omit or lag the bundle version too. Resolve the
        // candidate once and copy that same source only if an update is needed.
        const source = await resolvePluginSource(paths, marketInfo, entry, options);
        try {
          const metadata = await readPluginMetadata(source.root);
          const availableVersion = metadata.version ?? entry.version;
          if (!force && availableVersion === undefined) {
            result = Object.freeze({ identity, ok: true, updated: false, skipped: true, reason: "bundle and catalog do not declare a version" });
          } else if (!force && installedVersion === availableVersion) {
            result = Object.freeze({ identity, ok: true, updated: false, skipped: true, reason: "already at declared version" });
          } else {
            throwIfAborted(options.signal);
            const current = await installedInfo(paths, installed.marketplace, installed.name);
            const info = await copyPluginBundle(paths, source.root, installed.marketplace, installed.name, entry, !current.enabled, current.autoUpdate);
            result = Object.freeze({ identity, ok: true, updated: true, skipped: false, info });
          }
        } finally {
          await source.cleanup();
        }
      } catch (error) {
        result = Object.freeze({ identity, ok: false, updated: false, skipped: false, error: errorMessage(error) });
      }
      results.push(result);
      try { options.onItem?.(result); } catch { /* a view observer cannot change the update outcome */ }
    }
    return Object.freeze({ refreshes, results: Object.freeze(results) });
  }

  return Object.freeze({
    paths,
    addMarketplace,
    listMarketplaces,
    refreshMarketplace,
    refreshMarketplaces,
    removeMarketplace,
    browseMarketplace,
    listInstalled,
    installPlugin: (marketplace: string, plugin: string) => mutatePlugin(marketplace, plugin, false),
    updatePlugin: (marketplace: string, plugin: string, options?: PluginUpdateOptions) => mutatePlugin(marketplace, plugin, true, options),
    enablePlugin,
    disablePlugin,
    removePlugin,
    setAutoUpdate,
    runPluginBatch,
    updateMarkedPlugins,
    getCheckOnOpen,
    setCheckOnOpen,
    scanRuntime,
    buildMcpConfig: async (snapshot?: RuntimeSnapshot) => buildMcpConfig(snapshot ?? await scanRuntime()),
  });
}

export { assertSafeRelativePath, assertSafeName, isPathContained, resolveContainedPath } from "./paths.js";
export { mergeMarketplaceCatalogs, readMarketplaceCatalog } from "./catalog.js";
export type { ParsedDocumentLike } from "./catalog.js";
