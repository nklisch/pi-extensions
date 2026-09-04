import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DistillerConfig {
  /** Master switch for the startup-pass distiller. */
  enabled: boolean;
  /** "provider/modelId" override; null walks the cheap-model preference list. */
  model: string | null;
  /** Sessions younger than this are still in progress; leave them alone. */
  minIdleHours: number;
  /** Bound on LLM extraction calls per activation pass (Codex parity: 16). */
  maxSessionsPerPass: number;
  /** Sessions older than this are not worth distilling (Codex parity: 30). */
  maxSessionAgeDays: number;
}

export interface PocketConfig {
  /** Master switch for the whole pocket, toggled by /pocket on|off. */
  enabled: boolean;
  distiller: DistillerConfig;
}

export const DEFAULT_CONFIG: PocketConfig = {
  enabled: true,
  distiller: {
    enabled: true,
    model: null,
    minIdleHours: 6,
    maxSessionsPerPass: 16,
    maxSessionAgeDays: 30,
  },
};

/** Cheap-model preference order when config.distiller.model is null. The first
 * entry resolvable in the user's model registry wins; if none resolve, the
 * distiller degrades to "mechanical floor only" rather than failing. */
export const DISTILLER_MODEL_PREFERENCE: readonly string[] = [
  "zai/glm-5.3-flash",
  "openrouter/deepseek-v4-flash-latest",
  "ollama-cloud/glm-5.3-flash",
];

export function configPath(root: string): string {
  return join(root, "config.json");
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Load config, tolerating a missing or corrupt file by falling back to
 * defaults. The pocket is a convenience feature: a broken config must never
 * block extension load, so every read failure degrades to defaults. */
export function loadConfig(root: string): PocketConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configPath(root), "utf8")) as Record<string, unknown>;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  const d = (raw.distiller ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    distiller: {
      enabled: typeof d.enabled === "boolean" ? d.enabled : DEFAULT_CONFIG.distiller.enabled,
      model: typeof d.model === "string" && d.model.includes("/") ? d.model : null,
      minIdleHours: clampNumber(d.minIdleHours, DEFAULT_CONFIG.distiller.minIdleHours, 1, 48),
      maxSessionsPerPass: clampNumber(d.maxSessionsPerPass, DEFAULT_CONFIG.distiller.maxSessionsPerPass, 1, 128),
      maxSessionAgeDays: clampNumber(d.maxSessionAgeDays, DEFAULT_CONFIG.distiller.maxSessionAgeDays, 0, 90),
    },
  };
}

export function saveConfig(root: string, config: PocketConfig): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
