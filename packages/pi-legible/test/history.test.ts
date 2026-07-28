import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatHistory, MessageHistory } from "../src/history.js";

function user(text: string, timestamp: number): UserMessage {
  return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp,
  };
}

function toolResult(text: string, timestamp: number): ToolResultMessage {
  return { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp };
}

describe("MessageHistory", () => {
  it("dedupes by timestamp (session restore re-fires message_end)", () => {
    const history = new MessageHistory();
    history.push(user("hi", 1));
    history.push(user("hi", 1));
    expect(history.recent(10)).toHaveLength(1);
  });

  it("returns the most recent `depth` messages, oldest first", () => {
    const history = new MessageHistory();
    for (let i = 1; i <= 5; i++) history.push(user(`m${i}`, i));
    expect(history.recent(2).map((m) => (m as UserMessage).content)).toEqual(["m4", "m5"]);
    expect(history.recent(0)).toEqual([]);
  });

  it("clones on push so later in-place mutation of the live message does not leak rewrites into history", () => {
    const history = new MessageHistory();
    const live = assistant("original text", 1);
    history.push(live);
    (live.content[0] as { text: string }).text = "REWRITTEN text";
    const stored = history.recent(1)[0] as AssistantMessage;
    expect((stored.content[0] as { text: string }).text).toBe("original text");
  });
});

describe("formatHistory", () => {
  it("renders a compact transcript", () => {
    const text = formatHistory([user("fix the bug", 1), assistant("done", 2)], { includeToolCalls: false });
    expect(text).toBe("User: fix the bug\nAssistant: done");
  });

  it("excludes tool calls and results when includeToolCalls is false", () => {
    const withTool: AssistantMessage = {
      ...assistant("checking", 2),
      content: [
        { type: "text", text: "checking" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
      ],
    };
    const text = formatHistory([withTool, toolResult("file.ts", 3)], { includeToolCalls: false });
    expect(text).toBe("Assistant: checking");
  });

  it("includes tool calls and results when includeToolCalls is true", () => {
    const withTool: AssistantMessage = {
      ...assistant("checking", 2),
      content: [
        { type: "text", text: "checking" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
      ],
    };
    const text = formatHistory([withTool, toolResult("file.ts", 3)], { includeToolCalls: true });
    expect(text).toContain("Assistant called tool bash(");
    expect(text).toContain("Tool bash returned: file.ts");
  });

  it("caps total transcript length", () => {
    const long = formatHistory([user("x".repeat(10_000), 1)], { includeToolCalls: false });
    expect(long.length).toBeLessThanOrEqual(4100);
  });
});
