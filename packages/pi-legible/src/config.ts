import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Plugin-owned configuration — pi's closed Settings has no plugin namespace,
 * so pi-legible keeps its own JSON files, read project-over-global:
 *   - global:  `~/.pi/agent/pi-legible.json`
 *   - project: `<cwd>/.pi/pi-legible.json`
 *
 * Tolerant by design: a missing file is `{}`, a malformed file is `{}`.
 * Loading never throws so `session_start` seeding can never crash a session.
 *
 * Command-driven writes go to the GLOBAL file only; a project file is a
 * hand-authored override that wins on merge (and therefore masks global
 * writes for the keys it sets — documented in the README).
 */

export interface LegibleConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** Rewriter model spec ("provider/modelId" or bare "modelId"). Default: session model. */
  model?: string;
  /** How many recent messages the rewriter sees for context. Default: 6. */
  contextDepth?: number;
  /** Whether tool calls/results are included in that context. Default: true. */
  includeToolCalls?: boolean;
}

export interface ResolvedLegibleConfig {
  enabled: boolean;
  model: string | undefined;
  contextDepth: number;
  includeToolCalls: boolean;
}

export const DEFAULTS: ResolvedLegibleConfig = {
  enabled: true,
  model: undefined,
  contextDepth: 6,
  includeToolCalls: true,
};

export const MAX_CONTEXT_DEPTH = 20;

// --- config file paths (overridable via the test seam) -----------------------

let globalPathOverride: string | undefined;
let projectPathOverride: string | undefined;

export function globalConfigPath(): string {
  return globalPathOverride ?? join(homedir(), ".pi", "agent", "pi-legible.json");
}

export function projectConfigPath(cwd: string): string {
  return projectPathOverride ?? join(cwd, ".pi", "pi-legible.json");
}

/** Test seam: redirect config paths away from the real home dir. */
export function setConfigPathsForTest(globalPath: string, projectPath: string): void {
  globalPathOverride = globalPath;
  projectPathOverride = projectPath;
}

export function clearConfigPathsForTest(): void {
  globalPathOverride = undefined;
  projectPathOverride = undefined;
}

// --- loading -----------------------------------------------------------------

function readConfigFile(path: string): LegibleConfig {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return sanitize(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** Keep only correctly-typed known keys; wrong-typed values are dropped. */
function sanitize(raw: Record<string, unknown>): LegibleConfig {
  const config: LegibleConfig = {};
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (typeof raw.model === "string") config.model = raw.model;
  if (typeof raw.contextDepth === "number") config.contextDepth = raw.contextDepth;
  if (typeof raw.includeToolCalls === "boolean") config.includeToolCalls = raw.includeToolCalls;
  return config;
}

/**
 * Merge global + project config, PROJECT WINS per key. When the project is
 * not trusted, the project file is ignored entirely: it can select an
 * authenticated model and shape rewriter prompts, so honoring it would
 * bypass pi's project trust boundary.
 */
export function loadConfig(cwd: string, options: { trusted?: boolean } = {}): ResolvedLegibleConfig {
  const globalConfig = readConfigFile(globalConfigPath());
  const projectConfig = options.trusted === false ? {} : readConfigFile(projectConfigPath(cwd));
  const merged: LegibleConfig = { ...globalConfig, ...projectConfig };
  return {
    enabled: merged.enabled ?? DEFAULTS.enabled,
    model: typeof merged.model === "string" && merged.model.trim().length > 0 ? merged.model.trim() : undefined,
    contextDepth: clampDepth(merged.contextDepth ?? DEFAULTS.contextDepth),
    includeToolCalls: merged.includeToolCalls ?? DEFAULTS.includeToolCalls,
  };
}

export function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS.contextDepth;
  return Math.max(0, Math.min(MAX_CONTEXT_DEPTH, Math.floor(value)));
}

// --- saving (global file only, atomic) ---------------------------------------

export function saveGlobalConfig(patch: Partial<LegibleConfig>): void {
  const path = globalConfigPath();
  const current = readConfigFile(path);
  const next: LegibleConfig = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete (next as Record<string, unknown>)[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}
