import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readClaudeMcp } from "../../../src/formats/claude/mcp-reader.js";
import type { Provenance } from "../../../src/domain/provenance.js";
import { PluginKeySchema, type PluginKey } from "../../../src/domain/identity.js";

const context: Readonly<{ plugin: PluginKey; nativeHost: "claude"; provenance: Provenance }> = {
  plugin: PluginKeySchema.parse("demo@catalog"),
  nativeHost: "claude",
  provenance: { location: { host: "claude", documentKind: "mcp", path: ".mcp.json", pointer: "" } },
};
const fixture = JSON.parse(readFileSync(
  new URL("../../fixtures/plugins/mcp/claude-wrapped.json", import.meta.url),
).toString()) as unknown;

describe("Claude MCP reader", () => {
  it("accepts the Claude wrapper and preserves opaque server JSON", () => {
    const result = readClaudeMcp(fixture, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      kind: "mcp-server",
      nativeKey: { value: "search", provenance: [{ location: { pointer: "/mcpServers/search" } }] },
      declaration: {
        value: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "${TOKEN}" },
          capabilities: ["search"],
        },
      },
      metadata: [{ key: "claude.mcp.shape", claimed: { value: "claude-wrapped" } }],
    });
    expect(result.value[0]).not.toHaveProperty("transport");
    expect(result.value[0]).not.toHaveProperty("auth");
    expect(result.value[0]).not.toHaveProperty("projection");
  });

  it("rejects non-object server declarations without classifying them", () => {
    const result = readClaudeMcp({ mcpServers: { broken: "run me" } }, context);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ diagnostics: [{ location: { pointer: "/mcpServers/broken" } }] });
  });
});
