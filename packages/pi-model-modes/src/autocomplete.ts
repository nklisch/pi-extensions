import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import {
  loadPresets,
  listPresetNames,
  NONE_PRESET,
  type PresetRegistry,
} from "./presets.js";
import { formatModeSummary } from "./commands.js";
import { filterAutocompleteItems } from "./command-parse-utils.js";

/** The literal `off` argument to `/mode` -- clears the override (NOT a preset). */
export const MODE_OFF_ARG = "off";
/** The literal `default` subcommand keyword for `/mode`. */
export const MODE_DEFAULT_ARG = "default";
/** The literal `--global` flag for `/mode default`. */
export const MODE_DEFAULT_GLOBAL_FLAG = "--global";

const OFF_DESCRIPTION = "clear override — fall back to default";
const NONE_DESCRIPTION = "explicit no-mode override — wins over default";
const DEFAULT_DESCRIPTION = "manage the durable default — writes pi-model-modes.json";
const GLOBAL_FLAG_DESCRIPTION = "target the global (~/.pi/agent) config file";

const MODE_ARG_TRIGGER = /^\/mode[ \t]+([^\s]*)$/;
/** Stage 2: `<action>` token after `/mode default ` (no further tokens). */
const MODE_DEFAULT_ACTION_TRIGGER = /^\/mode[ \t]+default[ \t]+([^\s]*)$/;
/** Stage 3: a leading-dash token after `/mode default <action> `. */
const MODE_DEFAULT_FLAG_TRIGGER = /^\/mode[ \t]+default[ \t]+[^\s]+[ \t]+(--?[^\s]*)$/;

/** PURE: extract the partial preset-name token after `/mode `, or undefined. */
export function extractModeArgToken(beforeCursor: string): string | undefined {
  return beforeCursor.match(MODE_ARG_TRIGGER)?.[1];
}

/** PURE: build the full, unfiltered suggestion item list. */
export function buildModeArgItems(
  registry: PresetRegistry = loadPresets(),
): AutocompleteItem[] {
  const presetItems: AutocompleteItem[] = listPresetNames(registry).map((name) => ({
    value: name,
    label: name,
    description:
      name === NONE_PRESET ? NONE_DESCRIPTION : formatModeSummary(registry[name]),
  }));
  return [
    ...presetItems,
    { value: MODE_OFF_ARG, label: MODE_OFF_ARG, description: OFF_DESCRIPTION },
  ];
}

/**
 * PURE: build the TOP-LEVEL `/mode <partial>` suggestion items — presets + `off`
 * + `default`. This is a SEPARATE builder from `buildModeArgItems` (which is
 * reused verbatim by stage 2) so the existing `length === names.length + 1`
 * assertion on `buildModeArgItems` stays intact. (Opus medium finding.)
 */
export function buildModeTopLevelItems(
  registry: PresetRegistry = loadPresets(),
): AutocompleteItem[] {
  return [
    ...buildModeArgItems(registry),
    { value: MODE_DEFAULT_ARG, label: MODE_DEFAULT_ARG, description: DEFAULT_DESCRIPTION },
  ];
}

/** PURE: build the single-item `--global` suggestion list for stage 3. */
export function buildDefaultGlobalFlagItems(): AutocompleteItem[] {
  return [
    {
      value: MODE_DEFAULT_GLOBAL_FLAG,
      label: MODE_DEFAULT_GLOBAL_FLAG,
      description: GLOBAL_FLAG_DESCRIPTION,
    },
  ];
}

/** PURE: case-insensitive prefix filter. Empty token returns all items. */
export function filterModeArgItems(
  items: AutocompleteItem[],
  token: string,
): AutocompleteItem[] {
  return filterAutocompleteItems(items, token);
}

/**
 * PURE: return `/mode` suggestions for the current line, or null when callers
 * should delegate. Three-stage dispatch for the `/mode default` subcommand:
 *
 *   - Stage 3: `/mode default <action> <--flag>` → `[--global]`
 *   - Stage 2: `/mode default <action>` → presets + `off` (NO `default` —
 *     `default default` is meaningless)
 *   - Stage 1: `/mode <partial>` → presets + `off` + `default` (top level)
 *
 * The three triggers are structurally mutually exclusive (trailing-space gates
 * each `$`), so order does not matter for correctness, only for early return.
 * Stage 3 is checked first so a leading-dash token after an action lands on
 * `--global` rather than being treated as a preset-name filter by stage 2.
 */
export function getModeArgSuggestions(
  beforeCursor: string,
  registry: PresetRegistry = loadPresets(),
): AutocompleteSuggestions | null {
  // Stage 3: flag after `/mode default <action>`.
  const flagToken = beforeCursor.match(MODE_DEFAULT_FLAG_TRIGGER)?.[1];
  if (flagToken !== undefined) {
    return {
      prefix: flagToken,
      items: filterModeArgItems(buildDefaultGlobalFlagItems(), flagToken),
    };
  }

  // Stage 2: action after `/mode default `.
  const actionToken = beforeCursor.match(MODE_DEFAULT_ACTION_TRIGGER)?.[1];
  if (actionToken !== undefined) {
    return {
      prefix: actionToken,
      items: filterModeArgItems(buildModeArgItems(registry), actionToken),
    };
  }

  // Stage 1: top-level `/mode <partial>`.
  const token = beforeCursor.match(MODE_ARG_TRIGGER)?.[1];
  if (token === undefined) {
    return null;
  }
  return {
    prefix: token,
    items: filterModeArgItems(buildModeTopLevelItems(registry), token),
  };
}

export function registerModeAutocomplete(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["/"],
      async getSuggestions(lines, line, col, options) {
        const beforeCursor = (lines[line] ?? "").slice(0, col);
        let suggestions;
        try {
          suggestions = getModeArgSuggestions(beforeCursor);
        } catch {
          return current.getSuggestions(lines, line, col, options);
        }
        if (suggestions === null) {
          return current.getSuggestions(lines, line, col, options);
        }
        if (options.signal?.aborted) {
          return current.getSuggestions(lines, line, col, options);
        }
        return suggestions;
      },
      applyCompletion(lines, line, col, item, prefix) {
        return current.applyCompletion(lines, line, col, item, prefix);
      },
      shouldTriggerFileCompletion(lines, line, col) {
        return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
      },
    }));
  });
}
