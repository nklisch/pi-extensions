import { describe, expect, it, vi } from "vitest";
import { createCompatibilityService } from "../../src/application/compatibility-service.js";
import type { RuntimeCapabilityProbe } from "../../src/application/ports/runtime-capability-probe.js";
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
} from "../../src/domain/compatibility-policy.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { BoundaryError } from "../../src/domain/errors.js";
import { NormalizedPluginSchema, type NormalizedPlugin } from "../../src/domain/plugin.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import type { RuntimeCapabilitySnapshot } from "../../src/domain/compatibility-policy.js";

const manifest: Provenance = {
  location: {
    host: "claude",
    documentKind: "manifest",
    path: ".claude-plugin/plugin.json",
    pointer: "/components",
  },
};

const source = createResolvedPluginSource({
  kind: "git",
  url: "https://example.com/demo.git",
  revision: "a".repeat(40),
}, () => Uint8Array.from({ length: 32 }, (_, index) => index));

function componentId(kind: "skill" | "foreign", hex: string): string {
  return `component-v1:${kind}:${hex.repeat(64).slice(0, 64)}`;
}

function capabilities(
  overrides: Record<string, "available" | "unavailable"> = {},
): RuntimeCapabilitySnapshot {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: Object.fromEntries(Object.values(RuntimeCapabilityRegistry).map((entry) => [
      entry.id,
      {
        status: overrides[entry.id] ?? "available",
        explanation: `${entry.id} fixture status`,
      },
    ])),
    capturedBy: "unit-test",
  });
}

function plugin(): NormalizedPlugin {
  return NormalizedPluginSchema.parse({
    identity: {
      key: "demo@community",
      marketplaceName: "community",
      marketplaceEntryName: "demo",
    },
    source,
    configuration: { options: [] },
    components: {
      skills: [{
        kind: "skill",
        id: componentId("skill", "0"),
        name: claim("demo", manifest),
        root: claim("skills/demo", manifest),
        metadata: [{
          key: "agent-skills.allowed-tools",
          claimed: claim("bash", manifest),
        }],
      }],
      hooks: [],
      mcpServers: [],
      foreign: [{
        kind: "foreign",
        id: componentId("foreign", "1"),
        nativeHost: "codex",
        nativeKind: claim("apps", manifest),
        declarationSubkey: "remote",
        declaration: claim({ secret: "do-not-copy" }, manifest),
      }],
    },
    metadata: [],
  });
}

function service(probe: RuntimeCapabilityProbe) {
  return createCompatibilityService(probe);
}

function completeSnapshotWithout(capability: string): unknown {
  const snapshot = capabilities();
  const remaining = Object.fromEntries(
    Object.entries(snapshot.capabilities).filter(([id]) => id !== capability),
  );
  return { ...snapshot, capabilities: remaining };
}

describe("compatibility capability service", () => {
  it("probes once and delegates the validated snapshot to the pure evaluator", async () => {
    const snapshot = capabilities();
    const probe = { snapshot: vi.fn(async () => snapshot) };
    const request = { plugin: plugin() };

    const report = await service(probe).assess(request, new AbortController().signal);

    expect(probe.snapshot).toHaveBeenCalledTimes(1);
    expect(report).toEqual(evaluateCompatibility({ ...request, capabilities: snapshot }));
    expect(report.activatable).toBe(true);
    expect(report.components.find((item) => item.verdict.kind === "metadata-only")).toBeDefined();
  });

  it("keeps domain incompatibility as a successful report with mixed capability availability", async () => {
    const snapshot = capabilities({ "pi.skill.allowed-tools": "unavailable" });
    const probe = { snapshot: vi.fn(async () => snapshot) };

    const report = await service(probe).assess({ plugin: plugin() }, new AbortController().signal);

    expect(report.activatable).toBe(false);
    expect(report.components).toHaveLength(2);
    expect(report.components.find((item) => item.verdict.kind === "metadata-only")).toBeDefined();
    const skill = report.components.find((item) => item.componentId.includes(":skill:"));
    expect(skill?.verdict).toEqual({ kind: "supported" });
    expect(report.requirements).toContainEqual(expect.objectContaining({
      status: "unavailable",
      requirement: expect.objectContaining({ capability: "pi.skill.allowed-tools" }),
    }));
  });

  it("propagates pre-abort unchanged without probing", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    const probe = { snapshot: vi.fn(async () => capabilities()) };

    await expect(service(probe).assess({ plugin: plugin() }, controller.signal)).rejects.toBe(reason);
    expect(probe.snapshot).not.toHaveBeenCalled();
  });

  it("propagates an abort raised during probing unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("probe cancelled");
    const probe = {
      snapshot: vi.fn(async (signal: AbortSignal) => {
        void signal;
        controller.abort(reason);
        throw new Error("adapter stopped after cancellation");
      }),
    };

    await expect(service(probe).assess({ plugin: plugin() }, controller.signal)).rejects.toBe(reason);
    expect(probe.snapshot).toHaveBeenCalledTimes(1);
  });

  it("propagates an abort-shaped probe rejection unchanged", async () => {
    const abort = Object.assign(new Error("adapter cancellation"), { name: "AbortError" });
    const probe = { snapshot: vi.fn(async () => { throw abort; }) };

    await expect(service(probe).assess({ plugin: plugin() }, new AbortController().signal)).rejects.toBe(abort);
  });

  it("turns probe failures into adapter boundary errors without a partial report", async () => {
    const cause = new Error("native adapter failure");
    const probe = { snapshot: vi.fn(async () => { throw cause; }) };

    const result = await service(probe).assess({ plugin: plugin() }, new AbortController().signal)
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(BoundaryError);
    expect(result).toMatchObject({
      code: "ADAPTER_FAILED",
      operation: "probeRuntimeCapabilities",
    });
    expect((result as BoundaryError).cause).toBe(cause);
    expect(result).not.toHaveProperty("components");
  });

  it("turns incomplete and unknown snapshots into adapter boundary errors", async () => {
    const incompleteProbe = {
      snapshot: vi.fn(async (): Promise<RuntimeCapabilitySnapshot> =>
        completeSnapshotWithout("pi.mcp.runtime") as RuntimeCapabilitySnapshot),
    };
    const incomplete = await service(incompleteProbe).assess({ plugin: plugin() }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(incomplete).toBeInstanceOf(BoundaryError);
    expect(incomplete).toMatchObject({ code: "ADAPTER_FAILED", operation: "probeRuntimeCapabilities" });

    const complete = capabilities();
    const unknownProbe = {
      snapshot: vi.fn(async () => ({
        ...complete,
        capabilities: {
          ...complete.capabilities,
          "runtime.unknown": { status: "available", explanation: "unknown" },
        },
      })),
    };
    const unknown = await service(unknownProbe).assess({ plugin: plugin() }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(BoundaryError);
    expect(unknown).toMatchObject({ code: "ADAPTER_FAILED", operation: "probeRuntimeCapabilities" });
  });

  it("validates the request before calling the probe", async () => {
    const probe = { snapshot: vi.fn(async () => capabilities()) };

    await expect(service(probe).assess({ plugin: {} as NormalizedPlugin }, new AbortController().signal))
      .rejects.toThrow();
    expect(probe.snapshot).not.toHaveBeenCalled();
  });
});
