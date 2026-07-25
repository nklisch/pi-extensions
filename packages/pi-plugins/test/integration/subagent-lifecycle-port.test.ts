import { describe, expect, it } from "vitest";
import { createSubagentLifecycleCapabilityProbe } from "../../src/application/subagent-lifecycle-capability-probe.js";
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
} from "../../src/domain/compatibility-policy.js";
import { createFakeSubagentLifecycle } from "../support/fakes/subagent-lifecycle.js";

describe("portable subagent lifecycle port integration", () => {
  it("allows direct fake conformance without granting production compatibility", async () => {
    const fake = createFakeSubagentLifecycle();
    const base = RuntimeCapabilitySnapshotSchema.parse({
      capabilities: Object.fromEntries(Object.values(RuntimeCapabilityRegistry).map((entry) => [
        entry.id,
        { status: "available", explanation: "baseline" },
      ])),
      capturedBy: "baseline",
    });
    const snapshot = await createSubagentLifecycleCapabilityProbe({
      base: { snapshot: async () => base },
      lifecycle: fake.lifecycle,
      capturedBy: "fake-integration",
      runtime: { nodeVersion: "24.0.0", piVersion: "0.80.8" },
    }).snapshot(new AbortController().signal);

    expect(snapshot.capabilities[RuntimeCapabilityRegistry.subagentInterception.id])
      .toMatchObject({ status: "unavailable" });
    expect(snapshot.capabilities[RuntimeCapabilityRegistry.commandHooks.id])
      .toMatchObject({ status: "available" });
    await fake.shutdown();
  });
});
