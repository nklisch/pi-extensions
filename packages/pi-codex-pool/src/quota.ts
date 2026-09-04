import { FIVE_HOUR_WINDOW_SECONDS, WEEKLY_WINDOW_SECONDS, type QuotaSnapshot } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function remaining(window: Record<string, unknown>): number | null {
  const used = window.used_percent;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

/** Parse only the two quota durations observed from the Codex usage endpoint. */
export function parseQuotaPayload(payload: unknown, capturedAt = Date.now()): QuotaSnapshot {
  let fiveHour: number | null = null;
  let weekly: number | null = null;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const duration = value.limit_window_seconds;
    if (duration === FIVE_HOUR_WINDOW_SECONDS && fiveHour === null) fiveHour = remaining(value);
    if (duration === WEEKLY_WINDOW_SECONDS && weekly === null) weekly = remaining(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return { fiveHour, weekly, capturedAt };
}

export type UsageFetcher = (accessToken: string, signal?: AbortSignal) => Promise<QuotaSnapshot>;

export function createUsageFetcher(fetchImpl: typeof fetch = fetch): UsageFetcher {
  return async (accessToken, signal) => {
    const response = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error(`Codex quota refresh failed (${response.status})`);
    return parseQuotaPayload(await response.json());
  };
}
