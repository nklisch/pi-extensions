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

describe("query_subagent_session tool", () => {
  it("is parent-only, read-only, and returns bounded matches with metadata", async () => {
    const record = fakeRecord({
      agentMessages: [
        { role: "user", content: "inspect the deployment", timestamp: 1 } as SessionMessage,
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "deploy.md" } }], timestamp: 2, stopReason: "toolUse" } as unknown as SessionMessage,
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "deployment notes" }], isError: false, timestamp: 3 } as SessionMessage,
      ],
    });
    const tool = new QuerySessionTool({ getRecord: (id) => id === "child-a" ? record : undefined }, () => "");
    const result = await tool.execute("tool-1", { agent_id: "child-a", query: "deployment", kind: "all", order: "oldest", limit: 5 }, undefined, undefined, undefined);

    expect(text(result)).toContain("Agent child-a run=3");
    expect(text(result)).toContain("deployment notes");
    expect(result.details).toMatchObject({
      outcome: "matches",
      agentId: "child-a",
      source: "live",
      totalMatches: 2,
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
      { role: "user", content: "persisted marker", timestamp: 10 },
    ];
    const file = [
      JSON.stringify({ type: "session", id: "s1", cwd: "/tmp", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: fileMessages[0] }),
    ].join("\n");
    const tool = new QuerySessionTool({ getRecord: () => record }, () => file);
    const result = await tool.execute("tool-1", { agent_id: "child-a", query: "persisted" }, undefined, undefined, undefined);

    expect(result.details).toMatchObject({ outcome: "matches", source: "file", transcriptPath: path });
    expect(text(result)).toContain("persisted marker");
  });

  it("bounds total text and reports omitted matches", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: "user",
      content: `marker ${index} ${"x".repeat(2_000)}`,
      timestamp: index,
    } as unknown as SessionMessage));
    const tool = new QuerySessionTool({ getRecord: () => fakeRecord({ agentMessages: messages }) }, () => "");
    const response = await tool.execute("tool-1", { agent_id: "child-a", query: "marker", limit: 50 }, undefined, undefined, undefined);
    expect(text(response).length).toBeLessThan(40_000 + 1_000);
    expect(response.details).toMatchObject({ outcome: "matches", totalMatches: 30, hasMore: true, omittedCount: expect.any(Number), truncation: { output: true } });
  });

  it("keeps newline-dense and multibyte output below Pi's byte and line bounds", async () => {
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

  it("reports not-found, unavailable, no-match, and invalid bounds without throwing", async () => {
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

    const noMatch = await new QuerySessionTool({ getRecord: () => fakeRecord() }, () => "").execute("tool-1", { agent_id: "child-a", query: "absent" }, undefined, undefined, undefined);
    expect(noMatch.details).toMatchObject({ outcome: "no_matches", totalMatches: 0 });
    expect(text(noMatch)).toContain("No transcript entries match");

    const invalid = await new QuerySessionTool({ getRecord: () => fakeRecord() }, () => "").execute("tool-1", { agent_id: "child-a", limit: 0 }, undefined, undefined, undefined);
    expect(text(invalid)).toContain("limit must be");
  });

  it("publishes the bounded TypeBox definition", () => {
    const definition = new QuerySessionTool({ getRecord: () => undefined }, () => "").toToolDefinition();
    expect(definition.name).toBe("query_subagent_session");
    expect(definition.parameters.properties).toHaveProperty("agent_id");
    expect(definition.parameters.properties).toHaveProperty("kind");
    expect(definition.parameters.properties).toHaveProperty("limit");
  });
});
