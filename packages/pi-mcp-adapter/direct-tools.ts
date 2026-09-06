import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UrlElicitationRequiredError, type Client } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpConfig, ToolPrefix, ToolMetadata } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { lazyConnect, getFailureAgeSeconds, clearFailure } from "./init.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { isServerCacheValid, parseDirectToolSelectors } from "./metadata-cache.ts";
export { getMissingConfiguredDirectToolServers } from "./metadata-cache.ts";
import { formatSchema } from "./tool-metadata.ts";
import { resolveMcpResultContent } from "./tool-registrar.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { maybeStartUiSession, summarizeUiSessionResult, type UiSessionRuntime } from "./ui-session.ts";
import { formatToolName, isServerDisabled, isToolAllowed, resolveToolPrefix } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { authenticate, supportsOAuth } from "./mcp-auth-flow.ts";
import { formatAuthRequiredMessage, formatTerminalError, invokeContainedCallback, resolveServerUrl, truncateAtWord } from "./utils.ts";
import { SessionRecoveryAuthRequiredError, ToolRemovedAfterReconnectError, withSessionRecovery } from "./session-recovery.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { ensureToolCallApproved } from "./tool-approval.ts";
import { logger } from "./logger.ts";

type ClientCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
export const DIRECT_TOOLS_ADVISORY_THRESHOLD = 75;

type DirectAutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

function getDirectAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
): string {
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getDirectAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  if (customGuidance) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getDirectAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`;
}

async function attemptDirectAutoAuth(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<DirectAutoAuthResult> {
  if (state.config.settings?.autoAuth !== true) {
    return { status: "skipped" };
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition) || !supportsOAuth(definition)) {
    return { status: "skipped" };
  }

  let serverUrl: string | undefined;
  try {
    serverUrl = resolveServerUrl(definition);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: getDirectAuthFailedMessage(state, serverName, message) };
  }
  if (!serverUrl) {
    return { status: "skipped" };
  }

  const grantType = definition.oauth ? definition.oauth.grantType ?? "authorization_code" : "authorization_code";
  if (!state.ui && grantType !== "client_credentials") {
    return {
      status: "failed",
      message: getDirectAuthRequiredMessage(
        state,
        serverName,
        `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
      ),
    };
  }

  try {
    if (state.authStorageOptions) {
      await authenticate(
        serverName,
        serverUrl,
        definition,
        signal
          ? { authStorageOptions: state.authStorageOptions, signal, runtime: state.oauthRuntime }
          : { authStorageOptions: state.authStorageOptions, runtime: state.oauthRuntime },
      );
    } else {
      await authenticate(serverName, serverUrl, definition, {
        ...(signal ? { signal } : {}),
        runtime: state.oauthRuntime,
      });
    }
    return { status: "success" };
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getDirectAuthFailedMessage(state, serverName, message),
    };
  }
}

export function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: ToolPrefix,
  envOverride?: string[],
  liveMetadata?: ReadonlyMap<string, ToolMetadata[]>,
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache && !liveMetadata) return specs;

  const seenNames = new Set<string>();

  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
  const globalDirect = config.settings?.directTools;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const serverCache = cache?.servers[serverName];
    const live = liveMetadata?.get(serverName);
    if (!live && (!serverCache || !isServerCacheValid(serverCache, definition))) continue;

    let toolFilter: true | string[] | false = false;

    if (envSelection) {
      if (envSelection.servers.has(serverName)) {
        toolFilter = true;
      } else if (envSelection.tools.has(serverName)) {
        toolFilter = [...envSelection.tools.get(serverName)!];
      }
    } else {
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }
    }

    if (!toolFilter) continue;

    const effectivePrefix = resolveToolPrefix(definition, prefix);

    for (const tool of live ? live.filter(tool => !tool.resourceUri).map(tool => ({ ...tool, name: tool.originalName })) : serverCache?.tools ?? []) {
      if (toolFilter !== true && !toolFilter.includes(tool.name)) continue;
      if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools)) continue;
      const prefixedName = formatToolName(tool.name, serverName, effectivePrefix);
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      if (seenNames.has(prefixedName)) {
        console.warn(`MCP: skipping duplicate direct tool "${prefixedName}" from "${serverName}"`);
        continue;
      }
      seenNames.add(prefixedName);
      specs.push({
        serverName,
        originalName: tool.name,
        prefixedName,
        description: tool.description ?? "",
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.uiResourceUri !== undefined ? { uiResourceUri: tool.uiResourceUri } : {}),
        ...(tool.uiStreamMode !== undefined ? { uiStreamMode: tool.uiStreamMode } : {}),
      });
    }

    if (definition.exposeResources !== false) {
      for (const resource of live ? live.filter(tool => tool.resourceUri).map(tool => ({ name: tool.originalName, uri: tool.resourceUri!, description: tool.description, originalName: tool.originalName })) : serverCache?.resources ?? []) {
        const baseName = "originalName" in resource ? String(resource.originalName) : `read_${resourceNameToToolName(resource.name)}`;
        if (toolFilter !== true && !toolFilter.includes(baseName)) continue;
        if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools)) continue;
        const prefixedName = formatToolName(baseName, serverName, effectivePrefix);
        if (BUILTIN_NAMES.has(prefixedName)) {
          console.warn(`MCP: skipping direct resource tool "${prefixedName}" (collides with builtin)`);
          continue;
        }
        if (seenNames.has(prefixedName)) {
          console.warn(`MCP: skipping duplicate direct resource tool "${prefixedName}" from "${serverName}"`);
          continue;
        }
        seenNames.add(prefixedName);
        specs.push({
          serverName,
          originalName: baseName,
          prefixedName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          resourceUri: resource.uri,
        });
      }
    }
  }

  if (specs.length >= DIRECT_TOOLS_ADVISORY_THRESHOLD) {
    console.warn(`MCP: ${specs.length} direct tools resolved. Each direct tool adds prompt context; README guidance recommends targeted sets of 5-20 tools and using the proxy or an explicit string[] when 75+ direct tools would be registered.`);
  }

  return specs;
}

export function buildProxyDescription(config: McpConfig): string {
  let desc = `MCP gateway — server status, tool search/describe, auth, and single MCP tool calls. When one request needs several MCP calls with logic between them, use mcpScript. Non-MCP Pi tools should be called directly, not through mcp.\n`;

  const serverNames = Object.keys(config.mcpServers)
    .filter((serverName) => !isServerDisabled(config.mcpServers[serverName]));
  if (serverNames.length > 0) {
    desc += `\nServers: ${serverNames.join(", ")}\n`;
  }

  const disabledServers = Object.entries(config.mcpServers)
    .filter(([, definition]) => isServerDisabled(definition))
    .map(([serverName]) => serverName);
  if (disabledServers.length > 0) {
    desc += `\nDisabled servers (enable with /mcp enable <server> and /reload): ${disabledServers.join(", ")}\n`;
  }

  desc += `\nConfigured servers connect on demand. Cached or undiscovered does not mean unavailable. Known cached tools connect when called. If search reports an undiscovered relevant server, use mcp({connect:"name"}) before declaring its capability missing. Search uses known catalogs, which may be cached; describe returns exact schemas for unfamiliar tools.\n`;
  desc += `\nUsage:\n`;
  desc += `  mcp({ })                              → Show server status and tool counts\n`;
  desc += `  mcp({ server: "name" })               → List tools from server\n`;
  desc += `  mcp({ search: "query" })              → Search MCP tools by name/description\n`;
  desc += `  mcp({ describe: "tool_name" })        → Show tool details and parameters\n`;
  desc += `  mcp({ instructions: "name" })         → Show full server usage instructions\n`;
  desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`;
  desc += `  mcp({ tool: "name", args: { key: "value" } })         → Call a tool (object args; JSON string also accepted)\n`;
  desc += `  mcp({ action: "ui-messages" })        → Retrieve accumulated messages from completed UI sessions\n`;
  desc += `  mcp({ action: "auth-start", server: "name" })      → Start manual OAuth and get a browser URL\n`;
  desc += `  mcp({ action: "auth-complete", server: "name", args: { redirectUrl: "..." } }) → Complete manual OAuth\n`;
  desc += `\nMode: action > tool (call) > connect > describe > instructions > search > server (list) > nothing (status)`;

  return desc;
}

type DirectToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<Record<string, unknown>>>;

export function createDirectToolExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  spec: DirectToolSpec
): DirectToolExecute {
  return async function execute(_toolCallId, params, signal) {
    throwIfAborted(signal);
    let state = getState();
    const initPromise = getInitPromise();

    if (!state && initPromise) {
      try {
        state = await initPromise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
          details: { error: "init_failed", message },
        };
      }
    }
    if (!state) {
      return {
        content: [{ type: "text" as const, text: "MCP not initialized" }],
        details: { error: "not_initialized" },
      };
    }

    const definition = state.config.mcpServers[spec.serverName];
    if (isServerDisabled(definition)) {
      const message = `MCP server "${spec.serverName}" is disabled. Run /mcp enable ${spec.serverName} and /reload to enable it.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { error: "server_disabled", server: spec.serverName, message },
      };
    }

    const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
    throwIfAborted(ownedSignal);
    let connected = await lazyConnect(state, spec.serverName, ownedSignal);
    let autoAuthAttempted = false;

    if (!connected && state.manager.getConnection(spec.serverName)?.status === "needs-auth") {
      autoAuthAttempted = true;
      const autoAuth = await attemptDirectAutoAuth(state, spec.serverName, ownedSignal);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { error: "auth_required", server: spec.serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(spec.serverName);
        clearFailure(state, spec.serverName);
        connected = await lazyConnect(state, spec.serverName, ownedSignal);
      }
    }

    if (!connected) {
      const authConnection = state.manager.getConnection(spec.serverName);
      if (authConnection?.status === "needs-auth") {
        const message = getDirectAuthRequiredMessage(state, spec.serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
        };
      }
      const failedAgo = getFailureAgeSeconds(state, spec.serverName);
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not available${failedAgo !== null ? ` (failed ${failedAgo}s ago)` : ""}` }],
        details: { error: "server_unavailable", server: spec.serverName },
      };
    }

    const connection = state.manager.getConnection(spec.serverName);
    if (!connection || connection.status !== "connected") {
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not connected` }],
        details: { error: "not_connected", server: spec.serverName },
      };
    }

    const approval = await ensureToolCallApproved(state, spec.serverName, {
      name: spec.prefixedName,
      originalName: spec.originalName,
      description: spec.description,
      ...(spec.inputSchema !== undefined ? { inputSchema: spec.inputSchema } : {}),
      ...(spec.resourceUri !== undefined ? { resourceUri: spec.resourceUri } : {}),
      ...(spec.uiResourceUri !== undefined ? { uiResourceUri: spec.uiResourceUri } : {}),
      ...(spec.uiStreamMode !== undefined ? { uiStreamMode: spec.uiStreamMode } : {}),
    }, params, ownedSignal, spec.resourceUri ? "resource" : "direct");
    if (approval.ok === false) {
      const denied = approval.reason === "denied";
      const message = denied
        ? `The user declined approval to run MCP tool "${spec.originalName}" on server "${spec.serverName}".`
        : `MCP tool "${spec.originalName}" on server "${spec.serverName}" is approval-gated and requires an interactive session.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: {
          error: denied ? "approval_denied" : "approval_required",
          server: spec.serverName,
          tool: spec.originalName,
        },
      };
    }

    let uiSession: UiSessionRuntime | null = null;
    const reportSecondaryFailure = (operation: string, error: unknown): void => {
      logger.error(`MCP direct tool ${operation} failed: ${truncateAtWord(formatTerminalError(error), 1_024) || "unknown error"}`);
    };
    const sendToolCancelled = (reason: string): void => {
      if (!uiSession) return;
      invokeContainedCallback(uiSession.sendToolCancelled, [reason], error => reportSecondaryFailure("UI cancellation", error));
    };
    const requestOptions = state.manager.getRequestOptions?.(spec.serverName, ownedSignal) ?? (ownedSignal ? { signal: ownedSignal } : undefined);

    const outputGuardOptions = resolveMcpOutputGuardOptions(state.config.settings);
    const recoverAuthConnection = async () => {
      const current = state.manager.getConnection(spec.serverName);
      if (current?.status === "connected") return current;

      if (!autoAuthAttempted) {
        autoAuthAttempted = true;
        const autoAuth = await attemptDirectAutoAuth(state, spec.serverName, ownedSignal);
        if (autoAuth.status === "failed") {
          throw new SessionRecoveryAuthRequiredError(spec.serverName, autoAuth.message);
        }
        if (autoAuth.status === "success") {
          const afterAuth = state.manager.getConnection(spec.serverName);
          if (afterAuth?.status === "connected") return afterAuth;
          if (afterAuth?.status === "needs-auth") {
            await state.manager.close(spec.serverName);
          }
          clearFailure(state, spec.serverName);
          const reconnected = await lazyConnect(state, spec.serverName, ownedSignal);
          return reconnected ? state.manager.getConnection(spec.serverName) : undefined;
        }
      }
      return state.manager.getConnection(spec.serverName);
    };

    try {
      state.manager.touch(spec.serverName);
      state.manager.incrementInFlight(spec.serverName);

      if (spec.resourceUri) {
        const result = await withSessionRecovery(
          {
            manager: state.manager,
            config: state.config,
            ...(ownedSignal ? { signal: ownedSignal } : {}),
            onNeedsAuth: recoverAuthConnection,
          },
          spec.serverName,
          (conn) => conn.client.readResource({ uri: spec.resourceUri! }, requestOptions),
        );
        const content = (result.contents ?? []).map(c => ({
          type: "text" as const,
          text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
        }));
        const guarded = await guardMcpOutput(content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }], outputGuardOptions);
        return {
          content: guarded.content,
          details: { server: spec.serverName, resourceUri: spec.resourceUri, ...guardedMcpDetails(guarded) },
        };
      }

      const hasUi = !!spec.uiResourceUri;
      uiSession = hasUi
        ? await maybeStartUiSession(state, {
            serverName: spec.serverName,
            toolName: spec.originalName,
            toolArgs: params ?? {},
            uiResourceUri: spec.uiResourceUri!,
            ...(spec.uiStreamMode !== undefined ? { streamMode: spec.uiStreamMode } : {}),
            ...(signal ? { signal } : {}),
            onNeedsAuth: recoverAuthConnection,
          })
        : null;

      const result = await withSessionRecovery<ClientCallToolResult>(
        {
          manager: state.manager,
          config: state.config,
          nativeToolName: spec.originalName,
          ...(ownedSignal ? { signal: ownedSignal } : {}),
          onNeedsAuth: recoverAuthConnection,
        },
        spec.serverName,
        (conn) => abortable(conn.client.callTool({
          name: spec.originalName,
          arguments: params ?? {},
          _meta: uiSession?.requestMeta,
        }, requestOptions), ownedSignal),
      );
      uiSession?.sendToolResult(result as unknown as import("@modelcontextprotocol/client").CallToolResult);

      if (result.isError) {
        // Error results also carry structuredContent; route through the shared
        // resolver so those facts reach the model alongside the error text.
        const content = resolveMcpResultContent(result as Record<string, unknown>);
        const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
        const schemaText = spec.inputSchema ? `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}\n\nFor the exact schema use mcp(${JSON.stringify({ describe: spec.prefixedName, server: spec.serverName })}).` : "";
        const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, prefix: "Error: ", suffix: schemaText, emptyTextFallback: "Tool execution failed" });
        return {
          content: guarded.content,
          details: { error: "tool_error", server: spec.serverName, ...guardedMcpDetails(guarded) },
        };
      }

      const content = resolveMcpResultContent(result as Record<string, unknown>);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      if (hasUi) {
        const uiSummary = summarizeUiSessionResult(uiSession);
        const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, suffix: `\n\n${uiSummary.message}` });
        return {
          content: guarded.content,
          details: {
            server: spec.serverName,
            tool: spec.originalName,
            uiOpen: uiSummary.uiOpen,
            uiViewer: uiSummary.uiViewer,
            uiUrl: uiSummary.uiUrl,
            ...guardedMcpDetails(guarded),
          },
        };
      }

      const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions });
      return {
        content: guarded.content,
        details: { server: spec.serverName, tool: spec.originalName, ...guardedMcpDetails(guarded) },
      };
    } catch (error) {
      if (error instanceof ToolRemovedAfterReconnectError) {
        return { content: [{ type: "text" as const, text: error.message }], details: { error: "not_found_after_reconnect" } };
      }
      if (error instanceof SessionRecoveryAuthRequiredError) {
        const message = error.authMessage ?? getDirectAuthRequiredMessage(state, spec.serverName);
        sendToolCancelled(message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
        };
      }
      if (error instanceof UrlElicitationRequiredError) {
        let action: "accept" | "decline" | "cancel";
        try {
          action = await state.manager.handleUrlElicitationRequired(spec.serverName, error);
        } catch (followUpError) {
          reportSecondaryFailure("URL elicitation handling", followUpError);
          action = "cancel";
        }
        const message = action === "accept"
          ? "The original MCP tool did not run. Complete the opened browser interaction, then retry the tool."
          : `The URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`;
        sendToolCancelled(message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "url_elicitation_required", server: spec.serverName, action },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      sendToolCancelled(message);
      let schemaText = "";
      try {
        schemaText = spec.inputSchema ? `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}\n\nFor the exact schema use mcp(${JSON.stringify({ describe: spec.prefixedName, server: spec.serverName })}).` : "";
      } catch (schemaError) {
        reportSecondaryFailure("error schema formatting", schemaError);
      }
      try {
        const guarded = await guardMcpOutput([{ type: "text" as const, text: message }], { ...outputGuardOptions, prefix: "Failed to call tool: ", suffix: schemaText });
        return {
          content: guarded.content,
          details: { error: isAbortError(error, ownedSignal) ? "aborted" : "call_failed", server: spec.serverName, ...guardedMcpDetails(guarded) },
        };
      } catch (guardError) {
        reportSecondaryFailure("error output guarding", guardError);
        return {
          content: [{ type: "text" as const, text: `Failed to call tool: ${message}` }],
          details: { error: isAbortError(error, ownedSignal) ? "aborted" : "call_failed", server: spec.serverName },
        };
      }
    } finally {
      if (uiSession?.reused) {
        try {
          uiSession.close();
        } catch (error) {
          reportSecondaryFailure("UI session close", error);
        }
      }
      try {
        state.manager.decrementInFlight(spec.serverName);
      } catch (error) {
        reportSecondaryFailure("in-flight cleanup", error);
      }
      try {
        state.manager.touch(spec.serverName);
      } catch (error) {
        reportSecondaryFailure("activity cleanup", error);
      }
    }
  };
}
