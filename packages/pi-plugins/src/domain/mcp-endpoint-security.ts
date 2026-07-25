import { z } from "zod";
import { parseMcpTemplateTokens } from "./mcp-late-values.js";
import { isSensitiveQueryName } from "./sensitive-fields.js";

export const McpEndpointSecuritySchema = z.enum([
  "tls",
  "consent-bound-loopback-plaintext",
]);
export type McpEndpointSecurity = z.infer<typeof McpEndpointSecuritySchema>;

export type McpEndpointAnalysis = Readonly<{
  url: URL;
  security: McpEndpointSecurity;
  effectivePort: string;
}>;

function literalLoopback(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
  if (host === "::1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255) && Number(parts[0]) === 127;
}

function tokensStayInQuery(value: string): boolean {
  const query = value.indexOf("?");
  if (query < 0) return parseMcpTemplateTokens(value).length === 0;
  const fragment = value.indexOf("#", query + 1);
  let cursor = 0;
  for (const token of parseMcpTemplateTokens(value)) {
    const start = value.indexOf(token.raw, cursor);
    if (start <= query || fragment >= 0 && start >= fragment) return false;
    cursor = start + token.raw.length;
  }
  return true;
}

/**
 * Parse the exact non-secret endpoint authority disclosed during consent.
 * Templates may occur only in an HTTPS query value; scheme, host, port, and
 * path are therefore stable before any credential is resolved.
 */
export function analyzeMcpEndpoint(value: string): McpEndpointAnalysis | undefined {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  let parsed: URL;
  try {
    if (!tokensStayInQuery(value)) return undefined;
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) return undefined;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/u.test(decodedPath)) return undefined;

  if (parsed.protocol === "https:") {
    return Object.freeze({ url: parsed, security: "tls", effectivePort: parsed.port || "443" });
  }
  if (!literalLoopback(parsed.hostname) || parseMcpTemplateTokens(value).length > 0 ||
      [...parsed.searchParams].some(([name]) => isSensitiveQueryName(name))) return undefined;
  return Object.freeze({
    url: parsed,
    security: "consent-bound-loopback-plaintext",
    effectivePort: parsed.port || "80",
  });
}
