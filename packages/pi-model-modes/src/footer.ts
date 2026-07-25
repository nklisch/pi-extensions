import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedMode } from "./presets.js";
import {
  getActiveMode,
  getDefaultMode,
  resolveActiveModePlan,
} from "./resolver.js";
import { CYCLE_FORWARD_KEY, CYCLE_BACKWARD_KEY } from "./keybinding.js";

type Theme = ExtensionContext["ui"]["theme"];

/**
 * Unique plugin-owned status slot. The visible label lives in the value
 * (`mode: ◆ create`) so custom footers can render extension statuses directly
 * without relying on any footer's key-prefix behavior.
 */
export const MODE_FOOTER_KEY = "pi-model-modes";

/**
 * Leading marker glyph per base voice. Echoes pi-catppuccin-tui's ◆ vocabulary
 * so the mode footer reads as part of the same family as the model/git/context
 * line rather than a foreign symbol. Glyph choice tracks voice *character*:
 * solid for pi-family voices (default `pi` and the more-terse `pi-direct`),
 * outline for `chill`'s softer voice, hex for `flow`'s distinct character.
 *
 * The raw glyphs stay plain Unicode for stable tests and fallback renderers;
 * the pi seam applies theme-aware color so Catppuccin footers inherit the
 * active flavor instead of hardcoded ANSI escapes.
 */
const BASE_VOICE_GLYPHS: Readonly<Record<string, string>> = {
  pi: "◆",
  "pi-direct": "◆",
  chill: "◇",
  flow: "⬡",
};

/** Distinct error glyph for an unresolvable mode; wins over any partial mode. */
const UNRESOLVABLE_GLYPH = "✕";

/** Fallback when no mode is active or the base is unrecognized. */
const DEFAULT_GLYPH = "◆";

/**
 * PURE: glyph for a base voice, with a default fallback for unset / unknown
 * bases (forward-compat for new base voices added later). Used directly by
 * callers that know a base but not the full `ModeFooterInputs` shape (e.g. the
 * cycle-keybinding toast, which matches the footer's leading glyph so the
 * toast and the footer agree visually).
 */
export function glyphForBase(base: string | undefined): string {
  if (base === undefined) return DEFAULT_GLYPH;
  return BASE_VOICE_GLYPHS[base] ?? DEFAULT_GLYPH;
}

/**
 * PURE: pick the leading footer glyph for the current state.
 *
 * Precedence mirrors the indicator itself: modeError wins, then unset falls
 * back to the default glyph, then the per-base-voice map.
 */
export function selectModeGlyph(inputs: ModeFooterInputs): string {
  if (inputs.modeError !== undefined) return UNRESOLVABLE_GLYPH;
  return glyphForBase(inputs.mode?.base);
}

/** PURE inputs to the footer render (no pi coupling). */
export interface ModeFooterInputs {
  /** Effective preset name when the spec is a string preset. */
  specName: string | undefined;
  /** Resolved axes; undefined means no effective mode. */
  mode: ResolvedMode | undefined;
  /** Broken active/default mode; wins over a resolved mode. */
  modeError: string | undefined;
  /** Whether cycle keybindings are registered and the footer hint is honest. */
  cycleHintEnabled: boolean;
  /** Forward cycle key text, forwarded verbatim from the keybinding seam. */
  cycleForwardKey: string;
  /** Backward cycle key text, forwarded verbatim from the keybinding seam. */
  cycleBackwardKey: string;
}

/** PURE styling hooks for the mode footer render. Defaults are identity. */
export interface ModeFooterStyle {
  label(text: string, inputs: ModeFooterInputs): string;
  glyph(text: string, inputs: ModeFooterInputs): string;
  value(text: string, inputs: ModeFooterInputs): string;
  modifier(text: string, inputs: ModeFooterInputs): string;
  separator(text: string, inputs: ModeFooterInputs): string;
  hint(text: string, inputs: ModeFooterInputs): string;
}

const PLAIN_MODE_FOOTER_STYLE: ModeFooterStyle = {
  label: (text) => text,
  glyph: (text) => text,
  value: (text) => text,
  modifier: (text) => text,
  separator: (text) => text,
  hint: (text) => text,
};

/**
 * Catppuccin-compatible styling: use semantic pi theme tokens so the selected
 * Catppuccin flavor (or any other theme) owns the actual colors.
 */
export function createThemedModeFooterStyle(theme: Theme): ModeFooterStyle {
  return {
    label: (text) => theme.fg("muted", text),
    glyph: (text, inputs) => {
      if (inputs.modeError !== undefined) return theme.fg("error", text);
      if (inputs.mode === undefined) return theme.fg("dim", text);
      return theme.fg("accent", text);
    },
    value: (text, inputs) => {
      if (inputs.modeError !== undefined) return theme.fg("error", text);
      if (inputs.mode === undefined) return theme.fg("dim", text);
      return theme.fg("toolTitle", text);
    },
    modifier: (text) => theme.fg("accent", text),
    separator: (text) => theme.fg("dim", text),
    hint: (text) => theme.fg("dim", text),
  };
}

/** PURE: build the one-line footer string. Always returns a string. */
export function formatModeFooter(
  inputs: ModeFooterInputs,
  style: ModeFooterStyle = PLAIN_MODE_FOOTER_STYLE,
): string {
  const glyph = selectModeGlyph(inputs);
  let value: string;
  if (inputs.modeError !== undefined) {
    value = "unresolvable";
  } else if (inputs.mode === undefined) {
    value = "unset";
  } else if (inputs.specName !== undefined) {
    value = inputs.specName;
  } else {
    value = `${inputs.mode.base}/${inputs.mode.agency}/${inputs.mode.quality}/${inputs.mode.scope}`;
  }
  let indicator = `${style.label("mode:", inputs)} ${style.glyph(glyph, inputs)} ${style.value(value, inputs)}`;

  if (inputs.modeError === undefined && inputs.mode !== undefined && inputs.mode.modifiers.length > 0) {
    indicator += ` ${style.modifier(`+${inputs.mode.modifiers.length}`, inputs)}`;
  }

  if (!inputs.cycleHintEnabled) {
    return indicator;
  }
  return `${indicator} ${style.separator("·", inputs)} ${style.hint(
    `${inputs.cycleForwardKey}/${inputs.cycleBackwardKey} cycle`,
    inputs,
  )}`;
}

let cycleHintEnabled = false;

/** Factory-only: enable/disable the cycle hint. */
export function setCycleHintEnabled(b: boolean): void {
  cycleHintEnabled = b;
}

/** TEST-ONLY: reset module-scope footer state. */
export function resetFooterForTesting(): void {
  cycleHintEnabled = false;
}

/**
 * Thin pi seam. UI-only side effect: reads resolver state and pushes the
 * formatted footer string. No prompt, cache, splice, or resolver mutation.
 */
export function refreshModeFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }

  const spec = getActiveMode() ?? getDefaultMode();
  const specName = typeof spec === "string" ? spec : undefined;
  let mode: ResolvedMode | undefined;
  let modeError: string | undefined;
  try {
    mode = resolveActiveModePlan().mode;
  } catch (err) {
    modeError = (err as Error).message;
  }

  ctx.ui.setStatus(
    MODE_FOOTER_KEY,
    formatModeFooter(
      {
        specName,
        mode,
        modeError,
        cycleHintEnabled,
        cycleForwardKey: CYCLE_FORWARD_KEY,
        cycleBackwardKey: CYCLE_BACKWARD_KEY,
      },
      createThemedModeFooterStyle(ctx.ui.theme),
    ),
  );
}
