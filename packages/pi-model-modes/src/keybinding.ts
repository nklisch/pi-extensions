import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  setActiveMode,
  getActiveMode,
  getDefaultMode,
  resolveActiveModePlan,
} from "./resolver.js";
import { listPresetNames } from "./presets.js";
import { glyphForBase, refreshModeFooter } from "./footer.js";

/**
 * Mode-cycle keybindings — the keyboard switching path. `Ctrl+Shift+U` cycles
 * FORWARD through the sorted preset list and `Ctrl+Shift+Alt+U` cycles BACKWARD,
 * each setting the session OVERRIDE (via the resolver seam) relative to the
 * current EFFECTIVE mode. The package factory registers these shortcuts only
 * when the global `cycleKeybinding` config flag is `true`; otherwise callers
 * must opt in explicitly.
 *
 * The cycle math (`nextPresetName`) is a PURE helper — fully unit-testable
 * without pi. `registerModeKeybindings` is the thin pi seam.
 *
 * `Key` import note: pi examples import `Key` from `@earendil-works/pi-tui`.
 * That package is a direct dev-dependency of this plugin (added when the
 * autocomplete seam landed), but this module still uses equivalent `KeyId`
 * strings to keep the runtime import surface minimal.
 *
 * `Ctrl+M` is intentionally avoided: terminal legacy input encodes it as
 * carriage return, so it collides with Enter.
 */

/** KeyId for forward cycle. */
export const CYCLE_FORWARD_KEY = "ctrl+shift+u";
/** KeyId for backward cycle. */
export const CYCLE_BACKWARD_KEY = "ctrl+shift+alt+u";

/**
 * PURE: the next preset name when cycling through a SORTED preset list.
 *
 *   - empty list → `undefined` (no-op at the caller).
 *   - `current` found at index `i` → forward `(i+1) % len`, backward
 *     `(i-1+len) % len` (wraps at both ends).
 *   - `current` unset or not a preset name (`indexOf` → -1) → enter the list at
 *     `names[0]` going forward, `names[len-1]` going backward.
 */
export function nextPresetName(
  names: string[],
  current: string | undefined,
  dir: 1 | -1,
): string | undefined {
  const len = names.length;
  if (len === 0) {
    return undefined;
  }
  const idx = current === undefined ? -1 : names.indexOf(current);
  if (idx === -1) {
    // From unset / a non-preset spec: forward → first, backward → last.
    return dir === 1 ? names[0] : names[len - 1];
  }
  const next = (idx + dir + len) % len;
  return names[next];
}

/**
 * Register the forward/backward mode-cycle shortcuts. Each handler computes the
 * sorted preset names, derives the current EFFECTIVE spec name
 * (`getActiveMode() ?? getDefaultMode()`, only when it's a string preset), picks
 * the next preset via `nextPresetName`, then `setActiveMode(next)` +
 * `ctx.ui.notify('mode: <next>')`. An empty preset list notifies "no presets".
 */
export function registerModeKeybindings(pi: ExtensionAPI): void {
  const cycle = (dir: 1 | -1) => async (ctx: ExtensionContext): Promise<void> => {
    const names = listPresetNames();
    if (names.length === 0) {
      ctx.ui.notify("no presets", "info");
      return;
    }
    const effective = getActiveMode() ?? getDefaultMode();
    const current = typeof effective === "string" ? effective : undefined;
    const next = nextPresetName(names, current, dir);
    if (next === undefined) {
      // Defensive: names is non-empty above, so this is unreachable.
      ctx.ui.notify("no presets", "info");
      return;
    }
    setActiveMode(next);
    refreshModeFooter(ctx);
    // Match the footer's leading glyph so the toast and the footer agree. The
    // resolver is the same path `refreshModeFooter` uses; for the virtual `none`
    // preset (or any spec without a base) `mode` is undefined and we fall back
    // to the default glyph, exactly as the footer does for unset.
    let base: string | undefined;
    try {
      base = resolveActiveModePlan().mode?.base;
    } catch {
      // Resolver broken — footer will show the unresolvable marker; the toast
      // uses the default glyph rather than throwing mid-cycle.
      base = undefined;
    }
    const theme = ctx.ui.theme;
    ctx.ui.notify(
      `${theme.fg("muted", "mode:")} ${theme.fg("accent", glyphForBase(base))} ${theme.fg("toolTitle", next)}`,
      "info",
    );
  };

  pi.registerShortcut(CYCLE_FORWARD_KEY, {
    description: "Cycle to the next mode preset",
    handler: cycle(1),
  });
  pi.registerShortcut(CYCLE_BACKWARD_KEY, {
    description: "Cycle to the previous mode preset",
    handler: cycle(-1),
  });
}
