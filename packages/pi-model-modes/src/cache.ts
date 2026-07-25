import { createHash } from "node:crypto";
import { NO_STYLE_SIGNATURE } from "./style.js";

/**
 * Cache key + per-turn result cache + change-signal ring buffer.
 *
 * This is the foundation module for the identity-injection epic. It owns three
 * co-located concerns that share `lastKey` state and fire on the same event
 * (key replacement):
 *   1. The cache key — `sha256(modelName | modelId | modelProvider | modeSignature | styleSignature | sha256(baseSystemPrompt))`
 *      via a length-delimited canonical encoding.
 *   2. The per-turn result cache — module-scope `lastKey`/`lastResult` with a
 *      hit/miss decision the handler consults each turn.
 *   3. The change-signal ring buffer — a fixed-size ring that records a
 *      `{ previousKey, newKey, turn, reason, detail }` entry whenever
 *      `lastKey` is replaced, plus the read API `/mode:inspect` later consumes.
 *
 * Pure module: no pi-runtime imports, fully unit-testable. Module-scope
 * mutable state is EXPECTED here — the cache IS stateful by design.
 * `resetCacheForTesting()` clears all of it for test isolation.
 *
 * Design: `.work/active/features/epic-identity-injection-cache-and-change-signal.md`.
 */

/** Canonical empty no-mode sentinel, distinct from every non-empty composed signature. */
export const NO_MODE_SIGNATURE = "";

/** The six inputs to the cache key. `baseSystemPrompt` is pi's
 *  fully-assembled `e.systemPrompt` for the turn. */
export interface CacheKeyInputs {
  /** Human-facing model name used in the identity line. */
  modelName: string;
  modelId: string;
  modelProvider: string;
  modeSignature: string;
  styleSignature: string;
  baseSystemPrompt: string;
}

/** Reason a cache key changed. Priority on simultaneous change is
 *  `model-switched` > `mode-switched` > `style-switched` > `base-changed` (most-deliberate
 *  user action first). `initial` is the first-ever population. */
export type ChangeReason =
  | "initial"
  | "model-switched"
  | "mode-switched"
  | "style-switched"
  | "base-changed";

/** One entry in the change-signal ring. `detail` carries structured
 *  `{ from, to }` transitions per key component (NOT pre-formatted strings)
 *  so `/mode:inspect` owns rendering. `baseHash` stands in for base content
 *  (compact; avoids buffering the full prompt text in the ring). */
export interface ChangeSignalEntry {
  turn: number;
  previousKey: string | undefined;
  newKey: string;
  reason: ChangeReason;
  detail: {
    modelName: { from: string | undefined; to: string };
    modelId: { from: string | undefined; to: string };
    modelProvider: { from: string | undefined; to: string };
    modeSignature: { from: string | undefined; to: string };
    styleSignature: { from: string | undefined; to: string };
    baseHash: { from: string | undefined; to: string };
  };
}

/** Read-only snapshot of the change signal for `/mode:inspect`. `entries` is
 *  a defensive copy so callers can't mutate the module ring. */
export interface ChangeSignalSnapshot {
  currentTurn: number;
  currentKey: string | undefined;
  /** Oldest-first, capped at RING_CAPACITY (= 16). */
  entries: ChangeSignalEntry[];
  lastEntry: ChangeSignalEntry | undefined;
}

const RING_CAPACITY = 16;

interface KeyComponents {
  modelName: string;
  modelId: string;
  modelProvider: string;
  modeSignature: string;
  styleSignature: string;
  baseHash: string;
}

// --- Module-scope state (mutable by design; the cache IS stateful) ---------

let lastKey: string | undefined;
let lastResult: string | undefined;
let lastComponents: KeyComponents | undefined;
let currentTurn = 0;
const ring: ChangeSignalEntry[] = [];

// --- Internal helpers -------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function componentsOf(inputs: CacheKeyInputs): KeyComponents {
  return {
    modelName: inputs.modelName,
    modelId: inputs.modelId,
    modelProvider: inputs.modelProvider,
    modeSignature: inputs.modeSignature,
    styleSignature: inputs.styleSignature ?? NO_STYLE_SIGNATURE,
    baseHash: sha256Hex(inputs.baseSystemPrompt),
  };
}

/**
 * Length-delimited canonical encoding: `<byteLen>:<field>` joined by `|` over
 * `[modelName, modelId, modelProvider, modeSignature, styleSignature, baseHash]`. The byte-length
 * prefix (not char-length) nullifies cross-field ambiguity — so
 * `modelId="ab",provider="c"` and `modelId="a",provider="bc"` cannot collide.
 * Deterministic: same components always produce the same canonical string.
 */
function encodeComponents(c: KeyComponents): string {
  const enc = (f: string): string => `${Buffer.byteLength(f, "utf8")}:${f}`;
  return [
    enc(c.modelName),
    enc(c.modelId),
    enc(c.modelProvider),
    enc(c.modeSignature),
    enc(c.styleSignature),
    enc(c.baseHash),
  ].join("|");
}

/**
 * Classify why the key changed. Priority: `initial` > `model-switched` >
 * `mode-switched` > `style-switched` > `base-changed`. Only called when `key !== lastKey`, so
 * when `prev` is defined, ≥1 component is guaranteed to differ.
 */
function classifyReason(
  prev: KeyComponents | undefined,
  curr: KeyComponents,
): ChangeReason {
  if (prev === undefined) return "initial";
  if (
    prev.modelName !== curr.modelName ||
    prev.modelId !== curr.modelId ||
    prev.modelProvider !== curr.modelProvider
  ) {
    return "model-switched";
  }
  if (prev.modeSignature !== curr.modeSignature) return "mode-switched";
  if (prev.styleSignature !== curr.styleSignature) return "style-switched";
  return "base-changed";
}

// --- Public API -------------------------------------------------------------

/**
 * Pure: SHA-256 hex digest of a length-delimited canonical encoding of the
 * six inputs. Deterministic — same inputs always produce the same 64-char
 * lowercase hex key. No module state consulted.
 */
export function computeCacheKey(inputs: CacheKeyInputs): string {
  return sha256Hex(encodeComponents(componentsOf(inputs)));
}

/**
 * Per-turn hit check. Returns the cached result on HIT (`key === lastKey`,
 * after the first set), `undefined` on MISS.
 *
 * SIDE EFFECT: advances the module turn counter at the START of every call
 * (one call ≡ one pi turn, since the handler calls this exactly once per
 * `before_agent_start`). Folding turn accounting into the always-called
 * getter avoids a separate `beginTurn()` API the handler would have to call.
 */
export function getCachedResult(key: string): string | undefined {
  currentTurn += 1;
  if (lastKey !== undefined && key === lastKey) return lastResult;
  return undefined;
}

/**
 * Store a freshly-assembled `result` for `key` and record a change-signal
 * entry. `inputs` is the same object passed to `computeCacheKey` — used to
 * classify the change reason by diffing against previously-stored components.
 *
 * THROWS if `key === lastKey`: the handler only calls `set` after a MISS, so
 * this surfaces caller misuse immediately (Fail Fast / miss-only contract).
 */
export function setCachedResult(
  key: string,
  result: string,
  inputs: CacheKeyInputs,
): void {
  if (key === lastKey) {
    throw new Error(
      "setCachedResult called on a HIT (key === lastKey) — miss-only contract",
    );
  }
  const prevComponents = lastComponents;
  const curr = componentsOf(inputs);
  const reason = classifyReason(prevComponents, curr);
  const entry: ChangeSignalEntry = {
    turn: currentTurn,
    previousKey: lastKey,
    newKey: key,
    reason,
    detail: {
      modelName: { from: prevComponents?.modelName, to: curr.modelName },
      modelId: { from: prevComponents?.modelId, to: curr.modelId },
      modelProvider: { from: prevComponents?.modelProvider, to: curr.modelProvider },
      modeSignature: { from: prevComponents?.modeSignature, to: curr.modeSignature },
      styleSignature: { from: prevComponents?.styleSignature, to: curr.styleSignature },
      baseHash: { from: prevComponents?.baseHash, to: curr.baseHash },
    },
  };
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.shift();
  lastKey = key;
  lastResult = result;
  lastComponents = curr;
}

/**
 * Read API for `/mode:inspect` (sibling feature). Pure read; no side effects.
 * `entries` is a shallow copy so callers can't mutate the module ring.
 */
export function getChangeSignal(): ChangeSignalSnapshot {
  return {
    currentTurn,
    currentKey: lastKey,
    entries: [...ring],
    lastEntry: ring[ring.length - 1],
  };
}

/** TEST-ONLY: clear lastKey, lastResult, lastComponents, ring, turn counter. */
export function resetCacheForTesting(): void {
  lastKey = undefined;
  lastResult = undefined;
  lastComponents = undefined;
  currentTurn = 0;
  ring.length = 0;
}
