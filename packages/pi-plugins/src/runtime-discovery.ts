import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assertNoSymlinks, assertSafeName, resolveContainedExistingPath } from "./paths.js";
import type {
  DiscoveredPlugin,
  InstalledPluginInfo,
  PluginDiagnostic,
  PluginHookCommand,
  PluginHostPaths,
  RuntimeSnapshot,
  SupportedHookEvent,
} from "./types.js";
import { SUPPORTED_HOOK_EVENTS } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(scope: string, error: unknown): PluginDiagnostic {
  return Object.freeze({ scope, message: error instanceof Error ? error.message : String(error), cause: error });
}

async function optionalJson(path: string): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")) as unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error };
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function collectSkillNames(root: string, prefix: string, names: string[]): Promise<void> {
  if (!await isDirectory(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      names.push(prefix.length === 0 ? "root" : prefix);
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      await collectSkillNames(child, prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`, names);
    }
  }
}

async function discoverSkillNames(root: string): Promise<readonly string[]> {
  const names: string[] = [];
  if (await isFile(join(root, "SKILL.md"))) names.push("root");
  await collectSkillNames(join(root, "skills"), "skills", names);
  return Object.freeze(names);
}

function timeoutMilliseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 10_000;
  // Claude hook metadata expresses timeout in seconds. Keep a practical upper
  // bound so a malformed catalog cannot make Pi wait indefinitely.
  return Math.min(Math.max(value * 1_000, 100), 10 * 60 * 1_000);
}

function hookEvent(value: string): value is SupportedHookEvent {
  return (SUPPORTED_HOOK_EVENTS as readonly string[]).includes(value);
}

function parseHooks(value: unknown, scope: string): { hooks: PluginHookCommand[]; diagnostics: PluginDiagnostic[] } {
  const diagnostics: PluginDiagnostic[] = [];
  if (!record(value)) throw new Error("hooks document must be an object");
  const declaration = record(value.hooks) ? value.hooks : value;
  const hooks: PluginHookCommand[] = [];
  for (const [eventName, groupsValue] of Object.entries(declaration)) {
    if (!hookEvent(eventName)) {
      diagnostics.push(diagnostic(`${scope}.${eventName}`, new Error(`unsupported hook event: ${eventName}`)));
      continue;
    }
    const groups = Array.isArray(groupsValue) ? groupsValue : [groupsValue];
    for (const [groupIndex, groupValue] of groups.entries()) {
      if (!record(groupValue)) {
        diagnostics.push(diagnostic(`${scope}.${eventName}[${groupIndex}]`, new Error("hook group must be an object")));
        continue;
      }
      const matcher = typeof groupValue.matcher === "string" ? groupValue.matcher : undefined;
      const commands = Array.isArray(groupValue.hooks) ? groupValue.hooks : [groupValue.hooks];
      for (const [commandIndex, commandValue] of commands.entries()) {
        if (!record(commandValue) || commandValue.type !== "command" || typeof commandValue.command !== "string" || commandValue.command.trim().length === 0) {
          diagnostics.push(diagnostic(`${scope}.${eventName}[${groupIndex}].hooks[${commandIndex}]`, new Error("only non-empty command hooks are supported")));
          continue;
        }
        hooks.push(Object.freeze({
          event: eventName,
          ...(matcher === undefined ? {} : { matcher }),
          command: commandValue.command,
          timeoutMs: timeoutMilliseconds(commandValue.timeout),
        }));
      }
    }
  }
  return { hooks, diagnostics };
}

async function declaredPath(root: string, value: unknown, scope: string): Promise<string | undefined> {
  if (typeof value !== "string") return undefined;
  return resolveContainedExistingPath(root, value, scope);
}

async function readManifest(root: string, relativePath: string, diagnostics: PluginDiagnostic[]): Promise<Record<string, unknown> | undefined> {
  const path = join(root, relativePath);
  const result = await optionalJson(path);
  if (result.error !== undefined) {
    diagnostics.push(diagnostic(`${relativePath}`, result.error));
    return undefined;
  }
  if (result.value === undefined) return undefined;
  if (!record(result.value)) {
    diagnostics.push(diagnostic(relativePath, new Error("plugin manifest must be an object")));
    return undefined;
  }
  return result.value;
}

async function discoverPlugin(root: string, marketplace: string, name: string, data: string): Promise<DiscoveredPlugin> {
  const diagnostics: PluginDiagnostic[] = [];
  try {
    await assertNoSymlinks(root);
  } catch (error) {
    diagnostics.push(diagnostic("bundle", error));
    return Object.freeze({
      info: Object.freeze({ marketplace, name, root, data, enabled: false, autoUpdate: false }),
      skillPaths: [],
      skillNames: [],
      hooks: [],
      diagnostics: Object.freeze(diagnostics),
    });
  }
  const receiptResult = await optionalJson(join(root, ".pi-plugin.json"));
  if (receiptResult.error !== undefined) diagnostics.push(diagnostic(".pi-plugin.json", receiptResult.error));
  const receipt = record(receiptResult.value) ? Object.freeze({ ...receiptResult.value }) : undefined;
  const disabled = await isFile(join(root, ".disabled"));
  const autoUpdate = await isFile(join(root, ".auto-update"));
  const info: InstalledPluginInfo = Object.freeze({
    marketplace,
    name,
    root,
    data,
    enabled: !disabled,
    autoUpdate,
    ...(receipt === undefined ? {} : { receipt }),
  });
  if (disabled) return Object.freeze({ info, skillPaths: [], skillNames: [], hooks: [], diagnostics: Object.freeze(diagnostics) });

  const skillNames = await discoverSkillNames(root);
  const skillPaths: string[] = [];
  if (skillNames.includes("root")) skillPaths.push(root);
  if (skillNames.some((name) => name === "skills" || name.startsWith("skills/"))) skillPaths.push(join(root, "skills"));

  const manifests: Record<string, unknown>[] = [];
  for (const relativePath of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const manifest = await readManifest(root, relativePath, diagnostics);
    if (manifest !== undefined) manifests.push(manifest);
  }

  const hookPaths = new Set<string>();
  const conventionalHooks = join(root, "hooks/hooks.json");
  if (await isFile(conventionalHooks)) hookPaths.add(conventionalHooks);
  for (const manifest of manifests) {
    if (typeof manifest.hooks === "string") {
      try {
        hookPaths.add(await declaredPath(root, manifest.hooks, "manifest hooks path") ?? "");
      } catch (error) {
        diagnostics.push(diagnostic("manifest hooks path", error));
      }
    }
  }
  const hooks: PluginHookCommand[] = [];
  for (const path of hookPaths) {
    if (path.length === 0) continue;
    const result = await optionalJson(path);
    if (result.error !== undefined) {
      diagnostics.push(diagnostic(path, result.error));
      continue;
    }
    if (result.value === undefined) continue;
    try {
      const parsed = parseHooks(result.value, path);
      hooks.push(...parsed.hooks);
      diagnostics.push(...parsed.diagnostics);
    } catch (error) {
      diagnostics.push(diagnostic(path, error));
    }
  }

  const mcpDocuments: { source: string; value: unknown }[] = [];
  const loadedMcpPaths = new Set<string>();
  const conventionalMcp = join(root, ".mcp.json");
  if (await isFile(conventionalMcp)) {
    mcpDocuments.push({ source: ".mcp.json", value: conventionalMcp });
    loadedMcpPaths.add(conventionalMcp);
  }
  // Manifest order is precedence order: the Claude document is the richer
  // declaration (variable substitution, relative-path roots), so a same-named
  // server in a later Codex manifest pointer must not clobber it.
  for (const manifest of manifests) {
    const declaration = manifest.mcpServers ?? manifest.mcp;
    if (typeof declaration === "string") {
      try {
        const path = await declaredPath(root, declaration, "manifest MCP path");
        if (path === undefined) continue;
        // Several manifests may point at one physical document; that is one
        // declaration, not a conflict, so skip it without a diagnostic.
        if (loadedMcpPaths.has(path)) continue;
        loadedMcpPaths.add(path);
        mcpDocuments.push({ source: declaration, value: path });
      } catch (error) {
        diagnostics.push(diagnostic("manifest MCP path", error));
      }
    } else if (record(declaration)) {
      mcpDocuments.push({ source: "manifest", value: declaration });
    }
  }
  const mcpServers: Record<string, unknown> = {};
  for (const document of mcpDocuments) {
    let value: unknown = document.value;
    if (typeof document.value === "string") {
      const result = await optionalJson(document.value);
      if (result.error !== undefined) {
        diagnostics.push(diagnostic(document.source, result.error));
        continue;
      }
      value = result.value;
    }
    if (!record(value)) {
      diagnostics.push(diagnostic("MCP", new Error("MCP document must be an object")));
      continue;
    }
    const servers = record(value.mcpServers) ? value.mcpServers : value;
    for (const [serverName, server] of Object.entries(servers)) {
      if (!record(server)) {
        diagnostics.push(diagnostic(`MCP.${serverName}`, new Error("MCP server declaration must be an object")));
        continue;
      }
      if (serverName in mcpServers) {
        diagnostics.push(diagnostic(`MCP.${serverName}`, new Error(`duplicate MCP server declaration from ${document.source}; the earlier declaration wins`)));
        continue;
      }
      mcpServers[serverName] = server;
    }
  }

  return Object.freeze({
    info,
    skillPaths: Object.freeze(skillPaths),
    skillNames,
    hooks: Object.freeze(hooks),
    ...(Object.keys(mcpServers).length === 0 ? {} : { mcp: Object.freeze(mcpServers) }),
    diagnostics: Object.freeze(diagnostics),
  });
}

export async function scanInstalledPlugins(paths: PluginHostPaths): Promise<RuntimeSnapshot> {
  const plugins: DiscoveredPlugin[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  let marketplaces: string[] = [];
  try { marketplaces = (await readdir(paths.plugins, { withFileTypes: true })).filter((item) => item.isDirectory() && !item.isSymbolicLink() && !item.name.startsWith(".")).map((item) => item.name); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(diagnostic("plugins", error));
  }
  for (const marketplace of marketplaces.sort()) {
    let pluginEntries;
    try { pluginEntries = await readdir(join(paths.plugins, marketplace), { withFileTypes: true }); } catch (error) {
      diagnostics.push(diagnostic(`plugins/${marketplace}`, error));
      continue;
    }
    for (const entry of pluginEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const name = assertSafeName(entry.name, "plugin name");
        const root = await realpath(join(paths.plugins, marketplace, name));
        const data = join(paths.data, marketplace, name);
        await mkdir(data, { recursive: true });
        const discovered = await discoverPlugin(root, marketplace, name, data);
        plugins.push(discovered);
        diagnostics.push(...discovered.diagnostics);
      } catch (error) {
        diagnostics.push(diagnostic(`${marketplace}/${entry.name}`, error));
      }
    }
  }
  const skillPaths = [...new Set(plugins.filter((plugin) => plugin.info.enabled).flatMap((plugin) => plugin.skillPaths))];
  return Object.freeze({
    plugins: Object.freeze(plugins),
    skillPaths: Object.freeze(skillPaths),
    diagnostics: Object.freeze(diagnostics),
  });
}
