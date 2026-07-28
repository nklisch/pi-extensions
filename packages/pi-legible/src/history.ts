import type { Message } from "@earendil-works/pi-ai";

/**
 * Rolling buffer of recent ORIGINAL conversation messages, fed from
 * `message_end` events before any rewrite is applied. This is the only
 * context the rewriter sees beyond the target text — deliberately small
 * (user-configurable depth) so the rewriter has enough to resolve
 * references like "the tests" or "that file" without being flooded.
 *
 * In-memory only: restored sessions start with an empty buffer, which
 * just means the first few rewrites see less context.
 */

const BUFFER_CAPACITY = 50;
/** Per-message and total caps keep the rewriter prompt cheap. */
const PER_MESSAGE_CHAR_CAP = 800;
const TOTAL_CHAR_CAP = 4000;

export class MessageHistory {
  private messages: Message[] = [];
  private seenTimestamps = new Set<number>();

  push(message: Message): void {
    // Session navigation/restore can re-fire message_end for the same
    // message; timestamps are the dedupe key.
    if (this.seenTimestamps.has(message.timestamp)) return;
    this.seenTimestamps.add(message.timestamp);
    // Clone: pi may mutate the live message object in place when applying
    // our replacement, and the rewriter must see ORIGINALS, never rewrites.
    this.messages.push(structuredClone(message));
    if (this.messages.length > BUFFER_CAPACITY) {
      const dropped = this.messages.shift();
      if (dropped !== undefined) this.seenTimestamps.delete(dropped.timestamp);
    }
  }

  /** The most recent `depth` messages, oldest first. */
  recent(depth: number): Message[] {
    if (depth <= 0) return [];
    return this.messages.slice(-depth);
  }

  clear(): void {
    this.messages = [];
    this.seenTimestamps.clear();
  }
}

export interface FormatOptions {
  includeToolCalls: boolean;
}

/** Render messages as a compact transcript for the rewriter prompt. */
export function formatHistory(messages: readonly Message[], options: FormatOptions): string {
  const lines: string[] = [];
  for (const message of messages) {
    lines.push(...formatMessage(message, options));
  }
  let text = lines.join("\n");
  if (text.length > TOTAL_CHAR_CAP) {
    text = `…${text.slice(text.length - TOTAL_CHAR_CAP)}`;
  }
  return text;
}

function formatMessage(message: Message, options: FormatOptions): string[] {
  switch (message.role) {
    case "user": {
      const text = typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
      return [`User: ${cap(text)}`];
    }
    case "assistant": {
      const lines: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          lines.push(`Assistant: ${cap(block.text)}`);
        } else if (block.type === "toolCall" && options.includeToolCalls) {
          lines.push(`Assistant called tool ${block.name}(${cap(JSON.stringify(block.arguments), 200)})`);
        }
      }
      return lines;
    }
    case "toolResult": {
      if (!options.includeToolCalls) return [];
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const marker = message.isError ? "errored" : "returned";
      return [`Tool ${message.toolName} ${marker}: ${cap(text, 400)}`];
    }
  }
}

function cap(text: string, limit = PER_MESSAGE_CHAR_CAP): string {
  const collapsed = text.replaceAll("\n", " ⏎ ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}
