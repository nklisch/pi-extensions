/** Exact-name syntax for the global non-Bash Clearance opt-in list. */
export const EXACT_NON_BASH_TOOL_NAME_PATTERN =
  "^(?!bash$)[^\\s*?\\[\\]{}]+$" as const;

export function isExactNonBashToolName(value: string): boolean {
  return value.length > 0 && new RegExp(EXACT_NON_BASH_TOOL_NAME_PATTERN).test(value);
}
