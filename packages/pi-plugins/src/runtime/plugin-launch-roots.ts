/** Root names shared by guarded hooks and immediate MCP launch rendering. */
export const PluginLaunchRootRegistry = {
  CLAUDE_PLUGIN_ROOT: true,
  PLUGIN_ROOT: true,
  CLAUDE_PLUGIN_DATA: true,
  PLUGIN_DATA: true,
  CLAUDE_PROJECT_DIR: true,
} as const;

export type PluginLaunchRootName = keyof typeof PluginLaunchRootRegistry;
export type PluginLaunchRootValues = Readonly<Record<PluginLaunchRootName, string>>;

export function isPluginLaunchRootName(value: string): value is PluginLaunchRootName {
  return Object.prototype.hasOwnProperty.call(PluginLaunchRootRegistry, value);
}
