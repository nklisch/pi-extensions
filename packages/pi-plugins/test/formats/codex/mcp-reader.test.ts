import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCodexMcp } from "../../../src/formats/codex/mcp-reader.js";
import { readClaudeMcp } from "../../../src/formats/claude/mcp-reader.js";
import type { Provenance } from "../../../src/domain/provenance.js";
import { PluginKeySchema, type PluginKey } from "../../../src/domain/identity.js";

const codexContext: Readonly<{ plugin: PluginKey; nativeHost: "codex"; provenance: Provenance }> = {
  plugin: PluginKeySchema.parse("demo@catalog"),
  nativeHost: "codex",
  provenance: { location: { host: "codex", documentKind: "mcp", path: ".mcp.json", pointer: "" } },
};
const claudeContext: Readonly<{ plugin: PluginKey; nativeHost: "claude"; provenance: Provenance }> = {
  plugin: PluginKeySchema.parse("demo@catalog"),
  nativeHost: "claude",
  provenance: { location: { host: "claude", documentKind: "manifest", path: "plugin.json", pointer: "/mcpServers" } },
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/plugins/mcp/${name}`, import.meta.url)).toString()) as unknown;
}

describe("Codex MCP reader", () => {
  it("accepts Codex wrapped, direct, and inline manifest maps", () => {
    const wrapped = readCodexMcp(fixture("codex-wrapped.json"), codexContext);
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.value[0]?.metadata[0]?.claimed.value).toBe("codex-wrapped");

    const direct = readCodexMcp(fixture("direct-map.json"), codexContext);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.value.map((server) => server.nativeKey.value)).toEqual(["docs", "local"]);

    const inline = readClaudeMcp(fixture("inline-manifest-map.json"), claudeContext);
    expect(inline.ok).toBe(true);
    if (!inline.ok) return;
    expect(inline.value[0]?.metadata[0]?.claimed.value).toBe("inline-manifest-map");
    expect(inline.value[0]?.declaration.value).toEqual({
      url: "https://example.invalid/analytics",
      auth: { oauth: { client_id: "opaque" } },
    });
  });

  it("derives the same id for equivalent declarations independent of wrapper host shape", () => {
    const claude = readClaudeMcp({ mcpServers: { search: { command: "node", args: ["server.js"] } } }, claudeContext);
    const codex = readCodexMcp({ mcp_servers: { search: { command: "node", args: ["server.js"] } } }, codexContext);
    expect(claude.ok).toBe(true);
    expect(codex.ok).toBe(true);
    if (!claude.ok || !codex.ok) return;
    expect(claude.value[0]?.id).toBe(codex.value[0]?.id);
    expect(claude.value[0]?.declaration.value).toEqual(codex.value[0]?.declaration.value);
    expect(claude.value[0]?.declaration.provenance[0]?.location.host).toBe("claude");
    expect(codex.value[0]?.declaration.provenance[0]?.location.host).toBe("codex");
  });

  it("rejects wrapper ambiguity and malformed roots", () => {
    expect(readCodexMcp({ mcpServers: {}, mcp_servers: {} }, codexContext).ok).toBe(false);
    expect(readCodexMcp([], codexContext).ok).toBe(false);
  });
});
