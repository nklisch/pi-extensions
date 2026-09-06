import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface GuardConfig {
  enabled: boolean;
  maxConcurrentRequests: number;
  maxRequestsPerMinute: number;
  maxRequestsPerFiveHours: number;
  maxInputTokensPerFiveHours: number;
  maxRequestsPerSession: number;
  maxConsecutiveToolTurns: number;
  maxQueueWaitMs: number;
  requestTimeoutMs: number;
  batchToolGuidance: boolean;
}

export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  maxConcurrentRequests: 4,
  maxRequestsPerMinute: 15,
  maxRequestsPerFiveHours: 250,
  maxInputTokensPerFiveHours: 20_000_000,
  maxRequestsPerSession: 120,
  maxConsecutiveToolTurns: 80,
  maxQueueWaitMs: 60_000,
  requestTimeoutMs: 10 * 60_000,
  batchToolGuidance: true,
};

const INTEGER_KEYS = [
  "maxConcurrentRequests",
  "maxRequestsPerMinute",
  "maxRequestsPerFiveHours",
  "maxInputTokensPerFiveHours",
  "maxRequestsPerSession",
  "maxConsecutiveToolTurns",
  "maxQueueWaitMs",
  "requestTimeoutMs",
] as const;

function parseConfigFile(path: string): Partial<GuardConfig> {
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      console.warn(`[pi-ollama-cloud] Ignoring non-object config at ${path}.`);
      return {};
    }
    const raw = value as Record<string, unknown>;
    const parsed: Partial<GuardConfig> = {};
    if (typeof raw.enabled === "boolean") parsed.enabled = raw.enabled;
    if (typeof raw.batchToolGuidance === "boolean") parsed.batchToolGuidance = raw.batchToolGuidance;
    for (const key of INTEGER_KEYS) {
      const candidate = raw[key];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
        parsed[key] = candidate;
      } else if (candidate !== undefined) {
        console.warn(`[pi-ollama-cloud] Ignoring invalid ${key} in ${path}. Expected a non-negative integer.`);
      }
    }
    return parsed;
  } catch (error) {
    console.warn(`[pi-ollama-cloud] Failed to read config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export function loadConfig(cwd?: string, projectTrusted = false): GuardConfig {
  const globalConfig = parseConfigFile(join(getAgentDir(), "ollama-cloud-local.json"));
  const projectConfig = cwd && projectTrusted
    ? parseConfigFile(join(cwd, CONFIG_DIR_NAME, "ollama-cloud-local.json"))
    : {};
  const config = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
  if (/^(1|true|yes|on)$/i.test(process.env.PI_OLLAMA_GUARD_DISABLED ?? "")) {
    config.enabled = false;
  }
  return config;
}
