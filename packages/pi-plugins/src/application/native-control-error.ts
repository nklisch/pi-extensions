import { z } from "zod";
import type { NativeControlStatus } from "./native-control-contract.js";

export type NativeControlErrorClassification = Readonly<{
  status: NativeControlStatus;
  code: string;
  action: "retry" | "reparse" | "provide-input" | "confirm-exact" | "refresh" | "reinspect" | "poll" | "run-recovery" | "none";
}>;

function stableCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

export function classifyNativeControlError(error: unknown): NativeControlErrorClassification {
  if (error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "CONTROL_QUIESCED") return { status: "rejected", code: "CONTROL_QUIESCED", action: "retry" };
  if (error instanceof z.ZodError) return { status: "failed", code: "CONTROL_CONTRACT_INVALID", action: "none" };
  if (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") {
    return { status: "cancelled", code: "CONTROL_CANCELLED", action: "retry" };
  }
  const code = stableCode(error);
  if (code === undefined) return { status: "failed", code: "CONTROL_INTERNAL", action: "none" };
  if (code.includes("CURSOR_STALE") || code.includes("STATE_STALE") || code.includes("PREVIEW_STALE") || code.includes("SESSION_STALE")) return { status: "stale", code, action: "reinspect" };
  if (code.includes("CURSOR_INVALID") || code.includes("INVALID_REQUEST") || code.includes("QUERY_INVALID")) return { status: "failed", code, action: "reparse" };
  if (code.includes("NOT_FOUND") || code.includes("MISSING") || code.includes("EXPIRED") || code.includes("DISPOSED")) return { status: "not-found", code, action: "reinspect" };
  if (code.includes("UNAVAILABLE") || code.includes("ADAPTER_FAILED") || code.includes("OFFLINE")) return { status: "unavailable", code, action: "retry" };
  if (code.includes("PROJECT_UNTRUSTED") || code.includes("INCOMPATIBLE") || code.includes("REJECTED") || code.includes("BLOCKED")) return { status: "rejected", code, action: "none" };
  if (code.includes("RECOVERY") || code.includes("AMBIGUOUS") || code.includes("ROLLBACK") || code.includes("CLEANUP_FAILED")) return { status: "recovery-required", code, action: "run-recovery" };
  if (code.includes("ABORT")) return { status: "cancelled", code, action: "retry" };
  return { status: "failed", code: "CONTROL_INTERNAL", action: "none" };
}
