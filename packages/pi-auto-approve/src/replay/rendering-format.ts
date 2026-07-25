export interface LabelCountView<TLabel extends string> {
  readonly label: TLabel;
  readonly calls: number;
  readonly uniqueCommands?: number;
}

/**
 * Render markdown inline code while preserving values that themselves contain
 * backticks. Matches the legacy ratchet-markdown escaping behavior.
 */
export function markdownInlineCode(value: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

/** Render a fenced markdown code block with a fence long enough for the value. */
export function markdownCodeBlock(value: string, language?: string): string {
  const longestRun = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  const info = language === undefined || language.length === 0 ? "" : language;
  return `${fence}${info}\n${value}\n${fence}`;
}

/**
 * Deterministic JSON display helper for cards/reports. This is presentation
 * output, not a persistence format; it sorts object keys recursively so tests
 * and generated cards do not drift with insertion order.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : pluralize(singular)}`;
}

export function formatPercent(value: number, total: number): string {
  if (total <= 0) {
    return "0.0%";
  }
  return `${((value / total) * 100).toFixed(1)}%`;
}

export function findCount<TLabel extends string>(
  counts: readonly LabelCountView<TLabel>[],
  label: TLabel,
): number {
  return counts.find((count) => count.label === label)?.calls ?? 0;
}

export function renderJsonPatchSummary(
  patch: readonly { readonly op: string; readonly path: string }[],
): readonly string[] {
  return patch.map(
    (operation) =>
      `${operation.op.toUpperCase()} ${markdownInlineCode(operation.path)}`,
  );
}

function pluralize(singular: string): string {
  if (singular === "unique command") {
    return "unique commands";
  }
  return `${singular}s`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
