import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * Preset table + the shared `ResolvedMode` selection contract.
 *
 * This module owns two things the rest of the mode-composition engine builds
 * against:
 *   1. The `ResolvedMode` type — the single source of truth for a resolved
 *      mode's shape. `mode-resolver` PRODUCES it; `deterministic-splice`
 *      CONSUMES it.
 *   2. `presets.json` — named bundles of the five components. Selecting a
 *      preset expands ATOMICALLY to all five at once.
 *
 * Pure module: no pi-runtime imports (Node builtins only), fully unit-testable,
 * fail-fast at boundaries — matching `cache.ts` / `identity.ts` /
 * `provider-names.ts` conventions.
 *
 * Validation split (the key documented judgement here): this module validates
 * the SHAPE of a preset (well-formedness + unknown-preset lookup miss). It does
 * NOT validate axis-VALUE existence (does `agency:"autonomous"` correspond to a
 * real discovered fragment?) — only `mode-resolver` holds the discovered
 * fragment set, so existence is its job. A `presets.json` entry with
 * `agency:"banana"` loads fine here (well-formed string) and fails fast later at
 * the resolver.
 *
 * Design: `.work/active/features/epic-mode-composition-preset-table.md`.
 */

/**
 * The default base sentinel: "pi's own voice, no base overlay." A real,
 * selectable base value, distinct from NO_MODE_SIGNATURE ("" = no mode at
 * all). A ResolvedMode with base === PI_BASE is a real mode (non-empty
 * signature, full axis fragments) that simply contributes no base-overlay
 * fragment. There is intentionally no prompts/base/pi.md.
 */
export const PI_BASE = "pi";

/**
 * Virtual preset matching claude-code-modes' `none` mode. It is intentionally
 * not stored in presets.json because it has no axes or fragments: selecting it
 * means an explicit no-mode override.
 */
export const NONE_PRESET = "none";

/**
 * The shared resolved-mode selection contract — the single source of truth
 * for a resolved mode's shape. `mode-resolver` PRODUCES this; `assemble.ts`
 * (deterministic-splice) CONSUMES it. Axis values are validated strings, NOT
 * closed unions: the discovered fragment set (convention dirs) is the real
 * catalog, so a closed union would drift. Existence of each value is checked
 * by the resolver against the discovered fragments; this type asserts only
 * the SHAPE.
 *
 *   base       — "pi" (PI_BASE, no overlay) or a prompts/base/<base>.md name
 *   agency     — a prompts/axis/agency/<agency>.md name
 *   quality    — a prompts/axis/quality/<quality>.md name
 *   scope      — a prompts/axis/scope/<scope>.md name
 *   modifiers  — zero or more prompts/modifiers/<mod>.md names, in
 *                preset-declared order (duplicate de-dup is a resolver concern)
 */
export interface ResolvedMode {
  base: string;
  agency: string;
  quality: string;
  scope: string;
  modifiers: string[];
}

/**
 * A preset as stored in presets.json: a named ResolvedMode template. Selecting
 * a preset expands ATOMICALLY to all five components. Structurally a
 * ResolvedMode (the name lives in the registry key, not the value).
 *
 * Kept distinct from `ResolvedMode` (not a type alias) so the on-disk template
 * can gain disk-only metadata later (e.g. a description) without a breaking
 * rename of the runtime contract.
 */
export interface Preset {
  base: string;
  agency: string;
  quality: string;
  scope: string;
  modifiers: string[];
}

/** The in-memory registry after load + validation. */
export type PresetRegistry = Readonly<Record<string, Preset>>;

/** Options for loadPresets — `json` overrides disk read (test seam). */
export interface LoadPresetsOptions {
  /** Raw presets.json text to parse instead of reading the bundled file. */
  json?: string;
}

// The four required string axes every preset must declare.
const AXIS_FIELDS = ["base", "agency", "quality", "scope"] as const;

// --- Module-scope memo (the bundled presets.json does not change in-process) -

let cachedRegistry: PresetRegistry | undefined;

// --- Internal helpers -------------------------------------------------------

/** Resolve the bundled presets.json path package-relative (same idiom as the
 *  sibling fragment-loader resolves `prompts/`). From src/presets.ts, `../`
 *  resolves to the package root where presets.json lives. */
function presetsPath(): string {
  return fileURLToPath(new URL("../presets.json", import.meta.url));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * Detect duplicate top-level preset ids in the RAW JSON text. `JSON.parse`
 * silently keeps the last value for a repeated key, so duplicate-id detection
 * MUST run on the raw text before the parse collapses them.
 *
 * Mechanism: a single depth- and string-aware pass. We only register a key when
 * its closing quote is read at object depth 1 (the top-level preset map) and it
 * is immediately followed (across whitespace) by a `:`. Tracking string state
 * means a `:` or `"` inside a value string is never mistaken for structure, and
 * the depth gate means a NESTED key sharing a preset name (e.g. a field literally
 * named "flow") can never false-positive. This replaces the previous per-name
 * regex, which counted occurrences anywhere in the document.
 *
 * Each completed top-level key token is JSON-decoded (via `JSON.parse` on the
 * reconstructed string literal) before comparison, so escape-equivalent keys —
 * e.g. "flow" and "flow" — are correctly recognized as the SAME id, matching
 * how `JSON.parse` would later collapse them.
 */
function assertNoDuplicateIds(rawText: string): void {
  const seen = new Set<string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let token = ""; // contents of the in-progress string literal
  let pendingKey: string | undefined; // last string completed at depth 1, awaiting ':'

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inString) {
      if (escaped) {
        token += ch;
        escaped = false;
      } else if (ch === "\\") {
        token += ch;
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        if (depth === 1) {
          // Decode the raw token through JSON so escape-equivalent keys
          // ("flow" vs "flow") compare equal — matching JSON.parse's own
          // collapsing. Fall back to the raw token if the literal is malformed
          // (the main parse will surface the real error).
          try {
            pendingKey = JSON.parse(`"${token}"`) as string;
          } catch {
            pendingKey = token;
          }
        }
      } else {
        token += ch;
      }
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        token = "";
        break;
      case "{":
      case "[":
        depth++;
        pendingKey = undefined;
        break;
      case "}":
      case "]":
        depth--;
        pendingKey = undefined;
        break;
      case ":":
        if (depth === 1 && pendingKey !== undefined) {
          if (seen.has(pendingKey)) {
            throw new Error(`duplicate preset id "${pendingKey}" in presets.json`);
          }
          seen.add(pendingKey);
        }
        pendingKey = undefined;
        break;
      case ",":
        pendingKey = undefined;
        break;
      // whitespace and other structural chars: keep pendingKey across the gap
      // between a key's closing quote and its ':'.
    }
  }
}

/** Validate one preset's SHAPE, throwing a specific field-naming error on any
 *  malformed component. Does NOT check axis-value existence (resolver's job). */
function validatePreset(name: string, value: unknown): Preset {
  if (!isPlainObject(value)) {
    throw new Error(`preset "${name}": must be an object`);
  }
  for (const field of AXIS_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      throw new Error(
        `preset "${name}": "${field}" must be a non-empty string`,
      );
    }
  }
  const modifiers = value.modifiers;
  if (!Array.isArray(modifiers)) {
    throw new Error(`preset "${name}": "modifiers" must be a string array`);
  }
  for (const modifier of modifiers) {
    if (typeof modifier !== "string" || modifier.length === 0) {
      throw new Error(
        `preset "${name}": every "modifiers" entry must be a non-empty string`,
      );
    }
  }
  return {
    base: value.base as string,
    agency: value.agency as string,
    quality: value.quality as string,
    scope: value.scope as string,
    modifiers: [...(modifiers as string[])],
  };
}

/** Parse + validate raw presets.json text into a registry. Pure (no memo). */
function parseRegistry(rawText: string): PresetRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(
      `presets.json is not valid JSON: ${(cause as Error).message}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error("presets.json must be a top-level object of name -> preset");
  }
  assertNoDuplicateIds(rawText);
  const names = Object.keys(parsed);

  const registry: Record<string, Preset> = {};
  for (const name of names) {
    registry[name] = validatePreset(name, parsed[name]);
  }
  return Object.freeze(registry);
}

// --- Public API -------------------------------------------------------------

/**
 * Parse + validate presets.json and return the registry. Fail-fast:
 *  - JSON.parse failure                                  -> throw (malformed)
 *  - top level not a plain object                        -> throw
 *  - a preset missing/!string base/agency/quality/scope  -> throw (names id)
 *  - a preset whose base/agency/quality/scope is ""      -> throw
 *  - a preset whose modifiers is not a string[]          -> throw
 *  - a modifier entry that is not a non-empty string     -> throw
 *  - a duplicate top-level preset id                     -> throw (raw-text scan)
 *
 * Duplicate preset ids: a JSON object cannot hold duplicate keys at the value
 * level (last wins), so duplicate-id detection runs on the RAW TEXT before
 * JSON.parse (see assertNoDuplicateIds).
 *
 * NOTE: does NOT validate axis-VALUE existence against discovered fragments —
 * that is mode-resolver's job (it holds the fragment set). This validates
 * SHAPE only.
 *
 * Memoization: the disk read is memoized in module scope (the bundled
 * presets.json does not change within a process). Supplying `opts.json` parses
 * that text FRESH and never reads/writes the memo (test inputs must not poison
 * the module memo). `resetPresetsForTesting()` clears the disk memo.
 */
export function loadPresets(opts?: LoadPresetsOptions): PresetRegistry {
  if (opts?.json !== undefined) {
    return parseRegistry(opts.json);
  }
  if (cachedRegistry === undefined) {
    cachedRegistry = parseRegistry(readFileSync(presetsPath(), "utf8"));
  }
  return cachedRegistry;
}

/**
 * Look up a preset by name. Fail-fast: throws a clear error naming the unknown
 * preset AND listing the available names. Returns the Preset (a ResolvedMode
 * template) on hit. Selecting = expanding atomically to all components, so
 * callers spread it into a ResolvedMode directly.
 */
export function getPreset(name: string, registry: PresetRegistry): Preset {
  const preset = registry[name];
  if (preset === undefined) {
    const available = listPresetNames(registry).join(", ");
    throw new Error(`unknown preset "${name}" — available: ${available}`);
  }
  return preset;
}

/** Sorted user-facing preset names, including virtual `none`. */
export function listPresetNames(registry: PresetRegistry = loadPresets()): string[] {
  return [...Object.keys(registry), NONE_PRESET].sort();
}

/** TEST-ONLY: clear the memoized registry so the next loadPresets re-reads. */
export function resetPresetsForTesting(): void {
  cachedRegistry = undefined;
}
