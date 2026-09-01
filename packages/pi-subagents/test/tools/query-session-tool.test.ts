import { TypeCompiler } from "@sinclair/typebox/compiler";
import { describe, expect, it } from "vitest";
import type { Subagent } from "#src/lifecycle/subagent";
import { QuerySessionTool } from "#src/tools/query-session-tool";
import type { SessionMessage } from "#src/types";

function fakeRecord(overrides: Partial<Record<string, unknown>> = {}): Subagent {
  const messages: readonly SessionMessage[] = [
    { role: "user", content: "inspect the deployment", timestamp: 1 } as SessionMessage,
    { role: "assistant", content: [{ type: "text", text: "I will inspect it." }], timestamp: 2, stopReason: "stop" } as SessionMessage,
  ];
  return {
    id: "child-a",
    runId: 3,
    mode: "detached",
    status: "completed",
    stateTerminalReason: "completed",
    modelLabel: "test-model",
    effectiveThinkingLevel: "low",
    activeRuntimeMs: 42,
    activeTools: new Map(),
    responseText: "",
    outputFile: undefined,
    agentMessages: messages,
    isSessionReady: () => true,
    ...overrides,
  } as unknown as Subagent;
}

function text(response: { content: readonly { text?: string }[] }): string {
  return response.content.map((part) => part.text ?? "").join("\n");
}

function assistant(content: unknown[], timestamp: number): SessionMessage {
  return { role: "assistant", content, timestamp, stopReason: "toolUse" } as SessionMessage;
}

function toolCall(id: string, name: string, args: unknown): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

function result(toolCallId: string, content: string, timestamp: number): SessionMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp,
  } as SessionMessage;
}

function sessionFile(messages: readonly SessionMessage[]): string {
  return [
    JSON.stringify({ type: "session", id: "s1", cwd: "/tmp", timestamp: new Date().toISOString() }),
    ...messages.map((message, index) => JSON.stringify({
      type: "message",
      id: `m${index}`,
      parentId: index === 0 ? null : `m${index - 1}`,
      timestamp: new Date(1_000 + index).toISOString(),
      message,
    })),
  ].join("\n");
}

describe("query_subagent_session tool", () => {
  it("is parent-only, read-only, and returns bounded matches with complete-search metadata", async () => {
    const record = fakeRecord({
      agentMessages: [
        { role: "user", content: "inspect the deployment", timestamp: 1 } as SessionMessage,
        assistant([toolCall("call-1", "read", { path: "deploy.md" })], 2),
        result("call-1", "deployment notes", 3),
      ],
    });
    const tool = new QuerySessionTool({ getRecord: (id) => id === "child-a" ? record : undefined }, () => "");
    const resultValue = await tool.execute("tool-1", { agent_id: "child-a", query: "deployment", kind: "all", order: "oldest", limit: 5 }, undefined, undefined, undefined);

    expect(text(resultValue)).toContain("Agent child-a run=3");
    expect(text(resultValue)).toContain("deployment notes");
    expect(text(resultValue)).toContain("Search: complete (full transcript fields).");
    expect(resultValue.details).toMatchObject({
      outcome: "matches",
      agentId: "child-a",
      source: "live",
      searchComplete: true,
      totalMatches: 2,
      returnedCount: 2,
      omittedBefore: 0,
      omittedAfter: 0,
      entries: expect.arrayContaining([expect.objectContaining({ kind: "message" })]),
    });
  });

  it("uses a retained transcript file when the live session is gone", async () => {
    const path = "/tmp/child.jsonl";
    const record = fakeRecord({
      outputFile: path,
      agentMessages: [],
      isSessionReady: () => false,
    });
    const fileMessages = [
      { role: "user", content: "persisted marker", timestamp: 10 } as SessionMessage,
    ];
    const tool = new QuerySessionTool({ getRecord: () => record }, () => sessionFile(fileMessages));
    const resultValue = await tool.execute("tool-1", { agent_id: "child-a", query: "persisted" }, undefined, undefined, undefined);

    expect(resultValue.details).toMatchObject({ outcome: "matches", source: "file", transcriptPath: path, searchComplete: true });
    expect(text(resultValue)).toContain("persisted marker");
  });

  it("keeps live and persisted sources complete for independent long-field queries", async () => {
    const messageNeedle = "persisted-message-phrase-beyond-the-old-cap";
    const argumentNeedle = "persisted-argument-phrase-beyond-the-old-cap";
    const resultNeedle = "persisted-result-phrase-beyond-the-old-cap";
    const messageText = `${"a".repeat(9_000)}${messageNeedle}${"b".repeat(9_000)}`;
    const argumentText = `${"c".repeat(9_000)}${argumentNeedle}${"d".repeat(9_000)}`;
    const argumentJson = JSON.stringify({ value: argumentText });
    const resultText = `${"e".repeat(9_000)}${resultNeedle}${"f".repeat(9_000)}`;
    const messages = [
      assistant([{ type: "text", text: messageText }], 1),
      assistant([toolCall("parity-call", "read", { value: argumentText })], 2),
      result("parity-call", resultText, 3),
    ];
    const cases = [
      { query: messageNeedle, kind: "messages", field: "text", source: messageText, cap: 2_000, visible: (entry: any) => entry.text },
      { query: argumentNeedle, kind: "tool_calls", field: "arguments", source: argumentJson, cap: 2_000, visible: (entry: any) => entry.arguments },
      { query: resultNeedle, kind: "tool_results", field: "result", source: resultText, cap: 4_000, visible: (entry: any) => entry.result },
    ] as const;

    for (const testCase of cases) {
      const params = { agent_id: "child-a", query: testCase.query, kind: testCase.kind, order: "oldest" as const, limit: 50 };
      const live = await new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: messages }) }, () => "").execute(
        "tool-1", params, undefined, undefined, undefined,
      );
      const file = await new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: [], outputFile: "/tmp/parity.jsonl", isSessionReady: () => false }) }, () => sessionFile(messages)).execute(
        "tool-1", params, undefined, undefined, undefined,
      );
      const start = testCase.source.indexOf(testCase.query);
      const expectedMatch = { field: testCase.field, sourceRange: { start, end: start + testCase.query.length } };

      for (const response of [live, file]) {
        const details = response.details as { entries: readonly any[] };
        expect(response.details).toMatchObject({
          totalMatches: 1,
          returnedCount: 1,
          omittedBefore: 0,
          omittedAfter: 0,
          searchComplete: true,
        });
        expect(details.entries[0]).toMatchObject({ match: expectedMatch });
        const visible = testCase.visible(details.entries[0]);
        expect(visible).toContain(testCase.query);
        expect(visible.startsWith("…")).toBe(true);
        expect(visible.endsWith("…")).toBe(true);
        expect(visible.length).toBeLessThanOrEqual(testCase.cap);
        expect(text(response)).toContain(testCase.query);
        expect(text(response)).toContain(`match=${testCase.field} [${start},${start + testCase.query.length})`);
      }

      expect((file.details as { entries: readonly unknown[] }).entries)
        .toEqual((live.details as { entries: readonly unknown[] }).entries);
    }
  });

  it("returns match-centered excerpts for the regression beyond the former prefix", async () => {
    const messageNeedle = "assistant phrase beyond eight thousand characters";
    const argumentNeedle = "tool argument phrase beyond eight thousand characters";
    const resultNeedle = "tool result phrase beyond eight thousand characters";
    const messages = [
      assistant([{ type: "text", text: `${"m".repeat(9_000)}${messageNeedle}${"n".repeat(100)}` }], 1),
      assistant([toolCall("long-call", "read", { value: `${"a".repeat(9_000)}${argumentNeedle}` })], 2),
      result("long-call", `${"r".repeat(9_000)}${resultNeedle}`, 3),
    ];
    const tool = new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: messages }) }, () => "");

    const message = await tool.execute("tool-1", { agent_id: "child-a", query: messageNeedle, kind: "messages", order: "oldest" }, undefined, undefined, undefined);
    const argument = await tool.execute("tool-1", { agent_id: "child-a", query: argumentNeedle, kind: "tool_calls", order: "oldest" }, undefined, undefined, undefined);
    const output = await tool.execute("tool-1", { agent_id: "child-a", query: resultNeedle, kind: "tool_results", order: "oldest" }, undefined, undefined, undefined);

    expect(text(message)).toContain(messageNeedle);
    expect(text(argument)).toContain(argumentNeedle);
    expect(text(output)).toContain(resultNeedle);
    expect(message.details).toMatchObject({ searchComplete: true });
    expect((message.details as { entries: readonly unknown[] }).entries[0]).toMatchObject({ match: { field: "text" } });
    expect(argument.details).toMatchObject({ searchComplete: true });
    expect((argument.details as { entries: readonly unknown[] }).entries[0]).toMatchObject({ match: { field: "arguments" } });
    expect(output.details).toMatchObject({ searchComplete: true });
    expect((output.details as { entries: readonly unknown[] }).entries[0]).toMatchObject({ match: { field: "result" } });
    expect(text(message)).toMatch(/match=text \[9000,\d+\)/);
    expect(text(argument)).toMatch(/match=arguments \[\d+,\d+\)/);
    expect(text(output)).toMatch(/match=result \[9000,\d+\)/);
  });

  it("pages normally and advances after only entries returned under output bounds", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "user",
      content: `${"prefix ".repeat(250)}page marker ${index}${" suffix".repeat(20)}`,
      timestamp: index,
    } as unknown as SessionMessage));
    const tool = new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: messages }) }, () => "");
    const first = await tool.execute("tool-1", { agent_id: "child-a", query: "page marker", order: "oldest", limit: 2 }, undefined, undefined, undefined);
    const firstDetails = first.details as { entries: readonly { id: string }[]; nextOffset?: number; returnedCount: number };
    expect(first.details).toMatchObject({ totalMatches: 20, offset: 0, returnedCount: 2, omittedBefore: 0, omittedAfter: 18, nextOffset: 2, hasMore: true });
    expect(text(first)).toContain("repeat with offset: 2");

    const second = await tool.execute("tool-1", { agent_id: "child-a", query: "page marker", order: "oldest", limit: 2, offset: firstDetails.nextOffset }, undefined, undefined, undefined);
    expect(second.details).toMatchObject({ totalMatches: 20, offset: 2, returnedCount: 2, omittedBefore: 2, omittedAfter: 16, nextOffset: 4, previousOffset: 0, hasMore: true });
    expect((second.details as { entries: readonly { id: string }[] }).entries[0]!.id).not.toBe(firstDetails.entries[0]!.id);

    const shortenedMessages = Array.from({ length: 20 }, (_, index) => ({
      role: "user",
      content: `${"prefix ".repeat(160)}shortened marker ${index}${" suffix".repeat(160)}`,
      timestamp: index,
    } as unknown as SessionMessage));
    const shortenedTool = new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: shortenedMessages }) }, () => "");
    const shortened = await shortenedTool.execute("tool-1", { agent_id: "child-a", query: "shortened marker", order: "oldest", limit: 20 }, undefined, undefined, undefined);
    const shortenedDetails = shortened.details as { entries: readonly { id: string }[]; nextOffset?: number; returnedCount: number };
    expect(shortenedDetails.returnedCount).toBeLessThan(20);
    expect(shortenedDetails.nextOffset).toBe(shortenedDetails.returnedCount);
    const continuation = await shortenedTool.execute("tool-1", { agent_id: "child-a", query: "shortened marker", order: "oldest", limit: 20, offset: shortenedDetails.nextOffset }, undefined, undefined, undefined);
    expect((continuation.details as { entries: readonly { id: string }[] }).entries[0]!.id).toBe(`message:user:${shortenedDetails.returnedCount}:${shortenedDetails.returnedCount}`);
  });

  it("always emits the first matching entry from a newline-dense page", async () => {
    const marker = "newline-dense match";
    const messages = [{
      role: "user",
      content: `${"prefix\\n".repeat(2_000)}${marker}${"\\n".repeat(2_000)}`,
      timestamp: 0,
    } as unknown as SessionMessage];
    const tool = new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: messages }) }, () => "");
    const response = await tool.execute("tool-1", { agent_id: "child-a", query: marker, order: "oldest", limit: 1 }, undefined, undefined, undefined);
    const details = response.details as { offset: number; returnedCount: number; nextOffset?: number; entries: readonly unknown[] };

    expect(details.entries).toHaveLength(1);
    expect(details.returnedCount).toBe(1);
    expect(details.nextOffset === undefined || details.nextOffset > details.offset).toBe(true);
    expect(text(response)).toContain(marker);
    expect(text(response).split(/\\r\\n|\\r|\\n/).length).toBeLessThan(2_000);
  });

  it("bounds pathological tool metadata while preserving match and correlation identities", async () => {
    const toolNameNeedle = "tool-name-match";
    const toolCallIdNeedle = "tool-call-id-match";
    const toolName = `${"\\n".repeat(9_000)}${toolNameNeedle}${"\\n".repeat(9_000)}`;
    const toolCallId = `${"\\n".repeat(9_000)}${toolCallIdNeedle}${"\\n".repeat(9_000)}`;
    const messages = [assistant([toolCall(toolCallId, toolName, { value: "argument" })], 1)];
    const tool = new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: messages }) }, () => "");

    const nameResponse = await tool.execute("tool-1", { agent_id: "child-a", query: toolNameNeedle, kind: "tool_calls", order: "oldest" }, undefined, undefined, undefined);
    const nameEntry = (nameResponse.details as { entries: readonly any[] }).entries[0]!;
    expect(nameEntry).toMatchObject({ id: toolCallId, match: { field: "toolName" } });
    expect(nameEntry.toolName).toContain(toolNameNeedle);
    expect(nameEntry.toolName.startsWith("…")).toBe(true);
    expect(nameEntry.toolName.endsWith("…")).toBe(true);
    expect(nameEntry.toolName.length).toBeLessThanOrEqual(2_000);
    expect(text(nameResponse)).toContain(toolNameNeedle);

    const idResponse = await tool.execute("tool-1", { agent_id: "child-a", query: toolCallIdNeedle, kind: "tool_calls", order: "oldest" }, undefined, undefined, undefined);
    const idEntry = (idResponse.details as { entries: readonly any[] }).entries[0]!;
    expect(idEntry).toMatchObject({ id: toolCallId, match: { field: "toolCallId" } });
    expect(idEntry.toolCallId).toContain(toolCallIdNeedle);
    expect(idEntry.toolCallId.startsWith("…")).toBe(true);
    expect(idEntry.toolCallId.endsWith("…")).toBe(true);
    expect(idEntry.toolCallId.length).toBeLessThanOrEqual(2_000);
    expect(text(idResponse)).toContain(toolCallIdNeedle);
    expect(text(idResponse).match(new RegExp(toolCallIdNeedle, "g"))).toHaveLength(1);
  });

  it("advances correctly when the line bound shortens a page", async () => {
    const messages = Array.from({ length: 3 }, (_, index) => ({
      role: "user",
      content: `${"x\n".repeat(1_000)}line marker ${index}\n${"y\n".repeat(1_000)}`,
      timestamp: index,
    } as unknown as SessionMessage));
    const tool = new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: messages }) }, () => "");
    const first = await tool.execute("tool-1", { agent_id: "child-a", query: "line marker", order: "oldest", limit: 3 }, undefined, undefined, undefined);
    const details = first.details as { returnedCount: number; nextOffset?: number };
    expect(details.returnedCount).toBe(1);
    expect(details.nextOffset).toBe(1);
    const next = await tool.execute("tool-1", { agent_id: "child-a", query: "line marker", order: "oldest", limit: 3, offset: 1 }, undefined, undefined, undefined);
    expect((next.details as { entries: readonly { id: string }[] }).entries[0]!.id).toBe("message:user:1:1");
  });

  it("keeps total text and newline-dense output below Pi's byte and line bounds", async () => {
    const cases = [
      Array.from({ length: 2 }, (_, index) => ({
        role: "user",
        content: `newline marker ${index}` + "\n".repeat(5_000),
        timestamp: index,
      } as unknown as SessionMessage)),
      Array.from({ length: 30 }, (_, index) => ({
        role: "user",
        content: `unicode marker ${index} ${"界".repeat(2_000)}`,
        timestamp: index,
      } as unknown as SessionMessage)),
    ];

    for (const [caseIndex, messages] of cases.entries()) {
      const tool = new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: messages }) }, () => "");
      const response = await tool.execute("tool-1", { agent_id: "child-a", query: "marker", limit: 50 }, undefined, undefined, undefined);
      const output = text(response);
      expect(new TextEncoder().encode(output).byteLength).toBeLessThan(50 * 1024);
      expect(output.split(/\r\n|\r|\n/).length).toBeLessThan(2_000);
      expect(response.details, `case ${caseIndex}: ${JSON.stringify(response.details)}`).toMatchObject({ hasMore: true, truncation: { output: true } });
    }
  });

  it("reports not-found, unavailable, no-match, and out-of-range pages without throwing", async () => {
    const missing = new QuerySessionTool({ getRecord: () => undefined }, () => "");
    const notFound = await missing.execute("tool-1", { agent_id: "nope" }, undefined, undefined, undefined);
    expect(notFound.details).toMatchObject({ outcome: "not_found", agentId: "nope" });

    const unavailableRecord = fakeRecord({ agentMessages: [], isSessionReady: () => false, outputFile: undefined });
    const unavailableTool = new QuerySessionTool({ getRecord: () => unavailableRecord }, () => "");
    const unavailable = await unavailableTool.execute("tool-1", { agent_id: "child-a" }, undefined, undefined, undefined);
    expect(unavailable.details).toMatchObject({ outcome: "transcript_unavailable" });

    const missingFileRecord = fakeRecord({ agentMessages: [], isSessionReady: () => false, outputFile: "/gone.jsonl" });
    const missingFile = await new QuerySessionTool({ getRecord: () => missingFileRecord }, () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }).execute("tool-1", { agent_id: "child-a" }, undefined, undefined, undefined);
    expect(missingFile.details).toMatchObject({ outcome: "transcript_unavailable", transcriptPath: "/gone.jsonl" });

    const noMatch = await new QuerySessionTool({ getRecord: () => fakeRecord() }, () => "").execute("tool-1", { agent_id: "child-a", query: "absent", offset: 99 }, undefined, undefined, undefined);
    expect(noMatch.details).toMatchObject({ outcome: "no_matches", totalMatches: 0, offset: 99, returnedCount: 0, searchComplete: true });
    expect(text(noMatch)).toContain("No transcript entries match");

    const outOfRange = await new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: [{ role: "user", content: "present marker", timestamp: 1 } as SessionMessage] }) }, () => "").execute("tool-1", { agent_id: "child-a", query: "marker", offset: 1 }, undefined, undefined, undefined);
    expect(outOfRange.details).toMatchObject({ outcome: "page_out_of_range", totalMatches: 1, offset: 1, returnedCount: 0, omittedBefore: 1, omittedAfter: 0, previousOffset: 0, hasMore: false, searchComplete: true });
    expect(text(outOfRange)).not.toContain("No transcript entries match");

    const invalid = await new QuerySessionTool({ getRecord: () => fakeRecord() }, () => "").execute("tool-1", { agent_id: "child-a", offset: -1 }, undefined, undefined, undefined);
    expect(text(invalid)).toContain("offset must be");
  });

  it("publishes and validates the safe offset TypeBox definition", () => {
    const definition = new QuerySessionTool({ getRecord: () => undefined }, () => "").toToolDefinition();
    expect(definition.name).toBe("query_subagent_session");
    expect(definition.parameters.properties).toHaveProperty("agent_id");
    expect(definition.parameters.properties).toHaveProperty("kind");
    expect(definition.parameters.properties).toHaveProperty("limit");
    expect(definition.parameters.properties).toHaveProperty("offset");
    const schema = TypeCompiler.Compile(definition.parameters);
    expect(schema.Check({ agent_id: "child-a", offset: 0 })).toBe(true);
    expect(schema.Check({ agent_id: "child-a", offset: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(schema.Check({ agent_id: "child-a", offset: -1 })).toBe(false);
    expect(schema.Check({ agent_id: "child-a", offset: 1.5 })).toBe(false);
    expect(schema.Check({ agent_id: "child-a", offset: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  });
});
