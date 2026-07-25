const encoder = new TextEncoder();

export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Compare well-formed strings by their exact UTF-8 bytes. */
export function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function assertWellFormed(value: string): void {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("canonical JSON strings must contain only Unicode scalar values");
  }
}

/**
 * Canonical JSON for digest and equality evidence. Object keys use UTF-8 byte
 * order and every string is checked before JSON serialization can rewrite an
 * invalid UTF-16 surrogate.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertWellFormed(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("value is not canonical JSON");
  const record = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(record).sort(compareUtf8).map((key) => {
    assertWellFormed(key);
    return `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`;
  });
  return `{${fields.join(",")}}`;
}
