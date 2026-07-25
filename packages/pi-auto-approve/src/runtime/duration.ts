const DURATION_UNITS = {
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
} as const satisfies Record<string, number>;

/**
 * Parse a compact duration string ("10m", "2h", "45s", "1h30m") to ms.
 *
 * The runtime keeps duration strings schema-light so user config can stay readable across
 * reviewer features. Invalid input returns undefined and lets each caller choose its own
 * safe fallback.
 */
export function parseDurationToMs(input: string): number | undefined {
  const text = input.trim().toLowerCase();
  if (text.length === 0) return undefined;

  let index = 0;
  let matched = false;
  let total = 0;

  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index] ?? "")) {
      index += 1;
    }
    if (index >= text.length) break;

    const match = /^(\d+)\s*([hms])/.exec(text.slice(index));
    if (match === null) return undefined;

    const amountText = match[1];
    const unit = match[2] as keyof typeof DURATION_UNITS | undefined;
    if (amountText === undefined || unit === undefined) return undefined;

    const amount = Number(amountText);
    if (!Number.isSafeInteger(amount)) return undefined;

    const addition = amount * DURATION_UNITS[unit];
    total += addition;
    if (!Number.isSafeInteger(addition) || !Number.isSafeInteger(total)) {
      return undefined;
    }

    matched = true;
    index += match[0].length;
  }

  return matched ? total : undefined;
}
