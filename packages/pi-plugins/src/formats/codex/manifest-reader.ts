import {
  CODEX_PLUGIN_MANIFEST_PATH,
  readManifestRecord,
  type PluginManifestReader,
} from "../plugin-manifest.js";

const CODEX_RUNTIME_FIELDS = new Set([
  "agents",
  "apps",
  "channels",
  "commands",
  "connectors",
  "dependencies",
  "lspServers",
  "outputStyles",
  "settings",
  "themes",
  "userConfig",
]);

/** Pure Codex plugin.json reader. JSON decoding is deliberately external. */
export const readCodexPluginManifest: PluginManifestReader = (input, context) =>
  readManifestRecord(input, context, {
    nativeHost: "codex",
    operation: "readCodexPluginManifest",
    runtimeFields: CODEX_RUNTIME_FIELDS,
  });

export { CODEX_PLUGIN_MANIFEST_PATH };
