import type { McpDocumentReader } from "../mcp-reader-support.js";
import { readMcpDocument } from "../mcp-reader-support.js";

/** Pure Claude MCP shape reader. Server declarations remain opaque JSON. */
export const readClaudeMcp: McpDocumentReader = (input, context) =>
  readMcpDocument("readClaudeMcp", input, context, "claude");

export const readClaudeMcpDocument = readClaudeMcp;

export type { McpDocumentReader } from "../mcp-reader-support.js";
