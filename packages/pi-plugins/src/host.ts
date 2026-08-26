import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
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
import type {
  AddMarketplaceOptions,
  CatalogPlugin,
  InstalledPluginInfo,
  MarketplaceCatalog,
  MarketplaceInfo,
  MarketplaceSource,
  PluginHost,
  RuntimeSnapshot,
} from "./types.js";
import type { PluginHostPaths } from "./types.js";

const execFileAsync = promisify(execFile);

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

async function runGitClone(source: MarketplaceSource, destination: string): Promise<void> {
  const gitSource = source.kind === "github" ? `https://github.com/${source.value}.git` : source.value;
  const args = ["clone", "--quiet", "--no-tags"];
  if (source.ref !== undefined) args.push("--branch", source.ref);
  args.push(gitSource, destination);
  await execFileAsync("git", args, { maxBuffer: 4 * 1024 * 1024 });
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

async function materializeMarketplace(source: MarketplaceSource, destination: string): Promise<void> {
  if (source.kind === "local") {
    await cp(source.value, destination, { recursive: true, dereference: false, force: true });
  } else {
    await runGitClone(source, destination);
  }
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
  return result;
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
  await removeOwnedTree(target);
  await rename(staged, target);
}

async function readReceipt(root: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, ".pi-plugin.json"), "utf8")) as unknown;
    return isRecord(value) ? Object.freeze({ ...value }) : undefined;
  } catch {
    return undefined;
  }
}

async function installedInfo(paths: PluginHostPaths, marketplace: string, plugin: string): Promise<InstalledPluginInfo> {
  const market = assertSafeName(marketplace, "marketplace name");
  const name = assertSafeName(plugin, "plugin name");
  const root = join(paths.plugins, market, name);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`installed plugin is not a directory: ${name}@${market}`);
  const data = join(paths.data, market, name);
  const disabled = await lstat(join(root, ".disabled")).then((item) => item.isFile()).catch(() => false);
  const receipt = await readReceipt(root);
  return Object.freeze({ marketplace: market, name, root, data, enabled: !disabled, ...(receipt === undefined ? {} : { receipt }) });
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

async function resolvePluginSource(paths: PluginHostPaths, info: MarketplaceInfo, entry: CatalogPlugin): Promise<{ root: string; cleanup(): Promise<void> }> {
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
    await materializeMarketplace(source, sourceStage);
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

async function copyPluginBundle(paths: PluginHostPaths, source: string, marketplace: string, plugin: string, entry: CatalogPlugin, preserveDisabled: boolean): Promise<InstalledPluginInfo> {
  await assertNoSymlinks(source);
  const market = assertSafeName(marketplace, "marketplace name");
  const name = assertSafeName(plugin, "plugin name");
  const parent = join(paths.plugins, market);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, `.${name}-`));
  try {
    for (const item of await readdir(source, { withFileTypes: true })) {
      if (item.name === ".git") continue;
      await cp(join(source, item.name), join(stage, item.name), { recursive: true, dereference: false, force: true });
    }
    await makeOwnerWritable(stage);
    await writeFile(join(stage, ".pi-plugin.json"), `${JSON.stringify({
      marketplace: market,
      plugin: name,
      description: entry.description,
      version: entry.version,
      source: entry.source,
    }, null, 2)}\n`, "utf8");
    if (preserveDisabled) await writeFile(join(stage, ".disabled"), "", "utf8");
    await assertNoSymlinks(stage);
    const target = pluginPath(paths, market, name);
    await removeOwnedTree(target);
    await rename(stage, target);
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
      await materializeMarketplace(source, checkout);
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

  async function refreshMarketplace(nameValue: string): Promise<MarketplaceInfo> {
    const name = assertSafeName(nameValue, "marketplace name");
    await ensureRoots(paths);
    const root = join(paths.marketplaces, name);
    const source = await readSource(root);
    const stageRoot = await mkdtemp(join(paths.marketplaces, ".marketplace-refresh-"));
    try {
      const checkout = join(stageRoot, "checkout");
      await materializeMarketplace(source, checkout);
      const result = await catalogForCheckout(checkout);
      if (result.catalog.name !== name) throw new Error(`refreshed marketplace declares ${result.catalog.name}, expected ${name}`);
      await removeOwnedTree(join(root, "checkout"));
      await rename(checkout, join(root, "checkout"));
      return marketplaceInfo(paths, name, source);
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
    }
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

  async function mutatePlugin(marketplace: string, plugin: string, update: boolean): Promise<InstalledPluginInfo> {
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
    if (update) {
      await refreshMarketplace(marketplace);
    }
    const { info, entry } = await findCatalogPlugin(paths, marketplace, plugin);
    const source = await resolvePluginSource(paths, info, entry);
    try {
      return await copyPluginBundle(paths, source.root, info.name, entry.name, entry, preserveDisabled);
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
    await writeFile(marker, "", { encoding: "utf8", flag: "w" });
    return installedInfo(paths, marketplace, plugin);
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

  return Object.freeze({
    paths,
    addMarketplace,
    listMarketplaces,
    refreshMarketplace,
    removeMarketplace,
    browseMarketplace,
    listInstalled,
    installPlugin: (marketplace: string, plugin: string) => mutatePlugin(marketplace, plugin, false),
    updatePlugin: (marketplace: string, plugin: string) => mutatePlugin(marketplace, plugin, true),
    enablePlugin,
    disablePlugin,
    removePlugin,
    scanRuntime,
    buildMcpConfig: async (snapshot?: RuntimeSnapshot) => buildMcpConfig(snapshot ?? await scanRuntime()),
  });
}

export { assertSafeRelativePath, assertSafeName, isPathContained, resolveContainedPath } from "./paths.js";
export { mergeMarketplaceCatalogs, readMarketplaceCatalog } from "./catalog.js";
export type { ParsedDocumentLike } from "./catalog.js";
