import { readFileSync } from "node:fs";

import {
  type ExtensionContext,
  parseSessionEntries,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type {
  HistoryBounds,
  SessionHistorySource,
  SessionToolCall,
  SourceReadResult,
} from "../history.ts";

export type ReadonlySessionManager = ExtensionContext["sessionManager"];

interface AssistantToolCallBlock {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface AssistantMessageLike {
  readonly role: "assistant";
  readonly content: readonly unknown[];
}

export interface SessionHistoryAdapterOptions {
  readonly sessionManager: ReadonlySessionManager;
  readonly bounds?: HistoryBounds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAssistantMessage(value: unknown): value is AssistantMessageLike {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    Array.isArray(value.content)
  );
}

function isToolCallBlock(value: unknown): value is AssistantToolCallBlock {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.arguments)
  );
}

function warningMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function applyBounds(
  items: readonly SessionToolCall[],
  bounds: HistoryBounds | undefined,
  warnings: string[],
): readonly SessionToolCall[] {
  let bounded = items;

  if (bounds?.since !== undefined) {
    const since = parseTimestamp(bounds.since);
    if (since === undefined) {
      warnings.push("history bounds since value was invalid; ignored");
    } else {
      bounded = bounded.filter((item) => {
        const timestamp = parseTimestamp(item.timestamp);
        return timestamp === undefined || timestamp >= since;
      });
    }
  }

  if (bounds?.maxToolCalls !== undefined) {
    const maxToolCalls = Math.trunc(bounds.maxToolCalls);
    if (maxToolCalls <= 0) {
      return [];
    }

    if (bounded.length > maxToolCalls) {
      bounded = bounded.slice(-maxToolCalls);
    }
  }

  return bounded;
}

function sessionMismatchWarning(
  actualSessionId: string,
  requestedSessionId: string,
): string {
  return `session ${actualSessionId} did not match requested session ${requestedSessionId}; skipped`;
}

function stableJsonForDisplay(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value)) ?? "";
  } catch {
    return "";
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJson(value[key]);
  }
  return out;
}

export function createSessionHistorySource(
  options: SessionHistoryAdapterOptions,
): SessionHistorySource {
  return {
    sessionId:
      options.bounds?.sessionId ?? options.sessionManager.getSessionId(),
    read(): SourceReadResult<SessionToolCall> {
      try {
        const sessionId = options.sessionManager.getSessionId();
        const entries =
          options.bounds?.leafBranchOnly === true
            ? options.sessionManager.getBranch()
            : options.sessionManager.getEntries();

        return projectSessionToolCalls(entries, sessionId, options.bounds);
      } catch (error) {
        return {
          items: [],
          warnings: [
            `could not read session history: ${warningMessage(error)}`,
          ],
        };
      }
    },
  };
}

/** Project Pi session entries into bash/non-bash tool calls. */
export function projectSessionToolCalls(
  entries: readonly SessionEntry[],
  sessionId: string,
  bounds?: HistoryBounds,
): SourceReadResult<SessionToolCall> {
  const warnings: string[] = [];

  if (bounds?.sessionId !== undefined && bounds.sessionId !== sessionId) {
    return {
      items: [],
      warnings: [sessionMismatchWarning(sessionId, bounds.sessionId)],
    };
  }

  const items: SessionToolCall[] = [];

  for (const entry of entries) {
    if (entry.type !== "message" || !isAssistantMessage(entry.message)) {
      continue;
    }

    for (const block of entry.message.content) {
      if (!isToolCallBlock(block)) {
        continue;
      }

      const commandValue = block.arguments.command;
      items.push({
        toolCallId: block.id,
        toolName: block.name,
        command:
          typeof commandValue === "string"
            ? commandValue
            : stableJsonForDisplay(block.arguments),
        toolInput: block.arguments,
        sessionId,
        timestamp: entry.timestamp,
      });
    }
  }

  return {
    items: applyBounds(items, bounds, warnings),
    warnings,
  };
}

/** Offline path: read a session JSONL file without a live SessionManager. */
export function createSessionFileSource(options: {
  readonly path: string;
  readonly bounds?: HistoryBounds;
}): SessionHistorySource {
  return {
    read(): SourceReadResult<SessionToolCall> {
      try {
        const fileEntries = parseSessionEntries(
          readFileSync(options.path, "utf8"),
        );
        const header = fileEntries.find(
          (
            entry,
          ): entry is Extract<
            (typeof fileEntries)[number],
            { type: "session" }
          > => entry.type === "session",
        );
        const sessionId =
          header?.id ?? options.bounds?.sessionId ?? "unknown-session";
        const entries = fileEntries.filter(
          (entry): entry is SessionEntry => entry.type !== "session",
        );

        const result = projectSessionToolCalls(
          entries,
          sessionId,
          options.bounds,
        );
        if (header === undefined) {
          return {
            items: result.items,
            warnings: [
              `session file ${options.path} had no session header; used ${sessionId}`,
              ...result.warnings,
            ],
          };
        }

        return result;
      } catch (error) {
        return {
          items: [],
          warnings: [
            `could not read session file ${options.path}: ${warningMessage(error)}`,
          ],
        };
      }
    },
  };
}
