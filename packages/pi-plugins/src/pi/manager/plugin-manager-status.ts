import type { Theme } from "@earendil-works/pi-coding-agent";
import type { NativeControlStatus } from "../../application/native-control-contract.js";
import { projectTerminalText } from "./pi-terminal-text.js";

export type PluginManagerStatusTone = "success" | "warning" | "error" | "muted";

/**
 * Exact presentation mapping. Substring matching is unsafe here because values
 * such as unavailable/inactive/unsupported contain positive status words.
 */
export const PluginManagerStatusRegistry = Object.freeze({
  ready: "success",
  active: "success",
  current: "success",
  success: "success",
  succeeded: "success",
  supported: "success",
  available: "success",
  activatable: "success",
  applied: "success",
  enabled: "success",
  ok: "success",
  "no-change": "success",
  matching: "success",
  resolved: "success",
  blocked: "error",
  failed: "error",
  error: "error",
  incompatible: "error",
  unavailable: "error",
  "not-available": "error",
  unsupported: "error",
  rejected: "error",
  corrupt: "error",
  disposed: "error",
  "recovery-required": "error",
  warning: "warning",
  attention: "warning",
  stale: "warning",
  conflict: "warning",
  unresolved: "warning",
  manual: "warning",
  unknown: "warning",
  partial: "warning",
  cancelled: "warning",
  "input-required": "warning",
  "not-found": "warning",
  "presentation-required": "warning",
  inactive: "muted",
  disabled: "muted",
  standby: "muted",
  missing: "muted",
  pending: "muted",
} as const satisfies Readonly<Record<string, PluginManagerStatusTone>>);

export type PluginManagerKnownStatus = keyof typeof PluginManagerStatusRegistry;

export function pluginManagerStatusTone(status: string): PluginManagerStatusTone {
  return PluginManagerStatusRegistry[status.trim().toLowerCase() as PluginManagerKnownStatus] ?? "muted";
}

export const NativeControlStatusTone = Object.freeze({
  ok: "success",
  "no-change": "success",
  "input-required": "warning",
  "not-found": "warning",
  stale: "warning",
  conflict: "warning",
  unavailable: "error",
  rejected: "error",
  partial: "warning",
  "recovery-required": "error",
  cancelled: "warning",
  failed: "error",
  "presentation-required": "warning",
} as const satisfies Readonly<Record<NativeControlStatus, PluginManagerStatusTone>>);

/** One plain clause per envelope status; exit classes and codes stay in machine output. */
export const NativeControlStatusClause: Readonly<Record<NativeControlStatus, string>> = Object.freeze({
  ok: "done",
  "no-change": "done — nothing to change",
  "input-required": "needs more input",
  "not-found": "not found — refresh and try again",
  stale: "things changed — refresh and try again",
  conflict: "things changed — refresh and try again",
  unavailable: "couldn't finish — something it needed wasn't available",
  rejected: "wasn't allowed",
  partial: "partly done",
  "recovery-required": "needs recovery to finish",
  cancelled: "cancelled",
  failed: "didn't finish",
  "presentation-required": "needs a screen",
});

function statusToken(tone: PluginManagerStatusTone): Readonly<{ color: "success" | "warning" | "error" | "muted"; sigil: string }> {
  if (tone === "success") return { color: "success", sigil: "✓" };
  if (tone === "warning") return { color: "warning", sigil: "△" };
  if (tone === "error") return { color: "error", sigil: "!" };
  return { color: "muted", sigil: "○" };
}

export function styledStatus(theme: Theme, status: string, tone = pluginManagerStatusTone(status)): string {
  const token = statusToken(tone);
  const text = projectTerminalText(status, 128).text;
  return theme.fg(token.color, `${token.sigil} ${text}`);
}

/** The one-line human result every surface renders for a finished envelope. */
export function styledNativeControlStatusLine(theme: Theme, status: NativeControlStatus): string {
  return `${styledStatus(theme, status, NativeControlStatusTone[status] ?? pluginManagerStatusTone(status))} · ${NativeControlStatusClause[status] ?? status}`;
}
