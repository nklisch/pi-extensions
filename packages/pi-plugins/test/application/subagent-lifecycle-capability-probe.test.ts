import { describe, expect, it, vi } from "vitest";
import { createSubagentLifecycleCapabilityProbe } from "../../src/application/subagent-lifecycle-capability-probe.js";
import type { SubagentLifecyclePort } from "../../src/application/ports/subagent-lifecycle.js";
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
  type RuntimeCapabilitySnapshot,
} from "../../src/domain/compatibility-policy.js";
import { BoundaryError } from "../../src/domain/errors.js";
import { publishedCapabilities, testCapabilities } from "./subagent-lifecycle-contract.test.js";

function baseSnapshot(): RuntimeCapabilitySnapshot {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: Object.fromEntries(Object.values(RuntimeCapabilityRegistry).map((entry) => [
      entry.id,
      {
        status: entry.id === RuntimeCapabilityRegistry.commandHooks.id ? "unavailable" : "available",
        explanation: `${entry.id} baseline`,
      },
    ])),
    capturedBy: "base-probe",
  });
}

function lifecycle(capabilities: unknown): Pick<SubagentLifecyclePort, "capabilities"> {
  return { capabilities: vi.fn(async () => capabilities) as SubagentLifecyclePort["capabilities"] };
}

function status(snapshot: RuntimeCapabilitySnapshot): string {
  return snapshot.capabilities[RuntimeCapabilityRegistry.subagentInterception.id]!.status;
}

describe("subagent lifecycle capability probe", () => {
  it("changes only lifecycle interception when no production port is composed", async () => {
    const probe = createSubagentLifecycleCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      capturedBy: "portable-composition",
      runtime: { nodeVersion: "24.0.0", piVersion: "0.80.8" },
    });
    const result = await probe.snapshot(new AbortController().signal);

    expect(status(result)).toBe("unavailable");
    expect(result.capabilities[RuntimeCapabilityRegistry.commandHooks.id]!.status).toBe("unavailable");
    expect(result.capabilities[RuntimeCapabilityRegistry.mcpRuntime.id]!.status).toBe("available");
    expect(result.capturedBy).toBe("portable-composition");
  });

  it("never maps a behaviorally complete test provider to production availability", async () => {
    const probe = createSubagentLifecycleCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      lifecycle: lifecycle(testCapabilities()),
      capturedBy: "fake-backed-tests",
      runtime: { nodeVersion: "24.1.0", piVersion: "0.80.8" },
    });
    expect(status(await probe.snapshot(new AbortController().signal))).toBe("unavailable");
  });

  it("maps only a complete compatible published-package qualification available", async () => {
    const probe = createSubagentLifecycleCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      lifecycle: lifecycle(publishedCapabilities()),
      capturedBy: "qualified-production-adapter",
      runtime: { nodeVersion: "24.2.0", piVersion: "0.80.8" },
    });
    expect(status(await probe.snapshot(new AbortController().signal))).toBe("available");

    const incomplete = publishedCapabilities({
      semantics: { ...publishedCapabilities().semantics, sameSessionContinuation: false },
    });
    const unavailable = createSubagentLifecycleCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      lifecycle: lifecycle(incomplete),
      capturedBy: "incomplete-production-adapter",
      runtime: { nodeVersion: "24.2.0", piVersion: "0.80.8" },
    });
    expect(status(await unavailable.snapshot(new AbortController().signal))).toBe("unavailable");
  });

  it("fails malformed published semver evidence closed", async () => {
    const malformedVersion = publishedCapabilities({
      provider: {
        ...publishedCapabilities().provider,
        version: "1.2.3-01",
      } as never,
    });
    const probe = createSubagentLifecycleCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      lifecycle: lifecycle(malformedVersion),
      capturedBy: "malformed-package-version",
      runtime: { nodeVersion: "24.0.0", piVersion: "0.80.8" },
    });

    await expect(probe.snapshot(new AbortController().signal)).rejects.toMatchObject({
      code: "ADAPTER_FAILED",
      operation: "probeSubagentLifecycleCapabilities",
    });
  });

  it("fails malformed present evidence closed without serializing native or callback data", async () => {
    const canary = "PROMPT_RESULT_SECRET_CANARY";
    const probe = createSubagentLifecycleCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      lifecycle: lifecycle({ schemaVersion: 1, nativeCause: canary, packagePath: "/private/package" }),
      capturedBy: "malformed-adapter",
      runtime: { nodeVersion: "24.0.0", piVersion: "0.80.8" },
    });

    let failure: unknown;
    try {
      await probe.snapshot(new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BoundaryError);
    expect(failure).toMatchObject({ code: "ADAPTER_FAILED", operation: "probeSubagentLifecycleCapabilities" });
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain("/private/package");
  });

  it("preserves exact caller cancellation before and during probing", async () => {
    const before = new AbortController();
    const beforeReason = new Error("before probe");
    before.abort(beforeReason);
    const base = { snapshot: vi.fn(async () => baseSnapshot()) };
    await expect(createSubagentLifecycleCapabilityProbe({
      base,
      capturedBy: "cancelled",
      runtime: { nodeVersion: "24.0.0", piVersion: "0.80.8" },
    }).snapshot(before.signal)).rejects.toBe(beforeReason);
    expect(base.snapshot).not.toHaveBeenCalled();

    const during = new AbortController();
    const duringReason = new Error("during lifecycle probe");
    const port = lifecycle(publishedCapabilities());
    vi.mocked(port.capabilities).mockImplementationOnce(async () => {
      during.abort(duringReason);
      throw new Error("native secret");
    });
    await expect(createSubagentLifecycleCapabilityProbe({
      base: { snapshot: vi.fn(async () => baseSnapshot()) },
      lifecycle: port,
      capturedBy: "cancelled",
      runtime: { nodeVersion: "24.0.0", piVersion: "0.80.8" },
    }).snapshot(during.signal)).rejects.toBe(duringReason);
  });
});
