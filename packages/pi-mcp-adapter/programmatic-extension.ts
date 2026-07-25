import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpSourceIdentity, McpSourceStatus } from "./programmatic-types.ts";
import { ProgrammaticMcpRuntime } from "./programmatic-runtime.ts";

/**
 * Tool results are read by people in the transcript, not just by the model:
 * status/capabilities/list render as one to three short lines each. Full
 * structured payloads stay available on `details` for renderers; the text
 * content never carries raw JSON specs.
 */
function oneLine(value: string | undefined, max = 80): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function textResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function formatStatus(sources: readonly McpSourceStatus[]): string {
  const servers = sources.flatMap((source) =>
    source.servers.map((server) => ({ plugin: source.identity.plugin, ...server })),
  );
  if (servers.length === 0) return "MCP: no servers configured";
  const ready = servers.filter((server) => server.state === "connected").length;
  const tools = servers.reduce((sum, server) => sum + (server.toolCount ?? 0), 0);
  const lines = [`MCP: ${ready}/${servers.length} servers connected · ${tools} tools`];
  const named = sources.length > 1;
  for (const server of servers) {
    const name = `${named ? `${server.plugin} · ` : ""}${server.nativeKey} · ${server.key}`;
    if (server.state === "connected") lines.push(`✓ ${name} (${server.toolCount ?? 0} tools)`);
    else if (server.state === "needs-auth") lines.push(`⚠ ${name} (needs authentication)`);
    else if (server.state === "failed") lines.push(`✗ ${name} (didn't start${server.errorCode === undefined ? "" : ` — ${oneLine(server.errorCode, 48)}`})`);
    else lines.push(`○ ${name} (${server.state})`);
  }
  return lines.join("\n");
}

function formatCapabilities(capabilities: unknown): string {
  const value = capabilities as {
    transports?: Record<string, boolean>;
    oauth?: Record<string, boolean>;
    sourceLifecycle?: Record<string, boolean>;
  };
  const transports = Object.entries(value.transports ?? {}).filter(([, yes]) => yes).map(([name]) => name);
  const oauth = Object.values(value.oauth ?? {}).some(Boolean);
  return `MCP runtime ready · transports: ${transports.join(", ") || "none"} · OAuth: ${oauth ? "yes" : "no"} · atomic source lifecycle`;
}

function formatToolList(server: string, tools: readonly { name: string; description?: string }[]): string {
  if (tools.length === 0) return `No tools on ${server}.`;
  const lines = [`${tools.length} tool${tools.length === 1 ? "" : "s"} on ${server}:`];
  for (const tool of tools) {
    const description = oneLine(tool.description, 72);
    lines.push(`- ${tool.name}${description.length === 0 ? "" : ` — ${description}`}`);
  }
  return lines.join("\n");
}

function formatSearch(
  query: string,
  result: Readonly<{
    matches: readonly Readonly<{ server: string; name: string; description?: string }>[];
    unavailableServers: readonly string[];
  }>,
): string {
  const lines: string[] = [];
  if (result.matches.length === 0) lines.push(`No tools matching "${oneLine(query, 48)}".`);
  else {
    lines.push(`${result.matches.length} tool${result.matches.length === 1 ? "" : "s"} matching "${oneLine(query, 48)}":`);
    for (const match of result.matches) {
      const description = oneLine(match.description, 64);
      lines.push(`- ${match.server} · ${match.name}${description.length === 0 ? "" : ` — ${description}`}`);
    }
  }
  if (result.unavailableServers.length > 0) {
    lines.push(`(${result.unavailableServers.length} server${result.unavailableServers.length === 1 ? "" : "s"} couldn't be searched: ${result.unavailableServers.join(", ")})`);
  }
  return lines.join("\n");
}

function safeFailure(error: unknown, signal?: AbortSignal) {
  const code = signal?.aborted
    ? "MCP_LAUNCH_CANCELLED"
    : error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "ADAPTER_FAILED";
  const text = code === "SOURCE_INVALID"
    ? "That MCP server isn't registered (it may have been replaced or removed)."
    : code === "SEARCH_INVALID"
      ? "That search query isn't usable — keep it under 256 characters (and a valid regex)."
      : code === "MCP_LAUNCH_CANCELLED"
        ? "The MCP operation was cancelled."
        : `The MCP operation couldn't be completed (${oneLine(code, 48)}).`;
  return {
    content: [{ type: "text" as const, text }],
    details: { error: code },
  };
}

function parseIdentity(value: string | undefined): McpSourceIdentity | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("source identity must be an object");
  }
  return parsed as McpSourceIdentity;
}

/** Register the source-qualified proxy used by programmatic adapter instances. */
export function registerProgrammaticExtension(
  pi: ExtensionAPI,
  runtime: ProgrammaticMcpRuntime,
  toolName: "mcp" | "mcp_sources",
): void {
  let generation = 0;

  pi.on("session_start", async (_event, context) => {
    const current = ++generation;
    await runtime.attachSession(context);
    if (current !== generation) await runtime.detachSession();
  });

  pi.on("session_shutdown", async () => {
    ++generation;
    await runtime.detachSession();
  });

  (pi.registerTool as (tool: unknown) => unknown)({
    name: toolName,
    label: toolName === "mcp" ? "MCP" : "MCP Sources",
    description: "Source-qualified MCP gateway for programmatic configuration sources",
    promptSnippet: "MCP gateway for isolated programmatic sources",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("status"),
        Type.Literal("capabilities"),
        Type.Literal("list"),
        Type.Literal("search"),
        Type.Literal("call"),
      ])),
      source: Type.Optional(Type.String({
        description: "Exact McpSourceIdentity encoded as JSON",
      })),
      server: Type.Optional(Type.String({ description: "Source-local server key" })),
      tool: Type.Optional(Type.String({ description: "Native MCP tool name" })),
      args: Type.Optional(Type.String({ description: "Tool arguments encoded as a JSON object" })),
      query: Type.Optional(Type.String({ description: "Search text for tool names/descriptions" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression (default: substring match)" })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        action?: "status" | "capabilities" | "list" | "search" | "call";
        source?: string;
        server?: string;
        tool?: string;
        args?: string;
        query?: string;
        regex?: boolean;
      },
      signal?: AbortSignal,
    ) {
      const operationSignal = signal ?? new AbortController().signal;
      try {
        operationSignal.throwIfAborted();
        const action = params.action ?? "status";
        if (action === "status") {
          const sources = await runtime.inspectSources(operationSignal);
          return textResult(formatStatus(sources), { mode: "status", sources });
        }
        if (action === "capabilities") {
          const capabilities = await runtime.capabilities(operationSignal);
          return textResult(formatCapabilities(capabilities), { mode: "capabilities" });
        }
        const identity = parseIdentity(params.source);
        if (action === "search") {
          if (params.query === undefined || params.query.length === 0) throw new Error("query is required for search");
          const result = await runtime.searchTools(identity, params.query, { regex: params.regex === true }, operationSignal);
          return textResult(formatSearch(params.query, result), {
            mode: "search",
            query: params.query,
            matches: result.matches.map((match) => ({ server: match.server, name: match.name })),
            count: result.matches.length,
            unavailableServers: result.unavailableServers,
          });
        }
        if (params.server === undefined) throw new Error("server key is required (see status output; no source JSON needed)");
        if (action === "list") {
          const tools = await runtime.listTools(identity, params.server, operationSignal);
          return textResult(
            formatToolList(params.server, tools),
            { mode: "list", server: params.server, tools: tools.map((tool) => ({ name: tool.name })), count: tools.length },
          );
        }
        if (params.tool === undefined) throw new Error("tool name is required");
        let args: Record<string, unknown> = {};
        if (params.args !== undefined) {
          const parsed = JSON.parse(params.args);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("tool arguments must be an object");
          }
          args = parsed as Record<string, unknown>;
        }
        const result = await runtime.callTool(identity, params.server, params.tool, args, operationSignal);
        return {
          content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (error) {
        return safeFailure(error, operationSignal);
      }
    },
  });
}
