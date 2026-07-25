const bidiAndInvisible = new Set([
  0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

/** One predicate defines both sanitizer escaping and public-schema rejection. */
export function isUnsafeDisplayScalar(character: string, codePoint: number): boolean {
  return codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    bidiAndInvisible.has(codePoint) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    /\p{Mark}/u.test(character);
}

export function containsUnsafeDisplayScalar(value: string): boolean {
  for (let index = 0; index < value.length;) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        const character = value.slice(index, index + 2);
        const codePoint = ((first - 0xd800) << 10) + second - 0xdc00 + 0x10000;
        if (isUnsafeDisplayScalar(character, codePoint)) return true;
        index += 2;
        continue;
      }
    }
    const character = value[index]!;
    if (isUnsafeDisplayScalar(character, first)) return true;
    index += 1;
  }
  return false;
}
