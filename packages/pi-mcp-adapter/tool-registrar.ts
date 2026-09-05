// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

import { isDeepStrictEqual } from "node:util";
import type { McpContent, ContentBlock } from "./types.ts";

const STRUCTURED_CONTENT_LABEL = "[Structured content]";
const STRUCTURED_CONTENT_UNAVAILABLE = "[Structured content could not be presented: the server sent data this adapter cannot serialize.]";

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpContent(content: McpContent[]): ContentBlock[] {
  return content.map(c => {
    if (c.type === "text") {
      return { type: "text" as const, text: c.text ?? "" };
    }
    if (c.type === "image") {
      return {
        type: "image" as const,
        data: c.data ?? "",
        mimeType: c.mimeType ?? "image/png",
      };
    }
    if (c.type === "resource") {
      const resourceUri = c.resource?.uri ?? "(no URI)";
      const resourceContent = c.resource?.text ?? (c.resource ? JSON.stringify(c.resource) : "(no content)");
      return {
        type: "text" as const,
        text: `[Resource: ${resourceUri}]\n${resourceContent}`,
      };
    }
    if (c.type === "resource_link") {
      const linkName = c.name ?? c.uri ?? "unknown";
      const linkUri = c.uri ?? "(no URI)";
      return {
        type: "text" as const,
        text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
      };
    }
    if (c.type === "audio") {
      return {
        type: "text" as const,
        text: `[Audio content: ${c.mimeType ?? "audio/*"}]`,
      };
    }
    return { type: "text" as const, text: JSON.stringify(c) };
  });
}

/**
 * Resolve a tool result's content blocks, falling back to structuredContent
 * when content is empty and appending structuredContent as distinct text when
 * content is present.
 *
 * A result may carry both: a human summary in `content` and distinct facts in
 * `structuredContent`. Dropping the structured half just because a summary
 * exists loses facts the model cannot recover, so the serialized value is
 * appended as its own text block — unless a whole existing text block already
 * represents the same JSON value (servers commonly echo it as text), in which
 * case appending would only duplicate output. Prose, substrings, and partial
 * objects never count as delivered: the whole block must parse as JSON and
 * compare deeply equal.
 */
export function resolveMcpResultContent(result: Record<string, unknown>): ContentBlock[] {
  const blocks = transformMcpContent((Array.isArray(result.content) ? result.content : []) as McpContent[]);
  const structured = result.structuredContent;

  if (structured === undefined || structured === null) return blocks;
  if (blocks.length === 0) {
    return [{ type: "text" as const, text: stringifyStructuredContent(structured) }];
  }

  const alreadyDelivered = blocks.some(
    (block) => block.type === "text" && textIsSameJsonValue(block.text, structured),
  );
  if (alreadyDelivered) return blocks;

  let serialized: string;
  try {
    serialized = JSON.stringify(structured, null, 2);
  } catch {
    // The structured facts exist but cannot be rendered (e.g. a circular
    // structure). Say so explicitly instead of failing the whole tool call —
    // the raw result still carries the value in details.mcpResult.
    return [...blocks, { type: "text" as const, text: STRUCTURED_CONTENT_UNAVAILABLE }];
  }
  // JSON.stringify only returns undefined for values with no JSON
  // representation at all; structuredContent is an object here, so this is
  // defensive rather than an expected path.
  if (serialized === undefined) {
    return [...blocks, { type: "text" as const, text: STRUCTURED_CONTENT_UNAVAILABLE }];
  }
  return [...blocks, { type: "text" as const, text: `${STRUCTURED_CONTENT_LABEL}\n${serialized}` }];
}

function textIsSameJsonValue(text: string, value: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(text), value);
  } catch {
    return false;
  }
}

function stringifyStructuredContent(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
