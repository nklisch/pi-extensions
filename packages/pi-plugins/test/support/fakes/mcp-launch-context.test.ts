import { describe, expect, it } from "vitest";
import { McpLaunchBindingSchemaV1 } from "../../../src/application/ports/mcp-launch-context.js";
import { ComponentIdSchema } from "../../../src/domain/components.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";
import { FakeMcpLaunchActiveSelection, FakeMcpLaunchEnvironment } from "./mcp-launch-context.js";

const digest = (hex: string) => ContentDigestSchema.parse(`sha256:${hex.repeat(64).slice(0, 64)}`);
const binding = McpLaunchBindingSchemaV1.parse({
  schemaVersion: 1,
  source: {
    schemaVersion: 1,
    scope: { kind: "user" },
    plugin: PluginKeySchema.parse("demo@community"),
    revision: digest("1"),
    projectionDigest: digest("2"),
  },
  serverKey: `mcp-server-v1:${"3".repeat(64)}`,
  componentId: ComponentIdSchema.parse(`component-v1:mcp-server:${"3".repeat(64)}`),
  transport: "stdio",
});

describe("portable MCP launch fakes", () => {
  it("pins active selection until the callback releases before replacement", async () => {
    const initial = { marker: "initial" } as never;
    const replacement = { marker: "replacement" } as never;
    const active = new FakeMcpLaunchActiveSelection(binding, initial);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
    const selection = active.withSelection(binding, new AbortController().signal, async (value) => {
      expect(value).toBe(initial);
      entered();
      await gate;
    });
    await enteredGate;
    let replaced = false;
    const replacing = active.replace(binding, replacement).then(() => { replaced = true; });
    await Promise.resolve();
    expect(replaced).toBe(false);
    release();
    await Promise.all([selection, replacing]);
    await active.withSelection(binding, new AbortController().signal, async (value) => {
      expect(value).toBe(replacement);
    });
  });

  it("reads only requested sorted names and disposes escaped facades", async () => {
    const environment = new FakeMcpLaunchEnvironment({ ALPHA: "one", BETA: "two", UNREAD: "secret" });
    let escaped: import("../../../src/application/ports/mcp-launch-environment.js").ResolvedMcpLaunchEnvironment | undefined;
    const result = await environment.withResolved(["ALPHA", "BETA"], new AbortController().signal, async (facade) => {
      escaped = facade;
      expect(facade.substitute("${ALPHA}-${BETA}")).toBe("one-two");
      expect(facade.has("UNREAD")).toBe(false);
      return { plaintext: "one" } as never;
    });
    expect(result).toBeUndefined();
    expect(environment.requests).toEqual([["ALPHA", "BETA"]]);
    expect(environment.disposed).toBe(1);
    expect(() => escaped?.has("ALPHA")).toThrow("disposed");
    expect(JSON.stringify(escaped)).toBe('"[REDACTED]"');
  });
});
