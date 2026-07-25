import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  NormalizedPluginSchema,
  type NormalizedPlugin,
} from "../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { PluginConfigurationSchema } from "../../src/domain/configuration.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";
import { PluginComponentsSchema } from "../../src/domain/components.js";

const manifest: Provenance = {
  location: {
    host: "claude",
    documentKind: "manifest",
    path: ".claude-plugin/plugin.json",
    pointer: "",
  },
};

const representativeSource = createResolvedPluginSource({
  kind: "git",
  url: "https://example.com/demo.git",
  revision: "b".repeat(40),
}, () => Uint8Array.from({ length: 32 }, (_, index) => index));

const representativeBundle = {
  identity: {
    key: "demo@community",
    marketplaceName: "community",
    marketplaceEntryName: "demo",
    manifestName: "internal-demo",
  },
  version: claim("1.2.3", manifest),
  description: claim("A representative plugin", manifest),
  source: representativeSource,
  configuration: {
    options: [
      {
        key: "API_KEY",
        label: claim("API key", manifest),
        description: claim("Used by the search server", manifest),
        value: { kind: "string", pattern: "^sk-" },
        required: true,
        sensitive: true,
        provenance: [manifest],
      },
      {
        key: "RETRIES",
        label: claim("Retries", manifest),
        value: { kind: "number", default: 2, min: 0, max: 5 },
        required: false,
        sensitive: false,
        provenance: [manifest],
      },
    ],
  },
  components: {
    skills: [
      {
        kind: "skill",
        id: "component-v1:skill:0000000000000000000000000000000000000000000000000000000000000000",
        name: claim("demo", manifest),
        root: claim("./skills/demo", manifest),
        metadata: [],
      },
    ],
    hooks: [
      {
        kind: "hook",
        id: "component-v1:hook:1111111111111111111111111111111111111111111111111111111111111111",
        event: claim("SessionStart", manifest),
        handler: claim({ kind: "shell", command: "./hooks/start.sh" }, manifest),
        metadata: [],
      },
    ],
    mcpServers: [
      {
        kind: "mcp-server",
        id: "component-v1:mcp-server:2222222222222222222222222222222222222222222222222222222222222222",
        nativeKey: claim("search", manifest),
        declaration: claim(
          { command: "search-server", args: ["--stdio"] },
          manifest,
        ),
        metadata: [],
      },
    ],
    foreign: [
      {
        kind: "foreign",
        id: "component-v1:foreign:3333333333333333333333333333333333333333333333333333333333333333",
        nativeHost: "codex",
        nativeKind: claim("apps", manifest),
        declarationSubkey: "key:remote",
        declaration: claim({ remote: true, capabilities: ["search"] }, manifest),
      },
    ],
  },
  metadata: [
    {
      key: "license",
      claimed: claim("MIT", manifest),
    },
  ],
} as const;

describe("normalized plugin contract", () => {
  it("parses a complete representative bundle at the runtime boundary", () => {
    const plugin = NormalizedPluginSchema.parse(representativeBundle);

    expect(plugin.identity.key).toBe("demo@community");
    expect(plugin.source.kind).toBe("git");
    expect(plugin.components.skills).toHaveLength(1);
    expect(plugin.components.hooks).toHaveLength(1);
    expect(plugin.components.mcpServers).toHaveLength(1);
    expect(plugin.components.foreign[0]?.declaration.value).toEqual({
      remote: true,
      capabilities: ["search"],
    });
  });

  it("rejects malformed nested contracts rather than producing partial plugins", () => {
    expect(
      NormalizedPluginSchema.safeParse({
        ...representativeBundle,
        identity: { ...representativeBundle.identity, key: "other@community" },
      }).success,
    ).toBe(false);
    expect(
      NormalizedPluginSchema.safeParse({
        ...representativeBundle,
        components: {
          ...representativeBundle.components,
          skills: [
            representativeBundle.components.skills[0],
            { ...representativeBundle.components.skills[0], id: "component-v1:foreign:3333333333333333333333333333333333333333333333333333333333333333" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      NormalizedPluginSchema.safeParse({
        ...representativeBundle,
        configuration: {
          options: [
            ...representativeBundle.configuration.options,
            { ...representativeBundle.configuration.options[0], key: "API_KEY" },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("does not accept configuration values or an unresolvable source", () => {
    expect(
      NormalizedPluginSchema.safeParse({
        ...representativeBundle,
        configuration: {
          options: [
            {
              ...representativeBundle.configuration.options[0],
              configuredValue: "secret",
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      NormalizedPluginSchema.safeParse({
        ...representativeBundle,
        source: { kind: "git", url: "https://example.com/demo.git" },
      }).success,
    ).toBe(false);
  });

  it("keeps inferred plugin, component, and configuration types aligned", () => {
    expectTypeOf<z.infer<typeof NormalizedPluginSchema>>().toEqualTypeOf<NormalizedPlugin>();
    const parsed = NormalizedPluginSchema.parse(representativeBundle);
    expectTypeOf<z.infer<typeof PluginConfigurationSchema>>().toEqualTypeOf(
      parsed.configuration,
    );
    expectTypeOf<z.infer<typeof PluginComponentsSchema>>().toEqualTypeOf(
      parsed.components,
    );
  });
});
