export type SafeTerminalText = Readonly<{
  text: string;
  escaped: boolean;
  truncated: boolean;
}>;

function unsafeScalar(code: number): boolean {
  return code === 0x1b || code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0xd800 && code <= 0xdfff);
}

/** Project untrusted display data before any Pi theme function can add ANSI. */
export function formatMcpEndpoint(endpoint: Readonly<{
  scheme: "http" | "https";
  host: SafeTerminalText;
  port: SafeTerminalText;
  path: SafeTerminalText;
}>): string {
  const host = endpoint.host.text.includes(":") ? `[${endpoint.host.text}]` : endpoint.host.text;
  return `${endpoint.scheme}://${host}:${endpoint.port.text}${endpoint.path.text}`;
}

export function projectTerminalText(input: string, limit: number): SafeTerminalText {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("terminal text limit must be a positive integer");
  const projected: string[] = [];
  let escaped = false;
  for (const scalar of input) {
    const code = scalar.codePointAt(0)!;
    if (unsafeScalar(code)) {
      projected.push("�");
      escaped = true;
    } else {
      projected.push(scalar);
    }
  }
  const truncated = projected.length > limit;
  const text = truncated
    ? `${projected.slice(0, Math.max(0, limit - 1)).join("")}…`
    : projected.join("");
  return Object.freeze({ text, escaped, truncated });
}
