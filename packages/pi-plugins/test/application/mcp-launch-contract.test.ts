import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  McpLaunchBindingSchemaV1,
  McpLaunchContextError,
  McpLaunchErrorCodes,
  type McpLaunchActiveSelectionPort,
  type McpLaunchBinding,
  type McpLaunchContextPort,
} from "../../src/application/ports/mcp-launch-context.js";
import type { McpLaunchEnvironmentPort } from "../../src/application/ports/mcp-launch-environment.js";
import {
  McpRuntimeServerBindingSchemaV1,
  type McpRuntimeServerBinding,
} from "../../src/application/ports/mcp-runtime.js";
import { ErrorCodeSchema } from "../../src/domain/errors.js";
import { ComponentIdSchema } from "../../src/domain/components.js";
import { ContentDigestSchema } from "../../src/domain/content-manifest.js";
import { PluginKeySchema } from "../../src/domain/identity.js";

const digest = (hex: string) => ContentDigestSchema.parse(`sha256:${hex.repeat(64).slice(0, 64)}`);

function binding(): McpLaunchBinding {
  return McpLaunchBindingSchemaV1.parse({
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
}

describe("portable MCP launch callback contracts", () => {
  it("derives binding types from one strict schema and error codes from the common registry", () => {
    expectTypeOf<McpLaunchBinding>().toEqualTypeOf<z.infer<typeof McpLaunchBindingSchemaV1>>();
    expectTypeOf<McpLaunchBinding>().toEqualTypeOf<McpRuntimeServerBinding>();
    expect(McpLaunchBindingSchemaV1).toBe(McpRuntimeServerBindingSchemaV1);
    expect(McpLaunchBindingSchemaV1.safeParse({ ...binding(), extra: true }).success).toBe(false);
    for (const code of Object.values(McpLaunchErrorCodes)) {
      expect(ErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it("exposes only callback-scoped void completion ports", () => {
    expectTypeOf<McpLaunchActiveSelectionPort["withSelection"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<McpLaunchContextPort["withContext"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<McpLaunchEnvironmentPort["withResolved"]>().returns.toEqualTypeOf<Promise<void>>();
  });

  it("emits only stable identity allowlists in typed diagnostics", () => {
    const value = binding();
    const error = new McpLaunchContextError({
      code: McpLaunchErrorCodes.valueInvalid,
      source: value.source,
      serverKey: value.serverKey,
      componentId: value.componentId,
      transport: value.transport,
    });
    const diagnostic = error.toDiagnostic();
    expect(diagnostic).toMatchObject({
      code: "MCP_LAUNCH_VALUE_INVALID",
      operation: "resolveMcpLaunchContext",
      plugin: value.source.plugin,
      details: {
        source: value.source,
        serverKey: value.serverKey,
        componentId: value.componentId,
        transport: value.transport,
      },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/command|args|cwd|url|header|bearer|environment|configuration/i);
  });

  it("keeps the binding secret-free and exactly source/component/transport qualified", () => {
    const value = binding();
    expect(JSON.stringify(value)).toContain("mcp-server-v1:");
    expect(JSON.stringify(value)).not.toMatch(/command|header|bearer|environment|secret|token/i);
  });
});
