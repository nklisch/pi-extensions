import { createHash, randomUUID } from "node:crypto";
import { abortable } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";
import {
  getToolNameCandidates,
  matchesToolPattern,
  resolveToolPrefix,
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpConfig,
  type McpToolApprovalDecision,
  type McpToolApprovalHandler,
  type McpToolApprovalOrigin,
  type McpToolApprovalRequest,
  type ToolMetadata,
} from "./types.ts";
import { sanitizeTerminalText } from "./utils.ts";

export type ToolCallApprovalResult =
  | { ok: true }
  | { ok: false; reason: "denied" | "approval_required_headless" };

export function isToolCallApprovalRequired(
  config: McpConfig,
  serverName: string,
  toolMeta: Pick<ToolMetadata, "originalName">,
): boolean {
  const definition = config.mcpServers[serverName];
  const approval = definition?.approveTools !== undefined
    ? definition.approveTools
    : config.settings?.approveTools;

  if (approval === true) return true;
  if (!Array.isArray(approval) || approval.length === 0) return false;

  const prefix = resolveToolPrefix(definition, config.settings?.toolPrefix);
  return matchesToolPattern(
    getToolNameCandidates(toolMeta.originalName, serverName, prefix),
    approval,
  );
}

function isMcpToolApprovalDecision(value: unknown): value is McpToolApprovalDecision {
  return value === "allow_once"
    || value === "allow_for_session"
    || value === "deny"
    || value === "abstain";
}

async function requestBrokerApproval(
  state: McpExtensionState,
  serverName: string,
  toolMeta: ToolMetadata,
  args: Record<string, unknown> | undefined,
  origin: McpToolApprovalOrigin,
  signal?: AbortSignal,
): Promise<McpToolApprovalDecision> {
  if (!state.approvalEvents) return "abstain";

  let acceptingClaim = true;
  let handler: McpToolApprovalHandler | undefined;
  const request: McpToolApprovalRequest = {
    requestId: randomUUID(),
    serverName,
    originalToolName: toolMeta.originalName,
    prefixedToolName: toolMeta.name,
    args: args ?? {},
    origin,
    ...(signal !== undefined ? { signal } : {}),
    claim(candidate: McpToolApprovalHandler) {
      if (!acceptingClaim || handler) return false;
      handler = candidate;
      return true;
    },
  };

  state.approvalEvents.emit(MCP_TOOL_APPROVAL_REQUEST_EVENT, request);
  acceptingClaim = false;
  if (!handler) return "abstain";

  try {
    const decision = await abortable(Promise.resolve().then(handler), signal);
    return isMcpToolApprovalDecision(decision) ? decision : "deny";
  } catch (error) {
    if (signal?.aborted) throw error;
    return "deny";
  }
}

// Canonicalize parsed JSON, not arbitrary objects: honor toJSON/omission/null
// wire semantics first, and never assign special keys such as __proto__.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value)!;
}

function approvalArguments(args: Record<string, unknown> | undefined): { digest?: string; preview: string } {
  try {
    const json = JSON.stringify(args ?? {});
    if (json !== undefined) {
      const wireArgs: unknown = JSON.parse(json);
      return {
        digest: createHash("sha256").update(canonicalJson(wireArgs)).digest("hex"),
        preview: JSON.stringify(wireArgs, null, 2),
      };
    }
  } catch {
    // No reusable consent when arguments cannot be serialized. Leave the normal
    // broker/dialog decision available rather than refusing the operation here.
  }
  return { preview: "Arguments could not be serialized; this approval will not be cached." };
}

export async function ensureToolCallApproved(
  state: McpExtensionState,
  serverName: string,
  toolMeta: ToolMetadata,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  origin: McpToolApprovalOrigin = toolMeta.resourceUri ? "resource" : "proxy",
): Promise<ToolCallApprovalResult> {
  const serialized = approvalArguments(args);
  // Name-only consent lets a later destructive call reuse approval of benign
  // arguments. Bind consent to the exact wire value without retaining its text.
  const cacheKey = serialized.digest === undefined ? undefined
    : JSON.stringify([serverName, toolMeta.originalName, serialized.digest]);
  const approvedToolCalls = state.approvedToolCalls ??= new Map<string, true>();
  if (cacheKey !== undefined && approvedToolCalls.has(cacheKey)) {
    return { ok: true };
  }

  const brokerDecision = await requestBrokerApproval(state, serverName, toolMeta, args, origin, signal);
  if (brokerDecision === "allow_once") return { ok: true };
  if (brokerDecision === "allow_for_session") {
    if (cacheKey !== undefined) approvedToolCalls.set(cacheKey, true);
    return { ok: true };
  }
  if (brokerDecision === "deny") return { ok: false, reason: "denied" };

  if (!isToolCallApprovalRequired(state.config, serverName, toolMeta)) {
    return { ok: true };
  }

  if (!state.ui) {
    return { ok: false, reason: "approval_required_headless" };
  }

  const sanitized = sanitizeTerminalText(serialized.preview);
  const preview = sanitized.length > 500 ? `${sanitized.slice(0, 500)}...` : sanitized;
  const title = `MCP: ${sanitizeTerminalText(serverName)} wants to run ${sanitizeTerminalText(toolMeta.originalName)}`;
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  const decision = await abortable(
    state.ui.select(
      `${title}\n\nArguments:\n${preview}`,
      ["Allow once", "Allow for session (same arguments)", "Deny"],
    ),
    ownedSignal,
  );

  if (decision === "Allow once") {
    return { ok: true };
  }
  if (decision === "Allow for session (same arguments)") {
    if (cacheKey !== undefined) approvedToolCalls.set(cacheKey, true);
    return { ok: true };
  }
  return { ok: false, reason: "denied" };
}
