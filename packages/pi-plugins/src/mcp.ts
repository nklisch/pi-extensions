import { isAbsolute, resolve } from "node:path";
import type { RuntimeSnapshot } from "./types.js";

const VARIABLE_NAMES = [
  "PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "PLUGIN_DATA",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PROJECT_DIR",
] as const;

function substitute(value: unknown, variables: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR)\}/gu, (_whole, name: string) => variables[name] ?? _whole);
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, variables)]));
  }
  return value;
}

function namespace(plugin: RuntimeSnapshot["plugins"][number], server: string): string {
  return `${plugin.info.name}_${plugin.info.marketplace}_${server}`.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/**
 * Anchor stdio servers to the plugin root and give their child process the
 * same opaque Pi session identity used by hooks. Codex-style declarations
 * commonly use cwd-relative commands (`sh bin/launcher`), and pi launches MCP
 * children from the project directory. The `$env:` values are resolved by
 * pi-mcp-adapter when the child starts, after SessionStart has published the
 * current identity. A declaration's own relative `cwd` and env are preserved;
 * absolute paths and non-stdio servers are left untouched.
 */
function resolvePluginStdioCwd(definition: unknown, pluginRoot: string): unknown {
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) return definition;
  const server = definition as Record<string, unknown>;
  if (typeof server.command !== "string" || server.command.length === 0) return definition;
  const declared = typeof server.cwd === "string" && server.cwd.trim().length > 0 ? server.cwd : ".";
  const resolved = isAbsolute(declared) || declared.startsWith("~") ? declared : resolve(pluginRoot, declared);
  const declaredEnv = server.env !== null && typeof server.env === "object" && !Array.isArray(server.env)
    ? server.env as Record<string, unknown>
    : {};
  return {
    ...server,
    cwd: resolved,
    env: {
      ...declaredEnv,
      PI_SESSION_ID: "$env:PI_PLUGIN_SESSION_ID",
      CLAUDE_SESSION_ID: "$env:PI_PLUGIN_SESSION_ID",
    },
  };
}

/** Build the only MCP input this package gives to pi-mcp-adapter. */
export async function buildMcpConfig(snapshot: RuntimeSnapshot): Promise<Readonly<{ mcpServers: Readonly<Record<string, unknown>> }>> {
  const plugins = snapshot.plugins.filter((item) => item.info.enabled && item.mcp !== undefined);
  const occurrences = new Map<string, number>();
  for (const plugin of plugins) {
    for (const serverName of Object.keys(plugin.mcp!)) {
      occurrences.set(serverName, (occurrences.get(serverName) ?? 0) + 1);
    }
  }

  const values = new Map<string, unknown>();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  for (const plugin of plugins) {
    const variables = Object.freeze({
      PLUGIN_ROOT: plugin.info.root,
      CLAUDE_PLUGIN_ROOT: plugin.info.root,
      PLUGIN_DATA: plugin.info.data,
      CLAUDE_PLUGIN_DATA: plugin.info.data,
      CLAUDE_PROJECT_DIR: projectDir,
    });
    for (const [serverName, definition] of Object.entries(plugin.mcp!)) {
      const name = occurrences.get(serverName) === 1 ? serverName : namespace(plugin, serverName);
      values.set(name, resolvePluginStdioCwd(substitute(definition, variables), plugin.info.root));
    }
  }
  return Object.freeze({ mcpServers: Object.freeze(Object.fromEntries(values)) });
}

export function substitutePluginVariables(value: unknown, variables: Readonly<Record<string, string>>): unknown {
  // Keep the exported helper deliberately constrained to the five documented
  // roots; callers cannot accidentally turn this into shell interpolation.
  const allowed = Object.fromEntries(VARIABLE_NAMES.map((name) => [name, variables[name] ?? `\${${name}}`])) as Record<string, string>;
  return substitute(value, allowed);
}
