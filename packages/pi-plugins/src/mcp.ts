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
      values.set(name, substitute(definition, variables));
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
