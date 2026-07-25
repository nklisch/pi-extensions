import { describe, expect, it } from "vitest";
import {
  formatMcpToolAlias,
  resolveMcpToolAliases,
  type McpToolAliasClaim,
} from "../../src/application/mcp-tool-aliases.js";
import { McpSourceIdentitySchemaV1, McpToolAliasTemplateSchemaV1 } from "../../src/application/ports/mcp-runtime.js";

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;
const source = (plugin: string, hex: string) => McpSourceIdentitySchemaV1.parse({
  schemaVersion: 1,
  scope: { kind: "user" },
  plugin,
  revision: digest(hex),
  projectionDigest: digest(`${hex}f`),
});
const serverKey = (hex: string) => `mcp-server-v1:${hex.repeat(64).slice(0, 64)}`;
const componentId = (hex: string) => `component-v1:mcp-server:${hex.repeat(64).slice(0, 64)}`;

function claim(alias: string, plugin = "one@community", hex = "1"): McpToolAliasClaim {
  return {
    source: source(plugin, hex),
    serverKey: serverKey(hex),
    componentId: componentId(hex),
    nativeToolName: "read",
    alias,
  } as McpToolAliasClaim;
}

describe("MCP tool aliases", () => {
  it("formats the exact foreign namespace without rewriting segments", () => {
    const template = McpToolAliasTemplateSchemaV1.parse({
      schemaVersion: 1,
      kind: "claude-plugin",
      pluginName: "a_b/../c",
      nativeServerKey: "s_érver",
      collisionPolicy: "omit-all",
      preserveNativeDiscovery: true,
    });
    expect(formatMcpToolAlias(template, "to_ol/路径")).toBe(
      "mcp__plugin_a_b/../c_s_érver__to_ol/路径",
    );
  });

  it("gives native discovery precedence and omits every distinct collision claimant", () => {
    const nativeCollision = claim("native-read");
    const first = claim("contested", "one@community", "2");
    const second = claim("contested", "two@community", "3");
    const safe = claim("safe", "three@community", "4");
    const input = [safe, second, first, first, nativeCollision];
    const resolve = (claims: readonly McpToolAliasClaim[]) => resolveMcpToolAliases({
      nativeToolNames: ["native-read", "ordinary-native"],
      claims,
      isRepresentable: () => true,
    });
    const expected = resolve(input);
    expect(expected.exposed).toEqual([safe]);
    expect(expected.omitted.map(({ claim: omitted, code }) => `${omitted.alias}:${code}`).sort()).toEqual([
      "contested:ALIAS_CLAIM_COLLISION",
      "contested:ALIAS_CLAIM_COLLISION",
      "native-read:NATIVE_NAME_COLLISION",
    ]);
    expect(resolve([...input].reverse())).toEqual(expected);
    expect(expected.omitted).toHaveLength(3); // the exact duplicate collapsed
  });

  it("keeps normalization pairs distinct and omits controls, surrogates, and runtime-invalid names", () => {
    const composed = claim("é", "one@community", "5");
    const decomposed = claim("é", "two@community", "6");
    const control = claim("bad\u0000alias", "three@community", "7");
    const surrogate = claim("bad\ud800alias", "four@community", "8");
    const runtimeInvalid = claim("runtime-invalid", "five@community", "9");
    const result = resolveMcpToolAliases({
      nativeToolNames: [],
      claims: [runtimeInvalid, surrogate, control, decomposed, composed],
      isRepresentable: (name) => name !== "runtime-invalid",
    });
    expect(result.exposed.map((entry) => entry.alias)).toEqual(["é", "é"]);
    expect(result.omitted.map((entry) => entry.code)).toEqual([
      "UNREPRESENTABLE_ALIAS",
      "UNREPRESENTABLE_ALIAS",
      "UNREPRESENTABLE_ALIAS",
    ]);
  });
});
