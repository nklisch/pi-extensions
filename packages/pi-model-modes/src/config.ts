import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { setDefaultMode, clearDefaultMode, clearActiveMode } from "./resolver.js";
import { clearActiveStyle } from "./style.js";
import {
  configureStyleDefaults,
  discoverBundledStyles,
  isValidStyleName,
  RESERVED_STYLE_NAMES,
  resolveCustomStylePath,
  type CustomStyleEntry,
  type StyleDefaultSource,
} from "./style.js";

/**
 * Plugin-owned configuration — the durable, file-backed source for the
 * DEFAULT mode tier (precedence override > default > unset).
 *
 * Config is plugin-owned, NOT pi's closed `Settings` (which has no plugin
 * namespace). Two files are read project-over-global; scalar keys shallow-
 * merge while `customStyles` merges per name:
 *   - global:  `~/.pi/agent/pi-model-modes.json`
 *   - project: `<cwd>/.pi/pi-model-modes.json`
 *
 * Tolerant by design — a missing file is `{}`; a malformed file warns and is
 * treated as `{}`. Loading config never throws, so `session_start` seeding
 * can never crash the session. Shape is `{ defaultMode?, cycleKeybinding?,
 * writingStyle?, customStyles? }`, extensible.
 *
 * Pure module (Node builtins + the resolver's default-tier setter only). The
 * two absolute paths are overridable via a test seam so tests never touch the
 * real home dir.
 *
 * Design: `.work/active/features/epic-switching-paths-config-default.md`.
 */

/** The v1 plugin config shape (extensible). */
export interface PluginConfig {
  defaultMode?: string;
  cycleKeybinding?: boolean;
  writingStyle?: string;
  customStyles?: Record<string, string>;
}

export interface StyleConfigScope {
  configDir: string;
  writingStyle: string | undefined;
  customStyles: Record<string, string>;
}

// --- config file paths (override via the test seam) --------------------------

let globalPathOverride: string | undefined;
let projectPathOverride: string | undefined;

/** The global config path: `~/.pi/agent/pi-model-modes.json`. */
export function globalConfigPath(): string {
  return (
    globalPathOverride ??
    join(homedir(), ".pi", "agent", "pi-model-modes.json")
  );
}

/** The project config path: `<cwd>/.pi/pi-model-modes.json`. */
export function projectConfigPath(cwd: string): string {
  return projectPathOverride ?? join(cwd, ".pi", "pi-model-modes.json");
}

/**
 * Read one config file tolerantly: missing → `{}`; valid JSON object → parsed;
 * anything else (parse error, non-object) → `console.warn` + `{}`. Never throws.
 */
function readConfigFile(path: string): PluginConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    // ENOENT (and any other read failure) → treat as absent, silently.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    console.warn(`pi-model-modes: could not read config "${path}": ${(cause as Error).message}`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`pi-model-modes: config "${path}" is not a JSON object — ignoring`);
      return {};
    }
    return parsed as PluginConfig;
  } catch (cause) {
    console.warn(`pi-model-modes: config "${path}" is not valid JSON (${(cause as Error).message}) — ignoring`);
    return {};
  }
}

function readCycleKeybindingFlag(config: PluginConfig, path: string): boolean {
  const value = (config as { cycleKeybinding?: unknown }).cycleKeybinding;
  if (value === undefined) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  console.warn(
    `pi-model-modes: config "${path}" cycleKeybinding must be a boolean — disabling cycle keybindings`,
  );
  return false;
}

/**
 * Load the merged plugin config: global `~/.pi/agent/pi-model-modes.json`
 * merged with project `<cwd>/.pi/pi-model-modes.json`, PROJECT WINS. Scalars
 * shallow-merge; `customStyles` merges per key.
 * Each file is read tolerantly (missing → `{}`, malformed → warn + `{}`), so
 * this never throws.
 */
export function loadPluginConfig(cwd: string): PluginConfig {
  const global = readConfigFile(globalConfigPath());
  const project = readConfigFile(projectConfigPath(cwd));
  const customStyles = {
    ...(isRecord(global.customStyles) ? global.customStyles : {}),
    ...(isRecord(project.customStyles) ? project.customStyles : {}),
  } as Record<string, string>;
  const merged: PluginConfig = { ...global, ...project };
  if (global.customStyles !== undefined || project.customStyles !== undefined) {
    merged.customStyles = customStyles;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStyleScope(path: string): StyleConfigScope {
  const raw = readConfigFile(path) as Record<string, unknown>;
  let writingStyle: string | undefined;
  if (raw.writingStyle !== undefined) {
    if (typeof raw.writingStyle === "string") writingStyle = raw.writingStyle;
    else console.warn(`pi-model-modes: config "${path}" writingStyle must be a string — ignoring`);
  }

  const customStyles: Record<string, string> = {};
  if (raw.customStyles !== undefined) {
    if (!isRecord(raw.customStyles)) {
      console.warn(`pi-model-modes: config "${path}" customStyles must be an object — ignoring`);
    } else {
      for (const [name, value] of Object.entries(raw.customStyles)) {
        if (!isValidStyleName(name)) {
          console.warn(`pi-model-modes: invalid custom style name "${name}" in "${path}" — ignoring`);
        } else if (RESERVED_STYLE_NAMES.has(name)) {
          console.warn(`pi-model-modes: custom style name "${name}" is reserved — ignoring`);
        } else if (typeof value !== "string") {
          console.warn(`pi-model-modes: custom style "${name}" in "${path}" must map to a string path — ignoring`);
        } else {
          customStyles[name] = value;
        }
      }
    }
  }
  return { configDir: dirname(path), writingStyle, customStyles };
}

/** Read and shape-validate style data from each defining config scope. */
export function readStyleConfigScopes(cwd: string): {
  global: StyleConfigScope;
  project: StyleConfigScope;
} {
  return {
    global: readStyleScope(globalConfigPath()),
    project: readStyleScope(projectConfigPath(cwd)),
  };
}

/** Seed the orthogonal writing-style state. Invalid entries degrade independently. */
export function applyStyleFromConfig(cwd: string): void {
  try {
    const scopes = readStyleConfigScopes(cwd);
    const registry = new Map<string, CustomStyleEntry>();
    const addScope = (scope: StyleConfigScope, source: "global" | "project"): void => {
      for (const [name, rawRel] of Object.entries(scope.customStyles)) {
        try {
          resolveCustomStylePath(rawRel, scope.configDir);
          registry.set(name, { rawRel, configDir: scope.configDir, scope: source });
        } catch (cause) {
          console.warn(
            `pi-model-modes: invalid custom style "${name}" in ${source} config — ignoring (${(cause as Error).message})`,
          );
        }
      }
    };
    addScope(scopes.global, "global");
    addScope(scopes.project, "project");

    // Scalar precedence is resolved independently from the registry. A
    // malformed/unknown project value masks the global value and degrades to
    // unset rather than accidentally reviving a lower-priority selection.
    const selection = scopes.project.writingStyle ?? scopes.global.writingStyle;
    const selectionSource: "project" | "global" | "unset" =
      scopes.project.writingStyle !== undefined
        ? "project"
        : scopes.global.writingStyle !== undefined
          ? "global"
          : "unset";
    const bundledNames = new Set(
      discoverBundledStyles().map((path) => basename(path, ".md")),
    );
    let validSelection = selection;
    if (
      validSelection !== undefined &&
      validSelection !== "none" &&
      (!registry.has(validSelection) && !bundledNames.has(validSelection))
    ) {
      console.warn(`pi-model-modes: unknown writingStyle "${validSelection}" — ignoring`);
      validSelection = undefined;
    }
    configureStyleDefaults({
      selection: validSelection,
      source: validSelection === undefined ? "unset" : selectionSource,
      registry,
    });
  } catch (cause) {
    // Config startup is deliberately tolerant even if package/style discovery
    // encounters an unexpected I/O failure. Preserve no stale default, while
    // configureStyleDefaults still preserves any active override.
    console.warn(`pi-model-modes: could not apply writing style — ignoring (${(cause as Error).message})`);
    configureStyleDefaults({ selection: undefined, source: "unset", registry: new Map() });
  }
}

/**
 * Load the GLOBAL plugin config only. Factory-load-time decisions such as
 * keybinding registration cannot depend on project config because cwd is not
 * known yet and pi keybindings are process-global.
 */
export function loadGlobalPluginConfig(): PluginConfig {
  const path = globalConfigPath();
  const global = readConfigFile(path);
  return {
    ...global,
    cycleKeybinding: readCycleKeybindingFlag(global, path),
  };
}

/**
 * Reconcile the DEFAULT mode tier to the CURRENT merged config. Idempotent and
 * safe to call on every `session_start` (which fires on startup/reload/new/
 * resume/fork): the default tier always ends up reflecting the config as it is
 * NOW, never a stale value from a prior reseed.
 *   - valid `defaultMode`   → `setDefaultMode(it)`
 *   - no `defaultMode`      → `clearDefaultMode()` (no default configured)
 *   - invalid `defaultMode` → warn + `clearDefaultMode()` (the configured default
 *     is unusable; fall back to no-default rather than keeping a stale one)
 * An INVALID default (unknown preset / missing fragment) is caught and warned —
 * NEVER rethrown — so `session_start` can never crash from a bad config value.
 */
export function applyDefaultFromConfig(cwd: string): void {
  const config = loadPluginConfig(cwd);
  if (config.defaultMode === undefined) {
    clearDefaultMode();
    return;
  }
  try {
    setDefaultMode(config.defaultMode);
  } catch (cause) {
    console.warn(
      `pi-model-modes: invalid config defaultMode "${config.defaultMode}" — skipping (${(cause as Error).message})`,
    );
    clearDefaultMode();
  }
}

/** Why a `session_start` fired (mirrors pi's `SessionStartEvent.reason`). */
export type SessionStartReason =
  | "startup"
  | "reload"
  | "new"
  | "resume"
  | "fork";

/**
 * Handle a `session_start`. The session OVERRIDE (`/mode`, keybinding) is
 * EPHEMERAL per the SPEC: a genuinely new session must restart from the config
 * default, so the in-process override (module state that outlives a session
 * boundary) is cleared on `new` / `resume` / `fork`. A same-session `reload`
 * (and the initial `startup`, which has no prior override) preserves any active
 * override. The DEFAULT tier is always reconciled to the current config.
 *
 * Without the clear, an override set in one session would survive into the next
 * same-process session and keep winning `override ?? default` — contradicting
 * "a new session restarts from the config default."
 */
export function applySessionStart(reason: SessionStartReason, cwd: string): void {
  if (reason === "new" || reason === "resume" || reason === "fork") {
    clearActiveMode();
    clearActiveStyle();
  }
  applyDefaultFromConfig(cwd);
  applyStyleFromConfig(cwd);
}

// ===========================================================================
// Default-mode writer + scope reader (the `/mode default` surface).
// ===========================================================================
//
// Below is the write-side counterpart to the tolerant read-side loader above.
// Design locked post Codex (advisory) + Opus (adversarial) cross-review; see
// `.work/active/features/feature-mode-default-management.md`.

/** Which config file a `/mode default` write targets. */
export type DefaultScope = "project" | "global";

/**
 * The value to write for `defaultMode`. `"off"` clears the key; `"none"` is
 * the virtual no-mode default (a real persisted value the resolver accepts);
 * any other string is a preset name validated upstream by the command layer.
 */
export type DefaultValue = string;

/** Sentinel action meaning "clear the default". */
export const DEFAULT_OFF = "off";

/** Success: the writer reports the new effective default + which scope won. */
export interface WriteDefaultOk {
  ok: true;
  /**
   * True when `off` targeted a scope whose file has no `defaultMode`; no file,
   * directory, resolver, or footer state was touched. Codex final-review
   * blocker: clear-when-empty is a no-op, not a write of `{}`.
   */
  noop?: true;
  /** The scope that was just written (or inspected for a no-op clear). */
  writtenScope: DefaultScope;
  /** The value just written (`undefined` when `off` cleared/no-opped). */
  writtenValue: string | undefined;
  /**
   * The EFFECTIVE default after re-merge (project wins over global). `undefined`
   * when no default remains in either scope. Used by the command layer to build
   * a truthful notify without re-reading.
   */
  effective: { value: string | undefined; source: "global" | "project" | "unset" };
}

/** Failure: file unreadable, write failed, etc. The resolver is untouched. */
export interface WriteDefaultErr {
  ok: false;
  /** The target path; included so the error toast can name it. */
  path: string;
  /** Human-readable failure reason. */
  error: string;
}

export type WriteDefaultResult = WriteDefaultOk | WriteDefaultErr;

/**
 * STRICT read-for-write: parse the file at `path` as a JSON object. Unlike the
 * tolerant `readConfigFile`, this NEVER silently returns `{}` for malformed
 * input — that would let a `/mode default` write blow away a hand-edited
 * broken file (Codex high finding). Missing file → `{}`. Anything else →
 * throws with a clear message naming the path + parse error.
 */
function readObjectForWrite(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `"${path}" is not valid JSON (${(cause as Error).message}) — refusing to overwrite`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`"${path}" is not a JSON object — refusing to overwrite`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Write the durable default mode to the chosen scope's config file, then
 * reconcile the resolver's default tier via the LIVE merge path
 * (`applyDefaultFromConfig` — reloads + merges BOTH files). The merge
 * matters: clearing a project default while a global default exists must
 * fall back to the global value, not to `unset` (Opus blocker).
 *
 * Pipeline (validate → write → reconcile, NO early mutation):
 *   1. Resolve `path` via the existing `globalConfigPath`/`projectConfigPath`
 *      seams so `setConfigPathsForTesting` intercepts writes (Opus medium).
 *   2. Strict-read the target file (malformed → fail, do NOT overwrite).
 *   3. If clearing and the target object has no `defaultMode`, return a no-op
 *      result immediately: do NOT write `{}`, create dirs/files, reseed the
 *      resolver, or refresh the footer (Codex final-review blocker).
 *   4. Mutate in memory: set or `delete` `defaultMode`; siblings preserved.
 *   5. Serialize as `JSON.stringify(obj, null, 2) + "\n"` (Opus medium).
 *   6. Atomic write: `writeFileSync(path.tmp)` + `renameSync(tmp, path)`
 *      (both reviewers). The reader is tolerant, so a torn concurrent read
 *      silently degrades to `{}` and drops the default for that session_start
 *      — atomic rename is cheap insurance.
 *   7. Bootstrap parent dir for BOTH scopes via `mkdirSync(recursive)`
 *      (Codex medium; global may be absent on a fresh machine).
 *   8. Reconcile via `applyDefaultFromConfig(cwd)` (Opus blocker — NOT
 *      `applySessionStart`, which clears the override).
 *   9. Return the effective default + source so the caller builds a truthful
 *      notify without re-reading.
 *
 * NEVER touches the EPHEMERAL override tier — the precedence invariant
 * (override > default > unset) is preserved exactly.
 */
interface ScalarWriteOk {
  path: string;
  scope: DefaultScope;
  value: string | undefined;
  noop?: true;
}
interface ScalarWriteErr {
  path: string;
  error: string;
}

/** Shared strict, sibling-preserving, atomic scalar-key writer. */
function writeScalarConfigKey(
  path: string,
  key: string,
  value: string | typeof DEFAULT_OFF,
  scope: DefaultScope,
): ScalarWriteOk | ScalarWriteErr {
  let loaded: Record<string, unknown>;
  try {
    loaded = readObjectForWrite(path);
  } catch (cause) {
    return { path, error: (cause as Error).message };
  }

  const cleared = value === DEFAULT_OFF;
  if (cleared && !Object.prototype.hasOwnProperty.call(loaded, key)) {
    return { path, scope, value: undefined, noop: true };
  }

  const next: Record<string, unknown> = { ...loaded };
  if (cleared) delete next[key];
  else next[key] = value;

  const tmpPath = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmpPath, path);
  } catch (cause) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; preserve the original write failure.
    }
    return { path, error: (cause as Error).message };
  }
  return { path, scope, value: cleared ? undefined : value };
}

export function writeDefaultToConfig(
  cwd: string,
  value: DefaultValue,
  scope: DefaultScope,
): WriteDefaultResult {
  const path = scope === "global" ? globalConfigPath() : projectConfigPath(cwd);
  const written = writeScalarConfigKey(path, "defaultMode", value, scope);
  if ("error" in written) return { ok: false, path, error: written.error };
  if (written.noop) {
    return {
      ok: true,
      noop: true,
      writtenScope: scope,
      writtenValue: undefined,
      effective: effectiveDefaultSource(cwd),
    };
  }
  applyDefaultFromConfig(cwd);
  return {
    ok: true,
    writtenScope: scope,
    writtenValue: written.value,
    effective: effectiveDefaultSource(cwd),
  };
}

/**
 * Compute the effective default + which scope it came from, post-merge. Used
 * both by the writer (for the result) and by the bare `/mode default` panel.
 */
export function effectiveDefaultSource(cwd: string): {
  value: string | undefined;
  source: "global" | "project" | "unset";
} {
  // Shallow-merge project-over-global — same path `applyDefaultFromConfig` uses.
  const merged = loadPluginConfig(cwd);
  if (merged.defaultMode !== undefined) {
    // Project wins when both set; otherwise whatever's set.
    const project = readConfigFile(projectConfigPath(cwd)).defaultMode;
    const source = project !== undefined ? "project" : "global";
    return { value: merged.defaultMode, source };
  }
  return { value: undefined, source: "unset" };
}

/**
 * Read both raw scopes for the bare `/mode default` panel. Each entry is the
 * `defaultMode` value from that file (or `undefined` if absent). A malformed
 * file is surfaced as the string `"(unreadable)"` rather than crashing the
 * panel — matches the reader's tolerant contract.
 */
export interface WriteStyleDefaultOk {
  ok: true;
  noop?: true;
  writtenScope: DefaultScope;
  writtenValue: string | undefined;
  effective: { value: string | undefined; source: StyleDefaultSource };
}

export interface WriteStyleDefaultErr {
  ok: false;
  path: string;
  error: string;
}

export type WriteStyleDefaultResult = WriteStyleDefaultOk | WriteStyleDefaultErr;

export function effectiveStyleDefaultSource(cwd: string): {
  value: string | undefined;
  source: StyleDefaultSource;
} {
  const scopes = readStyleConfigScopes(cwd);
  if (scopes.project.writingStyle !== undefined) {
    return { value: scopes.project.writingStyle, source: "project" };
  }
  if (scopes.global.writingStyle !== undefined) {
    return { value: scopes.global.writingStyle, source: "global" };
  }
  return { value: undefined, source: "unset" };
}

export function readStyleDefaultSources(cwd: string): {
  global: string | undefined | "(unreadable)";
  project: string | undefined | "(unreadable)";
} {
  const safe = (path: string): string | undefined | "(unreadable)" => {
    try {
      const raw = readObjectForWrite(path);
      return typeof raw.writingStyle === "string" || raw.writingStyle === undefined
        ? raw.writingStyle
        : undefined;
    } catch {
      return "(unreadable)";
    }
  };
  return { global: safe(globalConfigPath()), project: safe(projectConfigPath(cwd)) };
}

function validStyleNamesForWrite(cwd: string, scope: DefaultScope): Set<string> {
  const names = new Set(discoverBundledStyles().map((path) => basename(path, ".md")));
  const scopes = readStyleConfigScopes(cwd);
  const add = (entries: Record<string, string>, source: "global" | "project", configDir: string): void => {
    for (const [name, rawRel] of Object.entries(entries)) {
      try {
        resolveCustomStylePath(rawRel, configDir);
        if (scope === "project" || source === "global") names.add(name);
      } catch {
        // Invalid registrations are ignored by config reconciliation too.
      }
    }
  };
  add(scopes.global.customStyles, "global", scopes.global.configDir);
  if (scope === "project") add(scopes.project.customStyles, "project", scopes.project.configDir);
  return names;
}

/**
 * Persist `writingStyle` while keeping mode/config siblings untouched. The
 * global path intentionally validates only global registrations: a project-
 * local custom fragment must not become a global default that is unusable in
 * another checkout.
 */
export function writeStyleDefaultToConfig(
  cwd: string,
  value: string | typeof DEFAULT_OFF,
  scope: DefaultScope,
): WriteStyleDefaultResult {
  const path = scope === "global" ? globalConfigPath() : projectConfigPath(cwd);
  if (value !== DEFAULT_OFF && value !== "none") {
    const valid = validStyleNamesForWrite(cwd, scope);
    if (!valid.has(value)) {
      return {
        ok: false,
        path,
        error: `unknown writing style "${value}" for ${scope} config scope`,
      };
    }
  }

  const written = writeScalarConfigKey(path, "writingStyle", value, scope);
  if ("error" in written) return { ok: false, path, error: written.error };
  if (written.noop) {
    return {
      ok: true,
      noop: true,
      writtenScope: scope,
      writtenValue: undefined,
      effective: effectiveStyleDefaultSource(cwd),
    };
  }
  applyStyleFromConfig(cwd);
  return {
    ok: true,
    writtenScope: scope,
    writtenValue: written.value,
    effective: effectiveStyleDefaultSource(cwd),
  };
}

export function readDefaultSources(cwd: string): {
  global: string | undefined | "(unreadable)";
  project: string | undefined | "(unreadable)";
} {
  const safe = (path: string): string | undefined | "(unreadable)" => {
    try {
      return readObjectForWrite(path).defaultMode as string | undefined;
    } catch {
      return "(unreadable)";
    }
  };
  return {
    global: safe(globalConfigPath()),
    project: safe(projectConfigPath(cwd)),
  };
}

/**
 * TEST-ONLY: override the two config file paths so tests never read the real
 * home dir. Omitted keys leave the corresponding path at its default.
 */
export function setConfigPathsForTesting(paths: {
  global?: string;
  project?: string;
}): void {
  globalPathOverride = paths.global;
  projectPathOverride = paths.project;
}

/** TEST-ONLY: clear the config path overrides. */
export function resetConfigForTesting(): void {
  globalPathOverride = undefined;
  projectPathOverride = undefined;
}
