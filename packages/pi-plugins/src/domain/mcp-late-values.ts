export type McpTemplateToken = Readonly<{
  raw: string;
  body: string;
  kind: "configuration" | "environment";
  name: string;
}>;

const MCP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_VALUE_REFERENCE = /^\$\{(?:user_config\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Parse the one non-recursive placeholder grammar accepted by durable templates. */
export function parseMcpTemplateTokens(template: string): readonly McpTemplateToken[] {
  if (typeof template !== "string" || template.includes("\0")) throw new Error("invalid MCP template");
  const tokens: McpTemplateToken[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("${", cursor);
    if (start < 0) break;
    const end = template.indexOf("}", start + 2);
    if (end < 0) throw new Error("invalid MCP template");
    const body = template.slice(start + 2, end);
    if (body.length === 0 || body.includes("${") || body.includes("{") || body.includes("}")) {
      throw new Error("invalid MCP template");
    }
    const raw = template.slice(start, end + 1);
    if (body.startsWith("user_config.")) {
      const name = body.slice("user_config.".length);
      if (!MCP_NAME.test(name)) throw new Error("invalid MCP template");
      tokens.push({ raw, body, kind: "configuration", name });
    } else {
      if (!MCP_NAME.test(body)) throw new Error("invalid MCP template");
      tokens.push({ raw, body, kind: "environment", name: body });
    }
    cursor = end + 1;
  }
  return Object.freeze(tokens);
}

export function isPortableMcpValueReference(value: string): boolean {
  return MCP_VALUE_REFERENCE.test(value);
}

/** Sensitive headers may carry only a late-bound value, never durable plaintext. */
export function isPortableMcpHeaderCredential(name: string, value: string): boolean {
  if (isPortableMcpValueReference(value) ||
      /^(?:bearer|basic)\s+\$\{(?:user_config\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)\}$/i.test(value)) {
    return true;
  }
  if (!/^cookies?$/i.test(name)) return false;
  const entries = value.split(";");
  return entries.length > 0 && entries.every((entry) => {
    const separator = entry.indexOf("=");
    return separator > 0 && isPortableMcpValueReference(entry.slice(separator + 1).trim());
  });
}
