import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  NONE_PRESET,
  PI_BASE,
  getPreset,
  loadPresets,
  type ResolvedMode,
} from "./presets.js";
import {
  AXES,
  discoverAxis,
  discoverModifiers,
  discoverBaseOverlays,
  loadFragment,
  type Axis,
} from "./fragments.js";
import { NO_MODE_SIGNATURE } from "./cache.js";

/**
 * Mode resolver — the specifier → `ResolvedMode` → materialized `ModePlan`
 * core. This is the load-bearing seam three downstream features consume:
 *   - the handler keys the result cache on `plan.signature` BEFORE the hit/miss
 *     check (so it must obtain the signature pre-cache),
 *   - `deterministic-splice` assembles from `plan.fragments` (the SAME ordered,
 *     already-loaded content), so signature and splice can never drift, and
 *   - `/mode:inspect` / switching summaries read `plan.mode`.
 *
 * `signature` is a CONTENT HASH over the ordered selected-fragment contents:
 * editing a fragment changes the signature → forces a re-assemble next turn.
 * `base === PI_BASE` contributes no overlay fragment but STILL participates in
 * the signature (via a virtual `base:pi` entry) so a real mode is distinct from
 * no-mode. Identity is NOT in the plan — the splice prepends it separately.
 * Model id/provider and the base system prompt are EXCLUDED here too; the
 * handler composes those in `computeCacheKey`.
 *
 * Pure module (Node builtins + the preset/fragment layers only). The mode state
 * is TWO-TIER (precedence override > default > unset):
 *   - the OVERRIDE tier (`activeSpec`, set via `setActiveMode`/`clearActiveMode`)
 *     is the ephemeral session selection driven by `/mode`,
 *   - the DEFAULT tier (`defaultSpec`, set via `setDefaultMode`) is the durable
 *     config-seeded baseline applied at `session_start`.
 * The EFFECTIVE mode resolved per turn is `override ?? default ?? unset`, so
 * `clearActiveMode()` (= `/mode off`) falls back to the default, not to unset.
 * `getEffectiveModeSource()` reports which tier won. Both tiers validate by
 * materialize-before-assign and clone object specs on set/read.
 *
 * Design: `.work/active/features/epic-mode-composition-mode-resolver.md`
 *   + `.work/active/features/epic-switching-paths-config-default.md`.
 */

/** Which slot a planned fragment fills, in canonical splice order. */
export type FragmentSlot = "base" | Axis | "modifier";

/** One materialized fragment in splice order. */
export interface PlannedFragment {
  slot: FragmentSlot;
  value: string; // basename without ".md", e.g. "autonomous"
  path: string; // absolute
  content: string; // loaded + trimmed
}

/** The materialized plan: signature for the cache key + ordered content for the
 *  splice + the resolved selection for inspect/summary. Identity is NOT here. */
export interface ModePlan {
  mode: ResolvedMode | undefined; // undefined ⇔ no active mode
  signature: string; // NO_MODE_SIGNATURE when no mode
  fragments: readonly PlannedFragment[]; // [] when no mode
}

/** What can be set active: a preset name or an explicit selection. */
export type ModeSpec = string | ResolvedMode;

/** One entry contributing to the signature: a slot + its value + the content
 *  hash. The base entry is always present (real overlay hash OR virtual
 *  `{base,"pi",""}`); axes always present; modifiers only when non-empty. */
interface SigEntry {
  slot: FragmentSlot;
  value: string;
  hash: string;
}

// --- internal mode state: two tiers (override > default > unset) -------------
// The OVERRIDE tier — the ephemeral session selection (`/mode`). When set it
// wins over the default.
let activeSpec: ModeSpec | undefined;
// The DEFAULT tier — the durable config-seeded baseline (`session_start`).
// Applies when no override is set.
let defaultSpec: ModeSpec | undefined;

// --- internal helpers --------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Length-delimited canonical encoding of the signature entries — for each
 * entry, `<byteLen>:<field>` per (slot, value, hash) joined by `|`, entries
 * joined by `\n`. The byte-length prefix nullifies cross-field ambiguity so
 * boundaries between fields (and between entries) can never collide. Mirrors
 * `cache.ts`'s `encodeComponents` discipline.
 */
function encode(entries: readonly SigEntry[]): string {
  const enc = (f: string): string => `${Buffer.byteLength(f, "utf8")}:${f}`;
  return entries
    .map((e) => [enc(e.slot), enc(e.value), enc(e.hash)].join("|"))
    .join("\n");
}

/**
 * Find the single discovered fragment path whose basename (sans `.md`) equals
 * `value`. FAIL FAST: zero matches → missing; more than one → ambiguous. Both
 * errors name the slot + value.
 */
function matchOne(
  paths: readonly string[],
  value: string,
  slot: FragmentSlot,
): string {
  const hits = paths.filter((p) => basename(p, ".md") === value);
  if (hits.length === 0) {
    throw new Error(`mode ${slot} "${value}" has no fragment file`);
  }
  if (hits.length > 1) {
    throw new Error(
      `ambiguous ${slot} "${value}" matches ${hits.length} fragments`,
    );
  }
  return hits[0];
}

/**
 * Resolve a `ModeSpec` to a normalized `ResolvedMode`:
 *   - `string` → look it up as a preset (`getPreset(spec, loadPresets())`).
 *   - `ResolvedMode` → clone its fields (caller's object is never retained).
 * In both cases `modifiers` is de-duplicated first-occurrence-wins (a `Set`
 * preserves first-insertion order). The result is a fresh object the resolver
 * fully owns.
 */
function normalize(spec: ModeSpec): ResolvedMode {
  const src: ResolvedMode =
    typeof spec === "string" ? getPreset(spec, loadPresets()) : spec;
  return {
    base: src.base,
    agency: src.agency,
    quality: src.quality,
    scope: src.scope,
    modifiers: [...new Set(src.modifiers)],
  };
}

function noModePlan(): ModePlan {
  return { mode: undefined, signature: NO_MODE_SIGNATURE, fragments: [] };
}

/**
 * Materialize a normalized `ResolvedMode` into a `ModePlan`: discover + load
 * the selected fragments in canonical splice order (base? → agency → quality →
 * scope → modifiers), build BOTH the ordered `fragments[]` and the signature
 * entries, and hash the latter. THROWS on any missing/ambiguous fragment.
 */
function materializePlan(mode: ResolvedMode): ModePlan {
  const fragments: PlannedFragment[] = [];
  const sigEntries: SigEntry[] = [];

  // base — always contributes a signature entry. PI_BASE is a virtual entry
  // (no overlay fragment); a real base resolves + loads an overlay.
  if (mode.base === PI_BASE) {
    sigEntries.push({ slot: "base", value: "pi", hash: "" });
  } else {
    const path = matchOne(discoverBaseOverlays(), mode.base, "base");
    const content = loadFragment(path);
    fragments.push({ slot: "base", value: mode.base, path, content });
    sigEntries.push({ slot: "base", value: mode.base, hash: sha256(content) });
  }

  // axes — exactly one value per axis, always present in the signature.
  for (const axis of AXES) {
    const value = mode[axis];
    const path = matchOne(discoverAxis(axis), value, axis);
    const content = loadFragment(path);
    fragments.push({ slot: axis, value, path, content });
    sigEntries.push({ slot: axis, value, hash: sha256(content) });
  }

  // modifiers — only discovered/loaded when non-empty (fast-path).
  if (mode.modifiers.length > 0) {
    const mods = discoverModifiers();
    for (const value of mode.modifiers) {
      const path = matchOne(mods, value, "modifier");
      const content = loadFragment(path);
      fragments.push({ slot: "modifier", value, path, content });
      sigEntries.push({ slot: "modifier", value, hash: sha256(content) });
    }
  }

  return {
    mode,
    signature: sha256(encode(sigEntries)),
    fragments,
  };
}

// --- Public API --------------------------------------------------------------

/**
 * Set the active mode. Validates by fully materializing once (throws on unknown
 * preset / missing fragment / bad axis value / ambiguous match) so a known-bad
 * mode never becomes active — validation runs BEFORE assignment, so a throw
 * leaves prior state intact. Explicit `ResolvedMode` specs are stored as the
 * CLONED normalized object (never the caller's), so later caller mutation can't
 * affect active state; string specs are stored as-is (resolved per turn).
 * `undefined` clears the active mode.
 */
export function setActiveMode(spec: ModeSpec | undefined): void {
  if (spec === undefined) {
    activeSpec = undefined;
    return;
  }
  if (spec === NONE_PRESET) {
    activeSpec = NONE_PRESET;
    return;
  }
  const normalized = normalize(spec);
  // Validate by materializing — throws on failure, leaving activeSpec intact.
  materializePlan(normalized);
  // Store a string as-is, or the cloned normalized ResolvedMode (never the
  // caller's object).
  activeSpec = typeof spec === "string" ? spec : normalized;
}

/**
 * The currently-active mode spec, or `undefined` when no mode is active. Object
 * (`ResolvedMode`) specs are returned as a CLONE (fresh `modifiers` array too) so
 * a caller cannot mutate the resolver's active state through the returned value;
 * string specs are immutable and returned as-is.
 */
export function getActiveMode(): ModeSpec | undefined {
  if (activeSpec === undefined || typeof activeSpec === "string") {
    return activeSpec;
  }
  return { ...activeSpec, modifiers: [...activeSpec.modifiers] };
}

/** Clear the active mode = the OVERRIDE tier (equivalent to
 *  `setActiveMode(undefined)`). The effective mode falls back to the default
 *  tier (or unset if no default). This is `/mode off`. */
export function clearActiveMode(): void {
  activeSpec = undefined;
}

/**
 * Set the DEFAULT mode (the durable, config-seeded baseline). Same discipline
 * as `setActiveMode`: validates by fully materializing once (throws on unknown
 * preset / missing fragment / bad axis value / ambiguous match) BEFORE
 * assignment, so a bad default never becomes the default and prior state is
 * intact on throw. Explicit `ResolvedMode` specs are stored as the CLONED
 * normalized object; string specs are stored as-is. `undefined` clears it.
 */
export function setDefaultMode(spec: ModeSpec | undefined): void {
  if (spec === undefined) {
    defaultSpec = undefined;
    return;
  }
  if (spec === NONE_PRESET) {
    defaultSpec = NONE_PRESET;
    return;
  }
  const normalized = normalize(spec);
  // Validate by materializing — throws on failure, leaving defaultSpec intact.
  materializePlan(normalized);
  defaultSpec = typeof spec === "string" ? spec : normalized;
}

/**
 * The current DEFAULT-tier mode spec, or `undefined` when no default is set.
 * Object (`ResolvedMode`) specs are returned as a CLONE (fresh `modifiers`
 * array too); string specs are returned as-is. Mirrors `getActiveMode`.
 */
export function getDefaultMode(): ModeSpec | undefined {
  if (defaultSpec === undefined || typeof defaultSpec === "string") {
    return defaultSpec;
  }
  return { ...defaultSpec, modifiers: [...defaultSpec.modifiers] };
}

/** Clear the DEFAULT mode (equivalent to `setDefaultMode(undefined)`). */
export function clearDefaultMode(): void {
  defaultSpec = undefined;
}

/**
 * Which tier supplies the EFFECTIVE mode: `"override"` when a session override
 * is set, else `"default"` when a config default is set, else `"unset"`.
 * Surfaces (the `/mode` no-arg display, keybinding cycle start, `/mode:inspect`)
 * read this to report *why* the current mode is what it is.
 */
export function getEffectiveModeSource(): "override" | "default" | "unset" {
  if (activeSpec !== undefined) {
    return "override";
  }
  if (defaultSpec !== undefined) {
    return "default";
  }
  return "unset";
}

/**
 * Materialize the EFFECTIVE mode (`override ?? default ?? unset`) into a
 * `ModePlan`. Fast-paths no-mode: when neither tier is set, returns
 * `{ mode: undefined, signature: NO_MODE_SIGNATURE, fragments: [] }` with ZERO
 * discovery/load work. Otherwise re-materializes + re-hashes (honoring live
 * fragment edits via the loader's mtime cache). THROWS on missing/ambiguous
 * fragments — resolve-time is the integrity gate (files can change after set).
 */
export function resolveActiveModePlan(): ModePlan {
  const spec = activeSpec ?? defaultSpec;
  if (spec === undefined) {
    return noModePlan();
  }
  if (spec === NONE_PRESET) {
    return noModePlan();
  }
  return materializePlan(normalize(spec));
}

/** TEST-ONLY: clear BOTH tiers of mode state (override + default). */
export function resetResolverForTesting(): void {
  activeSpec = undefined;
  defaultSpec = undefined;
}
