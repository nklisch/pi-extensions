// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  try {
    return jsonValuesEqual(parsed, value);
  } catch {
    // Deduplication requires proven equality. If comparison fails, preserve
    // the structured facts through the normal serialization path; that path
    // reports presentation unavailability if serialization also fails.
    return false;
  }
}

/**
 * Depth-tolerant equality for JSON-decoded values. Both sides come from JSON
 * (wire text and SDK decode), so plain objects/arrays/primitives suffice; an
 * explicit worklist keeps arbitrarily deep structures from exhausting the
 * stack, and key order is irrelevant. This is a transport-value comparison,
 * not a general object framework.
 */
function jsonValuesEqual(a: unknown, b: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    if (x === y) continue;
    if (
      x === null || y === null ||
      typeof x !== "object" || typeof y !== "object"
    ) {
      if (x !== y) return false;
      continue;
    }
    const xIsArray = Array.isArray(x);
    const yIsArray = Array.isArray(y);
    if (xIsArray !== yIsArray) return false;
    if (xIsArray && yIsArray) {
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) stack.push([x[i], y[i]]);
      continue;
    }
    const xRecord = x as Record<string, unknown>;
    const yRecord = y as Record<string, unknown>;
    const xKeys = Object.keys(xRecord);
    const yKeys = Object.keys(yRecord);
    if (xKeys.length !== yKeys.length) return false;
    for (const key of xKeys) {
      if (!Object.hasOwn(yRecord, key)) return false;
      stack.push([xRecord[key], yRecord[key]]);
    }
  }
  return true;
}

function stringifyStructuredContent(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
