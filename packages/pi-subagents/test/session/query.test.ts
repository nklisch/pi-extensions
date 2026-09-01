import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LIMIT,
  MESSAGE_EXCERPT_CAP,
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
    expect(querySession([user("AİB")], { query: "\u0307", kind: "messages" }).entries[0]).toMatchObject({
      match: { field: "text", sourceRange: { start: 1, end: 2 } },
    });
  });
});

describe("session query bounds and scopes", () => {
  it("applies kind scopes, empty-query previews, order, and limits", () => {
    const messages = [user("one"), assistant([toolCall("a", "read", { path: "one" })]), result("a", "result one"), user("two"), bash("echo two", "result two")];
    expect(querySession(messages, { kind: "messages", order: "oldest", limit: 50 }).entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
    expect(querySession(messages, { kind: "tool_results", query: "result", order: "oldest" }).entries).toHaveLength(2);
    expect(querySession(messages, { kind: "tool_calls", order: "newest" }).entries.map((entry) => entry.id)).toEqual(["bash:4", "a"]);
    const limited = querySession(messages, { order: "oldest", limit: 1 });
    expect(limited).toMatchObject({ totalMatches: 4, returnedCount: 1, omittedBefore: 0, omittedAfter: 3, outcome: "matches", hasMore: true, nextOffset: 1 });
    expect(limited.entries).toHaveLength(1);

    const preview = querySession([user("p".repeat(MESSAGE_EXCERPT_CAP + 50))], { query: "" });
    expect(preview.entries[0]).toMatchObject({ truncation: { excerpts: ["text"] } });
    expect(preview.entries[0]!.kind === "message" && preview.entries[0]!.text).toHaveLength(MESSAGE_EXCERPT_CAP);
    expect(preview.entries[0]!.match).toBeUndefined();
  });

  it("searches complete assistant, argument, and result fields and centers the first match", () => {
    const assistantNeedle = "assistant-phrase-beyond-search-prefix";
    const argumentNeedle = "argument-phrase-beyond-search-prefix";
    const resultNeedle = "result-phrase-beyond-search-prefix";
    const messages = [
      assistant([{ type: "text", text: `${"a".repeat(9_000)}${assistantNeedle}${"b".repeat(9_000)}` }]),
      assistant([toolCall("long-call", "read", { value: `${"c".repeat(9_000)}${argumentNeedle}${"d".repeat(200)}` })]),
      result("long-call", `${"e".repeat(9_000)}${resultNeedle}${"f".repeat(200)}`),
    ];

    const messageMatch = querySession(messages, { query: assistantNeedle, kind: "messages", order: "oldest" });
    expect(messageMatch).toMatchObject({ totalMatches: 1, returnedCount: 1, searchComplete: true, outcome: "matches" });
    expect(messageMatch.entries[0]).toMatchObject({
      kind: "message",
      match: { field: "text", sourceRange: { start: 9_000, end: 9_000 + assistantNeedle.length } },
      truncation: { excerpts: ["text"] },
    });
    const messageEntry = messageMatch.entries[0]!;
    expect(messageEntry.kind === "message" && messageEntry.text).toContain(assistantNeedle);
    expect(messageEntry.kind === "message" && messageEntry.text.startsWith("…")).toBe(true);
    expect(messageEntry.kind === "message" && messageEntry.text.endsWith("…")).toBe(true);
    expect(messageEntry.kind === "message" && messageEntry.text.length).toBeLessThanOrEqual(MESSAGE_EXCERPT_CAP);

    const argumentMatch = querySession(messages, { query: argumentNeedle, kind: "tool_calls", order: "oldest" });
    expect(argumentMatch.entries[0]).toMatchObject({
      kind: "tool_call",
      match: { field: "arguments" },
      truncation: { excerpts: ["arguments", "result"] },
    });
    expect(argumentMatch.entries[0]!.kind === "tool_call" && argumentMatch.entries[0]!.arguments).toContain(argumentNeedle);
    expect(argumentMatch.entries[0]!.kind === "tool_call" && argumentMatch.entries[0]!.arguments.length).toBeLessThanOrEqual(TOOL_ARGUMENTS_EXCERPT_CAP);

    const resultMatch = querySession(messages, { query: resultNeedle, kind: "tool_results", order: "oldest" });
    expect(resultMatch.entries[0]).toMatchObject({
      kind: "tool_call",
      match: { field: "result", sourceRange: { start: 9_000, end: 9_000 + resultNeedle.length } },
      truncation: { excerpts: ["arguments", "result"] },
    });
    expect(resultMatch.entries[0]!.kind === "tool_call" && resultMatch.entries[0]!.result).toContain(resultNeedle);
    expect(resultMatch.entries[0]!.kind === "tool_call" && resultMatch.entries[0]!.result?.length).toBeLessThanOrEqual(TOOL_RESULT_EXCERPT_CAP);
    expect(resultMatch.entries[0]).not.toHaveProperty("searchFields");
  });

  it("paginates the ordered matching set after kind and order filters", () => {
    const messages = [
      user("message marker 0", 1),
      assistant([toolCall("call-1", "read", { marker: 1 })], 2),
      result("call-1", "result marker 1"),
      user("message marker 2", 4),
      assistant([toolCall("call-3", "read", { marker: 3 })], 5),
      result("call-3", "result marker 3"),
      user("message marker 4", 7),
    ];
    const page = querySession(messages, { query: "marker", kind: "messages", order: "oldest", limit: 2, offset: 2 });
    expect(page.entries.map((entry) => entry.kind === "message" ? entry.text : "")).toEqual(["message marker 4"]);
    expect(page).toMatchObject({ outcome: "matches", totalMatches: 3, offset: 2, returnedCount: 1, omittedBefore: 2, omittedAfter: 0 });
    expect(page.nextOffset).toBeUndefined();
    expect(page.previousOffset).toBe(0);

    const newestTools = querySession(messages, { query: "marker", kind: "tool_calls", order: "newest", limit: 1, offset: 1 });
    expect(newestTools.entries[0]).toMatchObject({ id: "call-1", kind: "tool_call" });
    expect(newestTools).toMatchObject({ totalMatches: 2, offset: 1, omittedBefore: 1, omittedAfter: 0, previousOffset: 0 });
  });

  it("distinguishes no matches from an out-of-range page", () => {
    const messages = [user("only marker")];
    expect(querySession(messages, { query: "missing", offset: 99 })).toMatchObject({ outcome: "no_matches", totalMatches: 0, offset: 99, omittedBefore: 0, omittedAfter: 0 });
    expect(querySession(messages, { query: "marker", offset: 1 })).toMatchObject({ outcome: "page_out_of_range", totalMatches: 1, returnedCount: 0, omittedBefore: 1, omittedAfter: 0, previousOffset: 0, hasMore: false });
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

  it("rejects limits and offsets outside the contract", () => {
    expect(() => querySession([], { limit: 0 })).toThrow("limit must be");
    expect(() => querySession([], { limit: 51 })).toThrow("limit must be");
    expect(() => querySession([], { limit: 1.5 })).toThrow("limit must be");
    expect(() => querySession([], { offset: -1 })).toThrow("offset must be");
    expect(() => querySession([], { offset: Number.MAX_SAFE_INTEGER + 1 })).toThrow("offset must be");
    expect(MAX_QUERY_LIMIT).toBe(50);
  });
});
