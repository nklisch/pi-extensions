import { describe, expect, it, vi } from "vitest";
import { createMcpRuntimeCapabilityProbe } from "../../src/application/mcp-runtime-capability-probe.js";
import {
  McpRuntimeCapabilitiesSchemaV1,
  type McpRuntimeCapabilities,
} from "../../src/application/ports/mcp-runtime.js";
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
  type RuntimeCapabilitySnapshot,
} from "../../src/domain/compatibility-policy.js";
import { BoundaryError } from "../../src/domain/errors.js";

function baseSnapshot(overrides: Record<string, "available" | "unavailable"> = {}): RuntimeCapabilitySnapshot {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: Object.fromEntries(Object.values(RuntimeCapabilityRegistry).map((entry) => [
      entry.id,
      {
        status: overrides[entry.id] ?? "available",
        explanation: `${entry.id} base explanation`,
      },
    ])),
    capturedBy: "base-probe",
  });
}

function runtimeCapabilities(overrides: Readonly<{
  sourceLifecycle?: Partial<McpRuntimeCapabilities["sourceLifecycle"]>;
  transports?: Partial<McpRuntimeCapabilities["transports"]>;
  oauth?: Partial<McpRuntimeCapabilities["oauth"]>;
  features?: Partial<McpRuntimeCapabilities["features"]>;
}> = {}): McpRuntimeCapabilities {
  return McpRuntimeCapabilitiesSchemaV1.parse({
    schemaVersion: 1,
    sourceLifecycle: {
      initialSourcesBeforeToolRegistration: true,
      isolatedFileDiscovery: true,
      localValidation: true,
      atomicReplace: true,
      exactRemove: true,
      inspect: true,
      cancellable: true,
      lateLaunchValues: true,
      runtimeLeases: true,
      ...overrides.sourceLifecycle,
    },
    transports: {
      stdio: true,
      streamableHttp: true,
      legacySse: false,
      websocket: false,
      ...overrides.transports,
    },
    oauth: {
      authorizationCode: true,
      clientCredentials: true,
      ...overrides.oauth,
    },
    features: {
      sampling: true,
      elicitationForm: true,
      elicitationUrl: true,
      toolApproval: true,
      resources: true,
      pluginToolAliases: true,
      ...overrides.features,
    },
  });
}

function status(snapshot: RuntimeCapabilitySnapshot, id: string): string {
  const value = snapshot.capabilities[id];
  if (value === undefined) throw new Error(`missing capability ${id}`);
  return value.status;
}

describe("MCP runtime capability probe", () => {
  it("fails closed for MCP facts while preserving unrelated base facts when no runtime is composed", async () => {
    const probe = createMcpRuntimeCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot({ "pi.hooks.command": "unavailable" })) },
      capturedBy: "composition-without-mcp",
    });
    const snapshot = await probe.snapshot(new AbortController().signal);

    expect(snapshot.capturedBy).toBe("composition-without-mcp");
    expect(status(snapshot, RuntimeCapabilityRegistry.commandHooks.id)).toBe("unavailable");
    expect(status(snapshot, RuntimeCapabilityRegistry.skillToolRestrictions.id)).toBe("available");
    for (const id of [
      RuntimeCapabilityRegistry.mcpRuntime.id,
      RuntimeCapabilityRegistry.mcpTransportStdio.id,
      RuntimeCapabilityRegistry.mcpTransportStreamableHttp.id,
      RuntimeCapabilityRegistry.mcpOAuthAuthorizationCode.id,
      RuntimeCapabilityRegistry.mcpResources.id,
    ]) expect(status(snapshot, id)).toBe("unavailable");
  });

  it("maps exact runtime facts independently and gates them on the complete source seam", async () => {
    const runtime = { capabilities: vi.fn(async () => runtimeCapabilities({
      transports: { stdio: true, streamableHttp: false, legacySse: true, websocket: true },
      oauth: { authorizationCode: false, clientCredentials: true },
      features: { resources: false, elicitationUrl: false },
    })) };
    const probe = createMcpRuntimeCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      runtime,
      capturedBy: "qualified-runtime",
    });
    const snapshot = await probe.snapshot(new AbortController().signal);

    expect(status(snapshot, RuntimeCapabilityRegistry.mcpRuntime.id)).toBe("available");
    expect(status(snapshot, RuntimeCapabilityRegistry.mcpTransportStdio.id)).toBe("available");
    expect(status(snapshot, RuntimeCapabilityRegistry.mcpTransportStreamableHttp.id)).toBe("unavailable");
    expect(status(snapshot, RuntimeCapabilityRegistry.mcpOAuthAuthorizationCode.id)).toBe("unavailable");
    expect(status(snapshot, RuntimeCapabilityRegistry.mcpOAuthClientCredentials.id)).toBe("available");
    expect(status(snapshot, RuntimeCapabilityRegistry.mcpResources.id)).toBe("unavailable");
    expect(runtime.capabilities).toHaveBeenCalledTimes(1);
  });

  it("does not overclaim any MCP fact when one required lifecycle semantic is missing", async () => {
    const probe = createMcpRuntimeCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      runtime: {
        capabilities: vi.fn(async () => runtimeCapabilities({
          sourceLifecycle: { runtimeLeases: false },
        })),
      },
      capturedBy: "incomplete-runtime",
    });
    const snapshot = await probe.snapshot(new AbortController().signal);
    for (const id of [
      RuntimeCapabilityRegistry.mcpRuntime.id,
      RuntimeCapabilityRegistry.mcpTransportStdio.id,
      RuntimeCapabilityRegistry.mcpTransportStreamableHttp.id,
      RuntimeCapabilityRegistry.mcpResources.id,
    ]) expect(status(snapshot, id)).toBe("unavailable");
  });

  it("turns malformed present runtime facts into an adapter failure", async () => {
    const probe = createMcpRuntimeCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      runtime: { capabilities: vi.fn(async () => ({ schemaVersion: 1 })) },
      capturedBy: "malformed-runtime",
    });
    await expect(probe.snapshot(new AbortController().signal)).rejects.toMatchObject({
      code: "ADAPTER_FAILED",
      operation: "probeMcpRuntimeCapabilities",
    });
    await expect(probe.snapshot(new AbortController().signal)).rejects.toBeInstanceOf(BoundaryError);
  });

  it("preserves caller cancellation before and during both probe layers", async () => {
    const preAborted = new AbortController();
    const preReason = new Error("pre-aborted");
    preAborted.abort(preReason);
    const base = { snapshot: vi.fn(async () => baseSnapshot()) };
    await expect(createMcpRuntimeCapabilityProbe({ base, capturedBy: "test" }).snapshot(preAborted.signal)).rejects.toBe(preReason);
    expect(base.snapshot).not.toHaveBeenCalled();

    const during = new AbortController();
    const reason = new Error("runtime cancelled");
    const runtime = {
      capabilities: vi.fn(async () => {
        during.abort(reason);
        throw new Error("stopped");
      }),
    };
    await expect(createMcpRuntimeCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      runtime,
      capturedBy: "test",
    }).snapshot(during.signal)).rejects.toBe(reason);
  });
});
