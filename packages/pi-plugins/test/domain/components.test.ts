import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ComponentIdSchema,
  ComponentKindRegistry,
  ComponentSchema,
  ForeignComponentSchema,
  HookComponentSchema,
  HookHandlerSchema,
  HookHandlerVariantRegistry,
  McpServerComponentSchema,
  PluginComponentsSchema,
  RetainedMetadataSchema,
  SkillComponentSchema,
  flattenComponents,
  type Component,
  type PluginComponents,
} from "../../src/domain/components.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";

const claudeManifest: Provenance = {
  location: {
    host: "claude",
    documentKind: "manifest",
    path: ".claude-plugin/plugin.json",
    pointer: "/components",
  },
};
const codexManifest: Provenance = {
  location: {
    host: "codex",
    documentKind: "manifest",
    path: ".codex-plugin/plugin.json",
    pointer: "/components",
  },
};

const metadata = [
  {
    key: "license",
    claimed: claim("MIT", claudeManifest),
  },
] as const;

const skill = {
  kind: "skill" as const,
  id: ComponentIdSchema.parse("component-v1:skill:0000000000000000000000000000000000000000000000000000000000000000"),
  name: claim("demo", claudeManifest),
  root: claim("./skills/demo", claudeManifest),
  metadata,
};
const hook = {
  kind: "hook" as const,
  id: ComponentIdSchema.parse("component-v1:hook:1111111111111111111111111111111111111111111111111111111111111111"),
  event: claim("SessionStart", claudeManifest),
  matcher: claim("Write|Edit", claudeManifest),
  handler: claim(
    { kind: "exec" as const, command: "node", args: ["hook.js"], timeoutMs: 5000 },
    claudeManifest,
  ),
  metadata: [],
};
const mcp = {
  kind: "mcp-server" as const,
  id: ComponentIdSchema.parse("component-v1:mcp-server:2222222222222222222222222222222222222222222222222222222222222222"),
  nativeKey: claim("search", claudeManifest),
  declaration: claim(
    { command: "search-server", args: ["--stdio"], env: { MODE: "safe" } },
    claudeManifest,
  ),
  metadata: [],
};
const foreign = {
  kind: "foreign" as const,
  id: ComponentIdSchema.parse("component-v1:foreign:3333333333333333333333333333333333333333333333333333333333333333"),
  nativeHost: "codex" as const,
  nativeKind: claim("apps", codexManifest),
  declarationSubkey: "key:remote-connector",
  declaration: claim(
    { name: "remote-connector", capabilities: ["search", "write"] },
    codexManifest,
  ),
};

describe("component registries and schemas", () => {
  it("parses every normalized component variant from the registry", () => {
    const samples = {
      skill,
      hook,
      mcpServer: mcp,
      foreign,
    } as const;

    for (const [name, entry] of Object.entries(ComponentKindRegistry)) {
      const sample = samples[name as keyof typeof samples];
      expect(ComponentSchema.safeParse(sample).success).toBe(true);
      expect(entry.tag).toBe(sample.kind);
    }
  });

  it("derives hook handler variants from their registry", () => {
    const samples = {
      shell: { kind: "shell", command: "./hook.sh" },
      exec: { kind: "exec", command: "node", args: ["hook.js"] },
    } as const;

    for (const [name, entry] of Object.entries(HookHandlerVariantRegistry)) {
      const sample = samples[name as keyof typeof samples];
      expect(entry.schema.safeParse(sample).success).toBe(true);
      expect(HookHandlerSchema.safeParse(sample).success).toBe(true);
      expect(entry.tag).toBe(sample.kind);
    }
    expect(HookHandlerSchema.parse({ kind: "shell", command: "./hook.sh", shell: "bash" })).toEqual({ kind: "shell", command: "./hook.sh" });
    expect(HookHandlerSchema.parse({ kind: "shell", command: "./hook.ps1", shell: "powershell" })).toMatchObject({ kind: "shell", shell: "powershell" });
    expect(HookHandlerSchema.safeParse({ kind: "shell", command: "./hook.sh", timeoutMs: 600_001 }).success).toBe(false);
    expect(HookHandlerSchema.safeParse({ kind: "exec", command: "node", args: [], shell: "bash" }).success).toBe(false);
  });

  it("rejects unknown component variants and malformed claims", () => {
    expect(ComponentSchema.safeParse({ kind: "unknown", id: "x" }).success).toBe(false);
    expect(
      SkillComponentSchema.safeParse({
        ...skill,
        name: { value: "demo", provenance: [] },
      }).success,
    ).toBe(false);
    expect(
      RetainedMetadataSchema.safeParse({
        key: "license",
        claimed: { value: { bad: undefined }, provenance: [claudeManifest] },
      }).success,
    ).toBe(false);
    expect(
      RetainedMetadataSchema.safeParse({
        key: "license",
        claimed: { value: "MIT", provenance: [claudeManifest] },
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("retains unknown native runtime declarations as inspectable foreign components", () => {
    const result = ForeignComponentSchema.parse(foreign);

    expect(result.nativeHost).toBe("codex");
    expect(result.nativeKind.value).toBe("apps");
    expect(result.declaration.value).toEqual({
      name: "remote-connector",
      capabilities: ["search", "write"],
    });
    expect(result).not.toHaveProperty("verdict");
    expect(result).not.toHaveProperty("compatibility");
  });

  it("rejects duplicate ids across every inventory array", () => {
    const duplicate = {
      skills: [skill],
      hooks: [{ ...hook, id: skill.id }],
      mcpServers: [mcp],
      foreign: [foreign],
    };
    const result = PluginComponentsSchema.safeParse(duplicate);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "hooks.0.id")).toBe(true);
    }
  });

  it("flattens a validated inventory in stable registry order", () => {
    const components: PluginComponents = {
      skills: [skill],
      hooks: [hook],
      mcpServers: [mcp],
      foreign: [foreign],
    };

    expect(flattenComponents(components).map((component) => component.id)).toEqual([
      skill.id,
      hook.id,
      mcp.id,
      foreign.id,
    ]);
  });

  it("derives public component types from their schemas", () => {
    expectTypeOf<z.infer<typeof ComponentSchema>>().toEqualTypeOf<Component>();
    expectTypeOf<z.infer<typeof PluginComponentsSchema>>().toEqualTypeOf<PluginComponents>();
    expectTypeOf<z.infer<typeof SkillComponentSchema>>().toMatchTypeOf<Component>();
    expectTypeOf<z.infer<typeof HookComponentSchema>>().toMatchTypeOf<Component>();
    expectTypeOf<z.infer<typeof McpServerComponentSchema>>().toMatchTypeOf<Component>();
    expectTypeOf<z.infer<typeof ForeignComponentSchema>>().toMatchTypeOf<Component>();
  });
});
