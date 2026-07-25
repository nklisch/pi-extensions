import { describe, expect, it } from "vitest";
import { createPiSubagentSessionContext } from "../../src/pi/pi-subagent-session-context.js";

describe("Pi subagent parent session context", () => {
  it("returns only exact current parent-session evidence", async () => {
    const adapter = createPiSubagentSessionContext({
      binding: {
        current: () => ({ sessionId: "parent", sessionFile: "/session.jsonl", cwd: "/workspace", mode: "tui", projectTrusted: true }),
        assertContext: () => {},
        isProjectTrusted: () => true,
      },
      project: { current: () => ({
        identity: { kind: "path-only", canonicalRoot: "file:///workspace/", limitation: "identity-changes-with-canonical-root" },
        projectKey: `project-v1:sha256:${"1".repeat(64)}`,
        trust: { kind: "trusted" },
      }) } as never,
    });
    await expect(adapter.resolve("other", new AbortController().signal)).resolves.toBeUndefined();
    await expect(adapter.resolve("parent", new AbortController().signal)).resolves.toMatchObject({
      sessionId: "parent", transcriptPath: "/session.jsonl", cwd: "/workspace", piProjectTrusted: true,
    });
  });
});
