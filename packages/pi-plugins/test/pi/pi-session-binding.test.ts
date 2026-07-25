import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiSessionBinding } from "../../src/pi/pi-session-binding.js";

function context(input: Readonly<{
  sessionId?: string;
  cwd?: string;
  trusted?: () => boolean;
}> = {}): ExtensionContext {
  return {
    cwd: input.cwd ?? "/workspace/project",
    mode: "tui",
    isProjectTrusted: input.trusted ?? (() => true),
    sessionManager: {
      getSessionId: () => input.sessionId ?? "session-1",
      getSessionFile: () => "/sessions/session-1.jsonl",
    },
  } as unknown as ExtensionContext;
}

describe("Pi session binding", () => {
  it("captures identity once but reads trust live", () => {
    let trusted = true;
    const initial = context({ trusted: () => trusted });
    const binding = createPiSessionBinding(initial);
    expect(binding.current()).toEqual({
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
      cwd: "/workspace/project",
      mode: "tui",
      projectTrusted: true,
    });
    trusted = false;
    expect(binding.isProjectTrusted()).toBe(false);
  });

  it("rejects stale session and cwd contexts", () => {
    const binding = createPiSessionBinding(context());
    expect(() => binding.assertContext(context())).not.toThrow();
    expect(() => binding.assertContext(context({ sessionId: "session-2" }))).toThrowError(expect.objectContaining({ code: "HOST_SESSION_MISMATCH" }));
    expect(() => binding.assertContext(context({ cwd: "/workspace/other" }))).toThrowError(expect.objectContaining({ code: "HOST_SESSION_MISMATCH" }));
    expect(() => createPiSessionBinding(context({ cwd: "relative" }))).toThrowError(expect.objectContaining({ code: "HOST_SESSION_MISMATCH" }));
  });
});
