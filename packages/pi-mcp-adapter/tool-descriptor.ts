import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { isServerDisabled } from "./types.ts";
import { renderTsShape } from "./ts-shape.ts";
import { serverAvailability } from "./server-availability.ts";

/** Resolve identity before availability: an outage must not redirect a name. */
export function resolveToolMetadata(state: McpExtensionState, name: string, server?: string) {
  const candidates = [...state.toolMetadata].flatMap(([owner, tools]) =>
    server && server !== owner ? [] : tools.map(tool => ({ server: owner, tool })));
  const enabled = candidates.filter(value => !isServerDisabled(state.config.mcpServers[value.server]));
  const pool = enabled.length ? enabled : candidates;
  const exact = pool.filter(value => value.tool.name === name);
  const native = server ? pool.filter(value => value.tool.originalName === name) : [];
  return exact.length ? exact : native.length ? native : pool.filter(value => value.tool.name.replace(/-/g, "_") === name.replace(/-/g, "_"));
}
export function toolDescriptor(state: McpExtensionState, server: string, tool: ToolMetadata) {
  const inputSchema = tool.resourceUri ? { type: "object", properties: {}, additionalProperties: false } : tool.inputSchema;
  const preview = inputSchema === undefined ? null : renderTsShape(inputSchema);
  return {
    path: tool.name, name: tool.originalName, server,
    ...(tool.description ? { description: tool.description } : {}),
    ...(preview ? { inputTypeScript: preview } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(tool.outputSchema !== undefined ? { outputSchemaTarget: "data.structuredContent", outputSchema: tool.outputSchema } : {}),
    availability: serverAvailability(state, server),
  };
}
/** Retain references and unknown keywords instead of inventing a schema dialect. */
export function exactSchema(schema: unknown): string {
  return JSON.stringify(schema, null, 2) ?? "null";
}
