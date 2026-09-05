import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const DEFAULT_DISTILLER_MODEL = "openai-codex/gpt-6-astra";
export const DEFAULT_DISTILLER_REASONING: ModelThinkingLevel = "minimal";
export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface DistillerConfig {
  /** Master switch for activation-time and explicit distillation. */
  enabled: boolean;
  /** Exact provider/modelId selection. No provider fallback is performed. */
  model: string;
  /** Requested Pi reasoning level; the model may map it to another effective effort. */
  reasoning: ModelThinkingLevel;
  /** Sessions younger than this are still in progress; leave them alone. */
  minIdleHours: number;
  /** Bound on extraction calls per pass. */
  maxSessionsPerPass: number;
  /** Sessions older than this are not automatically distilled. */
  maxSessionAgeDays: number;
}

export interface PocketConfig {
  enabled: boolean;
  distiller: DistillerConfig;
}

export const DEFAULT_CONFIG: PocketConfig = {
  enabled: true,
  distiller: {
    enabled: true,
    model: DEFAULT_DISTILLER_MODEL,
    reasoning: DEFAULT_DISTILLER_REASONING,
    minIdleHours: 6,
    maxSessionsPerPass: 16,
    maxSessionAgeDays: 30,
  },
};

export function configPath(root: string): string {
  return join(root, "config.json");
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

export function isReasoningLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

export function isModelSpec(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

/** A malformed configuration degrades to defaults so note access remains usable. */
export function loadConfig(root: string): PocketConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configPath(root), "utf8")) as Record<string, unknown>;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  const d = typeof raw.distiller === "object" && raw.distiller !== null
    ? raw.distiller as Record<string, unknown>
    : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    distiller: {
      enabled: typeof d.enabled === "boolean" ? d.enabled : DEFAULT_CONFIG.distiller.enabled,
      // Legacy null meant "choose a cheap fallback". It now resets to the explicit Astra default.
      model: isModelSpec(d.model) ? d.model : DEFAULT_DISTILLER_MODEL,
      reasoning: isReasoningLevel(d.reasoning) ? d.reasoning : DEFAULT_DISTILLER_REASONING,
      minIdleHours: clampNumber(d.minIdleHours, DEFAULT_CONFIG.distiller.minIdleHours, 1, 48),
      maxSessionsPerPass: clampNumber(d.maxSessionsPerPass, DEFAULT_CONFIG.distiller.maxSessionsPerPass, 1, 128),
      maxSessionAgeDays: clampNumber(d.maxSessionAgeDays, DEFAULT_CONFIG.distiller.maxSessionAgeDays, 0, 90),
    },
  };
}

function atomicWrite(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, path);
}

export function saveConfig(root: string, config: PocketConfig): void {
  mkdirSync(root, { recursive: true });
  atomicWrite(configPath(root), `${JSON.stringify(config, null, 2)}\n`);
}
