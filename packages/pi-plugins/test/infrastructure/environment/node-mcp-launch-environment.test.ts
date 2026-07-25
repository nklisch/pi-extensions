import { describe, expect, it } from "vitest";
import { createNodeMcpLaunchEnvironment } from "../../../src/infrastructure/environment/node-mcp-launch-environment.js";

describe("Node MCP launch environment", () => {
  it("resolves requested names only and disposes the redacted facade on every outcome", async () => {
    const environment = createNodeMcpLaunchEnvironment({ ALPHA: "CANARY_ALPHA", UNREAD: "CANARY_UNREAD" });
    let escaped: import("../../../src/application/ports/mcp-launch-environment.js").ResolvedMcpLaunchEnvironment | undefined;
    await expect(environment.withResolved(["ALPHA"], new AbortController().signal, async (facade) => {
      escaped = facade;
      expect(facade.has("ALPHA")).toBe(true);
      expect(facade.has("UNREAD")).toBe(false);
      expect(facade.substitute("value=${ALPHA}")).toBe("value=CANARY_ALPHA");
      expect(facade.redact("CANARY_ALPHA CANARY_UNREAD")).toBe("[REDACTED] CANARY_UNREAD");
      expect(JSON.stringify(facade)).toBe('"[REDACTED]"');
      throw new Error("callback failure");
    })).rejects.toThrow("callback failure");
    expect(() => escaped!.has("ALPHA")).toThrow("disposed");
    expect(JSON.stringify(environment)).not.toContain("CANARY_ALPHA");
  });
});
