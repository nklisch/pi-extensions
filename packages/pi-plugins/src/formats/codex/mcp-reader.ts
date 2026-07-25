import type { McpDocumentReader } from "../mcp-reader-support.js";
import { readMcpDocument } from "../mcp-reader-support.js";

/** Pure Codex MCP shape reader. Server declarations remain opaque JSON. */
export const readCodexMcp: McpDocumentReader = (input, context) =>
  readMcpDocument("readCodexMcp", input, context, "codex");

export const readCodexMcpDocument = readCodexMcp;

export type { McpDocumentReader } from "../mcp-reader-support.js";
