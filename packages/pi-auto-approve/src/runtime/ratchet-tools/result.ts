import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export interface RatchetToolResult<TDetails> {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details: TDetails;
}

export interface RatchetToolErrorDetails {
  readonly ok: false;
  readonly error: {
    readonly code: "clearance_tool_error";
    readonly tool: string;
    readonly message: string;
  };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("clearance tool call aborted");
  }
}

export function formatRatchetToolError(
  tool: string,
  error: unknown,
): RatchetToolResult<RatchetToolErrorDetails> {
  const message = errorMessage(error);
  return formatRatchetToolResult(
    {
      ok: false,
      error: {
        code: "clearance_tool_error",
        tool,
        message,
      },
    },
    [
      `# ${tool} failed`,
      "",
      `- Error: ${message}`,
      "- No config or policy changes were written.",
    ].join("\n"),
  );
}

export function formatRatchetToolResult<TDetails>(
  details: TDetails,
  text: string,
): RatchetToolResult<TDetails> {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  const outputText = truncation.truncated
    ? `${truncation.content}\n\n[ratchet output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`
    : truncation.content;

  return {
    content: [{ type: "text", text: outputText }],
    details,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
