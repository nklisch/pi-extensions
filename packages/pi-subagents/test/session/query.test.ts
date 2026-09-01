import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LIMIT,
  MESSAGE_EXCERPT_CAP,
  QUERY_SEARCH_FIELD_CAP,
  TOOL_ARGUMENTS_EXCERPT_CAP,
  TOOL_RESULT_EXCERPT_CAP,
  projectSessionMessages,
  querySession,
} from "#src/session/query";
import type { SessionMessage } from "#src/types";

function user(text: string, timestamp = 1_000): SessionMessage {
  return { role: "user", content: text, timestamp } as SessionMessage;
}

function assistant(content: unknown[], timestamp = 1_001): SessionMessage {
  return { role: "assistant", content, timestamp, stopReason: "toolUse" } as SessionMessage;
}

function toolCall(id: string, name: string, args: unknown): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

function result(toolCallId: string, text: string, isError = false): SessionMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "ignored-by-correlation",
    content: [{ type: "text", text }],
    isError,
    timestamp: 1_002,
  } as SessionMessage;
}

function bash(command: string, output: string, exitCode: number | undefined = 0): SessionMessage {
  return { role: "bashExecution", command, output, exitCode, cancelled: false, truncated: false, timestamp: 1_003 } as SessionMessage;
}

describe("session query projection", () => {
  it("correlates multiple and out-of-order tool results without duplicate rows", () => {
    const messages = [
      assistant([{ type: "text", text: "running both calls" }, toolCall("call-a", "read", { path: "a.txt" }), toolCall("call-b", "bash", { command: "npm test" })]),
      result("call-b", "test output"),
      result("orphan", "must not become a row"),
      result("call-a", "file contents", true),
      user("finish this"),
    ];

    const entries = projectSessionMessages(messages);
    expect(entries).toHaveLength(4);
    expect(entries.filter((entry) => entry.kind === "message")).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === "tool_call")).toHaveLength(2);
    expect(entries.find((entry) => entry.id === "call-a")).toMatchObject({ state: "failed", result: "file contents", toolName: "read" });
    expect(entries.find((entry) => entry.id === "call-b")).toMatchObject({ state: "completed", result: "test output", toolName: "bash" });
  });

  it("keeps pending calls queryable and represents native bash as one tool entry", () => {
    const entries = projectSessionMessages([assistant([toolCall("pending", "grep", { pattern: "needle" })]), bash("bun test", "")]);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool_call", id: "pending", state: "pending" }),
      expect.objectContaining({ kind: "tool_call", id: "bash:1", toolName: "bash", state: "completed" }),
    ]));
  });

  it("uses projection-local message identities and literal Unicode matching", () => {
    const messages = [user("ÄPFEL and [literal]"), assistant([toolCall("id-42", "SearchTool", { needle: "ÄPFEL" })])];
    const entries = projectSessionMessages(messages);
    expect(entries[0]!.id).toBe("message:user:0:1000");
    expect(querySession(messages, { query: "äpfel", kind: "messages", order: "oldest" }).entries).toHaveLength(1);
    expect(querySession(messages, { query: "[literal]", kind: "messages" }).entries).toHaveLength(1);
    expect(querySession(messages, { query: "id-42", kind: "tool_calls" }).entries).toHaveLength(1);
    expect(querySession(messages, { query: "searchtool", kind: "tool_results" }).entries).toHaveLength(0);
  });
});

describe("session query bounds and scopes", () => {
  it("applies kind scopes, empty-query recent entries, order, and limits", () => {
    const messages = [user("one"), assistant([toolCall("a", "read", { path: "one" })]), result("a", "result one"), user("two"), bash("echo two", "result two")];
    expect(querySession(messages, { kind: "messages", order: "oldest", limit: 50 }).entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
    expect(querySession(messages, { kind: "tool_results", query: "result", order: "oldest" }).entries).toHaveLength(2);
    expect(querySession(messages, { kind: "tool_calls", order: "newest" }).entries.map((entry) => entry.id)).toEqual(["bash:4", "a"]);
    const limited = querySession(messages, { order: "oldest", limit: 1 });
    expect(limited).toMatchObject({ totalMatches: 4, omittedCount: 3, hasMore: true });
    expect(limited.entries).toHaveLength(1);
  });

  it("keeps empty completed and failed tool results distinct from pending calls", () => {
    const messages = [
      assistant([toolCall("empty-success", "silent", {})]),
      result("empty-success", ""),
      assistant([toolCall("empty-failure", "silent", {})]),
      result("empty-failure", "", true),
      assistant([toolCall("pending", "silent", {})]),
    ];

    const entries = querySession(messages, { kind: "tool_results", order: "oldest", limit: 50 }).entries;
    expect(entries).toEqual([
      expect.objectContaining({ id: "empty-success", state: "completed", result: "" }),
      expect.objectContaining({ id: "empty-failure", state: "failed", result: "" }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it("caps each searchable field and returned excerpt independently", () => {
    const longArgument = "a".repeat(QUERY_SEARCH_FIELD_CAP + 5_000);
    const longResult = "r".repeat(TOOL_RESULT_EXCERPT_CAP + 5_000);
    const longMessage = "m".repeat(QUERY_SEARCH_FIELD_CAP + 5_000);
    const messages = [
      user(longMessage),
      assistant([toolCall("bounded", "read", { value: longArgument })]),
      result("bounded", longResult),
    ];
    const entries = projectSessionMessages(messages);
    const messageEntry = entries.find((entry) => entry.kind === "message")!;
    const toolEntry = entries.find((entry) => entry.id === "bounded")!;
    expect(messageEntry.kind === "message" && messageEntry.text).toHaveLength(MESSAGE_EXCERPT_CAP);
    expect(toolEntry.kind === "tool_call" && toolEntry.arguments.length).toBeLessThanOrEqual(TOOL_ARGUMENTS_EXCERPT_CAP);
    expect(toolEntry.kind === "tool_call" && toolEntry.result?.length).toBeLessThanOrEqual(TOOL_RESULT_EXCERPT_CAP);
    expect(toolEntry.truncation).toEqual({ searchFields: ["arguments", "result"], excerpts: ["arguments", "result"] });
    expect(messageEntry.truncation).toEqual({ searchFields: ["text"], excerpts: ["text"] });
    expect(QUERY_SEARCH_FIELD_CAP).toBeGreaterThan(MESSAGE_EXCERPT_CAP);
    expect(MAX_QUERY_LIMIT).toBe(50);
    expect(querySession(messages, { query: "r" }).entries).toHaveLength(1);
  });

  it("rejects limits outside the contract", () => {
    expect(() => querySession([], { limit: 0 })).toThrow("limit must be");
    expect(() => querySession([], { limit: 51 })).toThrow("limit must be");
    expect(() => querySession([], { limit: 1.5 })).toThrow("limit must be");
  });
});
