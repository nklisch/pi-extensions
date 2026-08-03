import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import type { McpSourceIdentity, McpSourceStatus } from "./programmatic-types.ts";
import { ProgrammaticMcpRuntime } from "./programmatic-runtime.ts";
import { resolveMcpResultContent } from "./tool-registrar.ts";

/**
 * Tool results are read by people in the transcript, not just by the model:
 * status/capabilities/list render as one to three short lines each. Full
 * structured payloads stay available on `details` for renderers; the text
 * content never carries raw JSON specs — with one deliberate exception: the
 * schema action exists to hand the model exact input schemas, so its text
 * output is the raw JSON the model must reproduce.
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

function formatToolList(
  server: string,
  tools: readonly { name: string; description?: string }[],
  toolName: string,
): string {
  if (tools.length === 0) return `No tools on ${server}.`;
  const lines = [`${tools.length} tool${tools.length === 1 ? "" : "s"} on ${server}:`];
  for (const tool of tools) {
    const description = oneLine(tool.description, 72);
    lines.push(`- ${tool.name}${description.length === 0 ? "" : ` — ${description}`}`);
  }
  lines.push(`Load exact input schemas before first use: ${toolName}({action:"schema",server:"${server}",tool:["<name>",...]})`);
  return lines.join("\n");
}

function formatSearch(
  query: string,
  result: Readonly<{
    matches: readonly Readonly<{ server: string; nativeKey?: string; name: string; description?: string }>[];
    unavailableServers: readonly string[];
  }>,
): string {
  const lines: string[] = [];
  if (result.matches.length === 0) lines.push(`No tools matching "${oneLine(query, 48)}".`);
  else {
    lines.push(`${result.matches.length} tool${result.matches.length === 1 ? "" : "s"} matching "${oneLine(query, 48)}":`);
    for (const match of result.matches) {
      const description = oneLine(match.description, 64);
      // Show the human-readable native key; the opaque source-local key stays
      // available in details for callers that need exact addressing.
      lines.push(`- ${match.nativeKey ?? match.server} · ${match.name}${description.length === 0 ? "" : ` — ${description}`}`);
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
      : undefined;
  // Plain (code-less) errors inside execute are local argument-validation
  // failures — "server key is required", malformed JSON, an array passed to
  // call. Their messages are the guidance the caller needs, so surface them
  // instead of the generic adapter failure.
  if (code === undefined) {
    const message = error instanceof Error && error.message.length > 0
      ? error.message
      : "The MCP operation couldn't be completed.";
    return {
      content: [{ type: "text" as const, text: message }],
      details: { error: "INVALID_ARGUMENTS" },
    };
  }
  const text = code === "SOURCE_INVALID"
    ? "That MCP server isn't registered (or the name is ambiguous). Use the server's display name or its mcp-server-v1:… key from the status or search action."
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

function formatSchemas(
  server: string,
  result: Readonly<{
    schemas: readonly Readonly<{ name: string; description?: string; inputSchema?: unknown }>[];
    missing: readonly string[];
  }>,
): string {
  const lines: string[] = [];
  for (const tool of result.schemas) {
    lines.push(`### ${tool.name} (${server})`);
    if (tool.description !== undefined && tool.description.length > 0) lines.push(tool.description);
    lines.push("```json", JSON.stringify(tool.inputSchema ?? null, null, 2), "```", "");
  }
  if (result.schemas.length === 0) lines.push(`None of the requested tools exist on ${server}.`);
  if (result.missing.length > 0) lines.push(`Not found on ${server}: ${result.missing.join(", ")}`);
  return lines.join("\n").trim();
}

/** Per-server collapse: past this many tools, names move behind list. */
const PROMPT_SERVER_COLLAPSE_TOOLS = 50;
/** Global name budget across all servers in the discovery block. */
const PROMPT_TOTAL_NAME_BUDGET = 300;

/**
 * Render the system-prompt discovery block: every server's full tool-name
 * list from the warmed inventory (no server launches), plus one line of
 * usage guidance. Servers nobody has ever reached show an honest "not yet
 * enumerated" marker with the exact list command that warms them.
 */
async function buildDiscoveryBlock(
  runtime: ProgrammaticMcpRuntime,
  toolName: string,
): Promise<string | undefined> {
  const sources = await runtime.inspectSources(new AbortController().signal);
  if (sources.length === 0) return undefined;

  // A nativeKey shared by two sources cannot resolve by name; point examples
  // at the unambiguous source-local key for those servers only.
  const nameCounts = new Map<string, number>();
  for (const source of sources) {
    for (const server of source.servers) {
      nameCounts.set(server.nativeKey, (nameCounts.get(server.nativeKey) ?? 0) + 1);
    }
  }

  const lines = [`## MCP servers available through the \`${toolName}\` tool`];
  let budget = PROMPT_TOTAL_NAME_BUDGET;
  for (const source of sources) {
    for (const server of source.servers) {
      const label = sources.length > 1 ? `${source.identity.plugin} · ${server.nativeKey}` : server.nativeKey;
      const token = (nameCounts.get(server.nativeKey) ?? 0) > 1 ? server.key : server.nativeKey;
      const tools = runtime.cachedServerTools(source.identity, server.key);
      if (tools === undefined) {
        lines.push(`- ${label} — tools not yet enumerated; run ${toolName}({action:"list",server:"${token}"}) to load them`);
      } else if (tools.length === 0) {
        lines.push(`- ${label} (0 tools)`);
      } else if (tools.length > PROMPT_SERVER_COLLAPSE_TOOLS || tools.length > budget) {
        lines.push(`- ${label} — ${tools.length} tools; run ${toolName}({action:"list",server:"${token}"}) to enumerate`);
      } else {
        budget -= tools.length;
        lines.push(`- ${label} (${tools.length} tools): ${tools.map((tool) => tool.name).join(", ")}`);
      }
    }
  }
  lines.push(`Before calling an unfamiliar MCP tool, load its exact input schema: ${toolName}({action:"schema",server:"<server>",tool:["<name>",...]}).`);
  return lines.join("\n");
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

  // Dynamic discovery surface: the static guidance lives in promptGuidelines
  // (frozen at registration), while the live server/tool inventory is
  // appended per turn so it reflects warm-on-contact state. The handler must
  // never break the turn — any failure degrades to one static pointer line.
  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    try {
      const block = await buildDiscoveryBlock(runtime, toolName);
      if (block === undefined) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    } catch {
      return {
        systemPrompt: `${event.systemPrompt}\n\nMCP servers are available through the ${toolName} tool — call ${toolName}({action:"status"}) to enumerate them.`,
      };
    }
  });

  (pi.registerTool as (tool: unknown) => unknown)({
    name: toolName,
    label: toolName === "mcp" ? "MCP" : "MCP Sources",
    description: "Source-qualified MCP gateway for programmatic configuration sources — discover servers (status/list/search), load exact input schemas (schema), and call tools (call)",
    promptSnippet: "MCP gateway for isolated programmatic sources",
    promptGuidelines: [
      `Before calling an unfamiliar MCP tool through ${toolName}, load its exact input schema with ${toolName}({action:"schema",server:"<server>",tool:["<name>",...]}) — batch several tool names in one call.`,
      `Use ${toolName}({action:"search",query:"..."}) to find MCP tools by description when the tool name is not obvious.`,
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("status"),
        Type.Literal("capabilities"),
        Type.Literal("list"),
        Type.Literal("search"),
        Type.Literal("schema"),
        Type.Literal("call"),
      ])),
      source: Type.Optional(Type.String({
        description: "Exact McpSourceIdentity encoded as JSON",
      })),
      server: Type.Optional(Type.String({
        description: "Server to use: its display name (e.g. 'krometrail', shown first in status output) or its source-local mcp-server-v1:… key",
      })),
      tool: Type.Optional(Type.Union([
        Type.String(),
        Type.Array(Type.String()),
      ], { description: "Native MCP tool name — or an array of names to batch the schema action" })),
      args: Type.Optional(Type.String({ description: "Tool arguments encoded as a JSON object" })),
      query: Type.Optional(Type.String({ description: "Search text for tool names/descriptions" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression (default: substring match)" })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        action?: "status" | "capabilities" | "list" | "search" | "schema" | "call";
        source?: string;
        server?: string;
        tool?: string | string[];
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
            formatToolList(params.server, tools, toolName),
            { mode: "list", server: params.server, tools: tools.map((tool) => ({ name: tool.name })), count: tools.length },
          );
        }
        if (action === "schema") {
          if (params.tool === undefined) throw new Error("tool name(s) are required for the schema action");
          const names = Array.isArray(params.tool) ? params.tool : [params.tool];
          if (names.length === 0) throw new Error("tool name(s) are required for the schema action");
          const result = await runtime.getToolSchemas(identity, params.server, names, operationSignal);
          const guarded = await guardMcpOutput(
            [{ type: "text" as const, text: formatSchemas(params.server, result) }],
            resolveMcpOutputGuardOptions(),
          );
          return {
            content: guarded.content,
            details: {
              mode: "schema",
              server: params.server,
              tools: result.schemas.map((tool) => tool.name),
              missing: result.missing,
              ...guardedMcpDetails(guarded),
            },
          };
        }
        if (params.tool === undefined) throw new Error("tool name is required");
        if (Array.isArray(params.tool)) throw new Error("call takes a single tool name; only the schema action batches");
        let args: Record<string, unknown> = {};
        if (params.args !== undefined) {
          const parsed = JSON.parse(params.args);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("tool arguments must be an object");
          }
          args = parsed as Record<string, unknown>;
        }
        const result = await runtime.callTool(identity, params.server, params.tool, args, operationSignal);
        // Schema-on-error: the failed call's own connect already warmed the
        // session schema memory, so appending the exact input schema costs no
        // extra round-trip and turns a validation failure into a
        // self-correcting retry. Only isError results get this — launch and
        // source failures have no tool to describe.
        const errorSuffix = result.isError === true
          ? (() => {
              const schema = runtime.cachedToolSchema(identity, params.server, params.tool as string);
              return schema === undefined
                ? undefined
                : `\n\nInput schema for ${params.tool}:\n${JSON.stringify(schema, null, 2)}`;
            })()
          : undefined;
        // Route through the same output guard as the proxy/direct-tool paths:
        // text is capped and spilled to a temp file, image blocks pass through
        // as native image content instead of base64-in-JSON, and details stay
        // bounded. Programmatic mode has no settings object, so defaults apply
        // (the MCP_OUTPUT_GUARD env kill switch is still honored).
        const outputContent = resolveMcpResultContent(result as Record<string, unknown>);
        const guarded = await guardMcpOutput(
          outputContent.length > 0 ? outputContent : [{ type: "text" as const, text: "(empty result)" }],
          {
            ...resolveMcpOutputGuardOptions(),
            ...(result.isError === true ? {
              prefix: "Error: ",
              emptyTextFallback: "Tool execution failed",
              ...(errorSuffix === undefined ? {} : { suffix: errorSuffix }),
            } : {}),
            rawMcpResult: result,
          },
        );
        return {
          content: guarded.content,
          details: {
            mode: "call",
            server: params.server,
            tool: params.tool,
            ...(result.isError === true ? { error: "tool_error" } : {}),
            ...guardedMcpDetails(guarded),
          },
        };
      } catch (error) {
        return safeFailure(error, operationSignal);
      }
    },
  });
}
