import {
  CLAUDE_PLUGIN_MANIFEST_PATH,
  readManifestRecord,
  type PluginManifestReader,
} from "../plugin-manifest.js";
import { readClaudeUserConfig } from "./user-config-reader.js";

const CLAUDE_RUNTIME_FIELDS = new Set([
  "agents",
  "commands",
  "dependencies",
  "lspServers",
  "outputStyles",
  "settings",
  "themes",
  "channels",
  "userConfig",
  "strict",
]);

/** Pure Claude plugin.json reader. JSON decoding is deliberately external. */
export const readClaudePluginManifest: PluginManifestReader = (input, context) => {
  const result = readManifestRecord(input, context, {
    nativeHost: "claude",
    operation: "readClaudePluginManifest",
    runtimeFields: CLAUDE_RUNTIME_FIELDS,
  });
  if (!result.ok) return result;

  if (input === null || typeof input !== "object" || Array.isArray(input)) return result;
  const userConfig = (input as { readonly userConfig?: unknown }).userConfig;
  if (userConfig === undefined) return result;
  const configuration = readClaudeUserConfig(userConfig, {
    plugin: context.plugin,
    path: context.path,
    pointer: "/userConfig",
  });
  if (!configuration.ok) return configuration;
  return {
    ok: true,
    value: {
      ...result.value,
      configuration: configuration.value.options,
      // The manifest reader's generic runtime fallback retains unknown fields
      // as foreign declarations. userConfig has a dedicated descriptor reader,
      // so do not duplicate it as an opaque runtime declaration.
      foreign: result.value.foreign.filter((item) => item.nativeKind.value !== "userConfig"),
    },
    diagnostics: result.diagnostics,
  };
};

export { CLAUDE_PLUGIN_MANIFEST_PATH };
