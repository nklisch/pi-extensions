export function containsUnsafeNativeControlScalar(
  value: string,
  options: Readonly<{ allowHorizontalTab?: boolean }> = {},
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowedTab = options.allowHorizontalTab === true && code === 0x09;
    if ((!allowedTab && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
