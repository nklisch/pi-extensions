import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type ScalarDefaultScope = "project" | "global";

export type ScalarDefaultSubcommand =
  | { kind: "display" }
  | { kind: "set"; value: string; scope: ScalarDefaultScope }
  | { kind: "clear"; scope: ScalarDefaultScope }
  | { kind: "error"; message: string };

export interface ScalarDefaultGrammar {
  command: string;
  actionLabel: string;
  globalFlag: string;
  clearToken: string;
}

/** Pure parser shared by scalar project/global default command families. */
export function parseScalarDefaultArgs(
  args: string,
  grammar: ScalarDefaultGrammar,
): ScalarDefaultSubcommand {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  let scope: ScalarDefaultScope = "project";
  let globalSeen = false;
  const positionals: string[] = [];

  for (const token of tokens) {
    if (token === grammar.globalFlag) {
      if (globalSeen) {
        return { kind: "error", message: `unexpected repeated flag "${token}"` };
      }
      globalSeen = true;
      scope = "global";
      continue;
    }
    if (token.startsWith("-")) {
      return {
        kind: "error",
        message: `unknown ${grammar.command} flag "${token}" (only ${grammar.globalFlag} is supported)`,
      };
    }
    positionals.push(token);
  }

  if (globalSeen && positionals.length === 0) {
    return {
      kind: "error",
      message: `"${grammar.globalFlag}" given but no ${grammar.actionLabel} followed`,
    };
  }
  if (positionals.length === 0) return { kind: "display" };
  if (positionals.length > 1) {
    return {
      kind: "error",
      message: `unexpected extra tokens after "${positionals[0]}" — usage: ${grammar.command} [${grammar.globalFlag}] ${grammar.actionLabel} [${grammar.globalFlag}]`,
    };
  }

  return positionals[0] === grammar.clearToken
    ? { kind: "clear", scope }
    : { kind: "set", value: positionals[0], scope };
}

/** Case-insensitive prefix filtering shared by live command completers. */
export function filterAutocompleteItems(
  items: readonly AutocompleteItem[],
  token: string,
): AutocompleteItem[] {
  if (token === "") return [...items];
  const lower = token.toLowerCase();
  return items.filter((item) => item.value.toLowerCase().startsWith(lower));
}
