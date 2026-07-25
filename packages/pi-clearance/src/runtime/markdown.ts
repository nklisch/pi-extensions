/**
 * Markdown-safe inline code span. Raw commands and paths are untrusted text:
 * when they contain backticks, a single-backtick span breaks the card.
 */
export function markdownCodeSpan(value: string): string {
  if (!value.includes("`")) return `\`${value}\``;
  const longest = Math.max(
    1,
    ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence} ${value} ${fence}`;
}
