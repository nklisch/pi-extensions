import type { McpExtensionState } from "./state.ts";
import { isServerDisabled } from "./types.ts";

// Suppress automatic spawn/network storms after a failed connection. Explicit
// mcp({connect: name}) bypasses this cooldown; expiry does not assert recovery.
export const FAILURE_BACKOFF_MS = 60_000;
export type AvailabilityState = "disabled" | "connecting" | "connected" | "cached" | "undiscovered" | "needs-auth" | "failed";
export interface ServerAvailability {
  name: string;
  state: AvailabilityState;
  catalog: "live" | "cached" | "unknown";
  knownToolCount: number;
  retryAfterMs?: number;
  message?: string | undefined;
}
export function failureAgeSeconds(state: McpExtensionState, name: string): number | null {
  const failedAt = state.failureTracker.get(name);
  if (failedAt === undefined || Date.now() - failedAt >= FAILURE_BACKOFF_MS) return null;
  return Math.max(0, Math.floor((Date.now() - failedAt) / 1000));
}
export function serverAvailability(state: McpExtensionState, name: string): ServerAvailability {
  const connection = state.manager.getConnection(name);
  const known = state.toolMetadata.has(name);
  const failedAt = state.failureTracker.get(name);
  const status: AvailabilityState = isServerDisabled(state.config.mcpServers[name]) ? "disabled"
    : state.manager.isConnecting?.(name) ? "connecting"
    : connection?.status === "connected" ? "connected"
    : connection?.status === "needs-auth" ? "needs-auth"
    : failedAt !== undefined ? "failed"
    : known ? "cached" : "undiscovered";
  return {
    name, state: status,
    catalog: connection?.status === "connected" ? "live" : known ? "cached" : "unknown",
    knownToolCount: state.toolMetadata.get(name)?.length ?? 0,
    ...(status === "failed" ? {
      retryAfterMs: Math.max(0, FAILURE_BACKOFF_MS - (Date.now() - failedAt!)),
      message: state.failureMessages?.get(name)?.slice(0, 1024),
    } : {}),
  };
}
export function isCatalogSearchable(state: McpExtensionState, name: string): boolean {
  const availability = serverAvailability(state, name);
  return availability.state === "connected" || availability.state === "cached";
}
export function recoveryAction(availability: ServerAvailability) {
  return availability.state === "needs-auth"
    ? { action: "auth-start", server: availability.name }
    : { connect: availability.name };
}
export function availabilityText(availability: ServerAvailability): string {
  const connect = `mcp(${JSON.stringify({ connect: availability.name })})`;
  switch (availability.state) {
    case "disabled": return `disabled; enable with /mcp enable ${availability.name}`;
    case "connecting": return `connecting; catalog not searched yet; retry shortly or use ${connect}`;
    case "connected": return `${availability.knownToolCount} tools`;
    case "cached": return `${availability.knownToolCount} cached tools; connects automatically when called; ${connect} refreshes the catalog`;
    case "undiscovered": return `configured; tools not discovered; use ${connect}`;
    case "needs-auth": return `authentication required; use mcp(${JSON.stringify(recoveryAction(availability))})`;
    case "failed": return `connection failed${availability.message ? `: ${availability.message}` : ""}; ${availability.retryAfterMs ? `retry in ${Math.ceil(availability.retryAfterMs / 1000)}s or use ${connect} now` : `retry available; use ${connect}`}`;
  }
}
export function searchCoverage(state: McpExtensionState, server?: string) {
  const omittedServers = Object.keys(state.config.mcpServers)
    .filter(name => (!server || server === name) && !isServerDisabled(state.config.mcpServers[name]))
    .map(name => serverAvailability(state, name))
    .filter(value => !isCatalogSearchable(state, value.name))
    .map(value => ({ server: value.name, reason: value.state, action: recoveryAction(value), ...(value.retryAfterMs !== undefined ? { retryAfterMs: value.retryAfterMs } : {}) }));
  return { complete: omittedServers.length === 0, omittedServers };
}
export function coverageText(state: McpExtensionState, server?: string): string {
  const coverage = searchCoverage(state, server);
  return coverage.complete ? "" : `\n\nSearched known catalogs; results are incomplete:\n${coverage.omittedServers.map(value => `- ${value.server}: ${availabilityText(serverAvailability(state, value.server))}`).join("\n")}`;
}

/** A diagnostic, not a retry policy for side-effecting tool calls. */
export function isTemporarilyUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if ("status" in error && error.status === 503) return true;
    error = error.cause;
  }
  return false;
}
