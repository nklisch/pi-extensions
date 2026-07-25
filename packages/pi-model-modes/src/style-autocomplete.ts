import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { filterAutocompleteItems } from "./command-parse-utils.js";
import {
  STYLE_DEFAULT_ARG,
  STYLE_GLOBAL_FLAG,
  STYLE_NONE_ARG,
  STYLE_OFF_ARG,
} from "./style-command.js";
import { listAvailableStyles, type AvailableStyle } from "./style.js";

const STYLE_ARG_TRIGGER = /^\/style[ \t]+([^\s]*)$/;
const STYLE_DEFAULT_ACTION_TRIGGER = /^\/style[ \t]+default[ \t]+([^\s]*)$/;
const STYLE_DEFAULT_FLAG_TRIGGER = /^\/style[ \t]+default[ \t]+[^\s]+[ \t]+(--?[^\s]*)$/;

const NONE_DESCRIPTION = "explicit no-style selection — suppress conversational style injection";
const OFF_DESCRIPTION = "clear this tier — fall back to the lower-precedence selection";
const DEFAULT_DESCRIPTION = "manage the durable style default — writes pi-model-modes.json";
const GLOBAL_DESCRIPTION = "target the global (~/.pi/agent) config file";

function provenanceDescription(source: AvailableStyle["fragmentSource"]): string {
  if (source === "bundled") return "bundled conversational style";
  return source === "custom-global"
    ? "custom conversational style (global registration)"
    : "custom conversational style (project registration)";
}

/** Pure catalog-to-autocomplete projection, preserving deterministic input order. */
export function buildStyleArgItems(styles: readonly AvailableStyle[]): AutocompleteItem[] {
  return [
    ...styles.map((style) => ({
      value: style.name,
      label: style.name,
      description: provenanceDescription(style.fragmentSource),
    })),
    { value: STYLE_NONE_ARG, label: STYLE_NONE_ARG, description: NONE_DESCRIPTION },
    { value: STYLE_OFF_ARG, label: STYLE_OFF_ARG, description: OFF_DESCRIPTION },
  ];
}

export function buildStyleTopLevelItems(styles: readonly AvailableStyle[]): AutocompleteItem[] {
  return [
    ...buildStyleArgItems(styles),
    { value: STYLE_DEFAULT_ARG, label: STYLE_DEFAULT_ARG, description: DEFAULT_DESCRIPTION },
  ];
}

export function getStyleArgSuggestions(
  beforeCursor: string,
  styles: readonly AvailableStyle[],
): AutocompleteSuggestions | null {
  const flagToken = beforeCursor.match(STYLE_DEFAULT_FLAG_TRIGGER)?.[1];
  if (flagToken !== undefined) {
    return {
      prefix: flagToken,
      items: filterAutocompleteItems([
        { value: STYLE_GLOBAL_FLAG, label: STYLE_GLOBAL_FLAG, description: GLOBAL_DESCRIPTION },
      ], flagToken),
    };
  }

  const actionToken = beforeCursor.match(STYLE_DEFAULT_ACTION_TRIGGER)?.[1];
  if (actionToken !== undefined) {
    return {
      prefix: actionToken,
      items: filterAutocompleteItems(buildStyleArgItems(styles), actionToken),
    };
  }

  const token = beforeCursor.match(STYLE_ARG_TRIGGER)?.[1];
  if (token === undefined) return null;
  return {
    prefix: token,
    items: filterAutocompleteItems(buildStyleTopLevelItems(styles), token),
  };
}

/** TUI-only layered provider; every non-style path delegates to its predecessor. */
export function registerStyleAutocomplete(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["/"],
      async getSuggestions(lines, line, col, options) {
        if (options.signal?.aborted) {
          return current.getSuggestions(lines, line, col, options);
        }
        let suggestions: AutocompleteSuggestions | null;
        try {
          const beforeCursor = (lines[line] ?? "").slice(0, col);
          // Resolve at request time so config writes and registry refreshes are live.
          suggestions = getStyleArgSuggestions(beforeCursor, listAvailableStyles());
        } catch {
          return current.getSuggestions(lines, line, col, options);
        }
        return suggestions ?? current.getSuggestions(lines, line, col, options);
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
