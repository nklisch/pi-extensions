import type { ExtensionContext, SessionStartEvent, SessionShutdownEvent, InputEvent, ToolCallEvent, ToolResultEvent, SessionBeforeCompactEvent, SessionCompactEvent, AgentSettledEvent } from "@earendil-works/pi-coding-agent";
import type { CurrentProjectRuntimeContext } from "../../../src/application/ports/project-trust.js";

export const fakeSessionStart = (reason: SessionStartEvent["reason"]): SessionStartEvent => ({ type: "session_start", reason });
export const fakeSessionEnd = (reason: SessionShutdownEvent["reason"]): SessionShutdownEvent => ({ type: "session_shutdown", reason });
export const fakeInput = (text: string): InputEvent => ({ type: "input", text, source: "interactive" });
export const fakeToolCall = (input: Record<string, unknown>): ToolCallEvent => ({ type: "tool_call", toolName: "write", toolCallId: "tool-1", input } as ToolCallEvent);
export const fakeToolResult = (isError: boolean): ToolResultEvent => ({ type: "tool_result", toolName: "write", toolCallId: "tool-1", input: { path: "file" }, content: [{ type: "text", text: isError ? "failed" : "ok" }], details: { changed: !isError }, isError } as ToolResultEvent);
export const fakeBeforeCompact = (signal: AbortSignal, reason: SessionBeforeCompactEvent["reason"] = "manual"): SessionBeforeCompactEvent => ({ type: "session_before_compact", preparation: {} as never, branchEntries: [], reason, willRetry: false, signal });
export const fakeCompact = (reason: SessionCompactEvent["reason"] = "manual"): SessionCompactEvent => ({ type: "session_compact", compactionEntry: {} as never, fromExtension: false, reason, willRetry: false });
export const fakeSettled: AgentSettledEvent = { type: "agent_settled" };

export function fakeContext(currentProject: CurrentProjectRuntimeContext, signal?: AbortSignal): ExtensionContext {
  const sessionManager = {
    getSessionId: () => "session-1",
    getSessionFile: () => "/sessions/session-1.jsonl",
    getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "actual answer" }] } }],
  };
  return {
    cwd: "/workspace/project",
    signal,
    isProjectTrusted: () => true,
    sessionManager,
  } as unknown as ExtensionContext;
}
