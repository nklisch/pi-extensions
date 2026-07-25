import { describe, expect, it } from "vitest";
import { createNodePiRuntimeCapabilityProbe } from "../../src/composition/node-pi-runtime-capability-probe.js";
import { qualifyRuntimeParticipants } from "../../src/composition/runtime-participant-qualification.js";
import { RuntimeCapabilityRegistry } from "../../src/domain/compatibility-policy.js";

const executables = {
  async resolve(request: { command: string }) {
    if (request.command !== "bash") throw new Error("missing");
    return { executable: "/bin/bash", resolution: "path" as const, identity: "bash" as never };
  },
};
const pi = { on() {}, sendMessage() {}, setSessionName() {} };

async function qualification(runtime: { mcp?: never } = {}) {
  return await qualifyRuntimeParticipants({
    pi: pi as never,
    nodeVersion: "24.0.0",
    piVersion: "0.80.8",
    ...runtime,
    signal: new AbortController().signal,
  });
}

describe("Node/Pi runtime capability probe", () => {
  it("returns every registry fact exactly once and preserves optional adapter absence", async () => {
    const probe = createNodePiRuntimeCapabilityProbe({ executables, qualification: await qualification() });
    const snapshot = await probe.snapshot(new AbortController().signal);
    expect(Object.keys(snapshot.capabilities).sort()).toEqual(
      Object.values(RuntimeCapabilityRegistry).map((entry) => entry.id).sort(),
    );
    expect(snapshot.capabilities[RuntimeCapabilityRegistry.commandHooks.id].status).toBe("available");
    expect(snapshot.capabilities[RuntimeCapabilityRegistry.bash.id].status).toBe("available");
    expect(snapshot.capabilities[RuntimeCapabilityRegistry.powershell.id].status).toBe("unavailable");
    expect(snapshot.capabilities[RuntimeCapabilityRegistry.mcpRuntime.id].status).toBe("unavailable");
    expect(snapshot.capabilities[RuntimeCapabilityRegistry.subagentInterception.id].status).toBe("unavailable");
  });

  it("makes contradictory present evidence consistently unavailable", async () => {
    const decision = await qualification({ mcp: { capabilities: async () => ({}) } as never });
    expect(decision.mcp.status).toBe("unavailable");
    const probe = createNodePiRuntimeCapabilityProbe({ executables, qualification: decision });
    const snapshot = await probe.snapshot(new AbortController().signal);
    expect(snapshot.capabilities[RuntimeCapabilityRegistry.mcpRuntime.id].status).toBe("unavailable");
  });
});
