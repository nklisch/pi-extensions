import { describe, expect, it } from "vitest";
import { createNativeControlEnvelope } from "../../src/application/native-control-contract.js";
import { createPiManagerReloadHandoff } from "../../src/pi/pi-manager-reload-handoff.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const envelope = createNativeControlEnvelope({ executionId, command: "status", status: "ok" });
const report = Object.freeze({ envelope, delivery: "complete" as const, deliveredThrough: 2 });

describe("Pi manager reload handoff", () => {
  it("moves only a schema-valid plain report to the exact successor", async () => {
    const handoff = createPiManagerReloadHandoff({ namespace: "test-exact" });
    const ticket = handoff.open({ sessionId: "s1", cwd: "/workspace", destination: "operation-result" });
    expect(handoff.claimSuccessor({ sessionId: "s1", cwd: "/wrong" })).toBeUndefined();
    const claim = handoff.claimSuccessor({ sessionId: "s1", cwd: "/workspace" });
    expect(claim?.destination).toBe("operation-result");
    expect(handoff.claimSuccessor({ sessionId: "s1", cwd: "/workspace" })).toBeUndefined();
    expect(handoff.publish(ticket, report)).toBe("successor");
    await expect(claim?.result).resolves.toEqual(report);
    expect(() => handoff.publish(ticket, report)).toThrow(/settled|unknown/);
  });

  it("keeps reload pending but clears quit/new/resume/fork sessions", async () => {
    const handoff = createPiManagerReloadHandoff({ namespace: "test-close" });
    handoff.open({ sessionId: "s2", cwd: "/workspace", destination: "install-result" });
    handoff.closeSession("s2", "reload");
    const claim = handoff.claimSuccessor({ sessionId: "s2", cwd: "/workspace" });
    expect(claim).toBeDefined();
    handoff.closeSession("s2", "quit");
    await expect(claim?.result).rejects.toThrow(/closed/);

    for (const reason of ["new", "resume", "fork"] as const) {
      handoff.open({ sessionId: reason, cwd: "/workspace", destination: "operation-result" });
      handoff.closeSession(reason, reason);
      expect(handoff.claimSuccessor({ sessionId: reason, cwd: "/workspace" })).toBeUndefined();
    }
  });

  it("returns local ownership when no reload successor claimed", () => {
    const handoff = createPiManagerReloadHandoff({ namespace: "test-local" });
    const ticket = handoff.open({ sessionId: "s3", cwd: "/workspace", destination: "operation-result" });
    expect(handoff.publish(ticket, report)).toBe("local");
    expect(handoff.claimSuccessor({ sessionId: "s3", cwd: "/workspace" })).toBeUndefined();
  });

  it("rejects duplicate session slots and malformed envelopes", () => {
    const handoff = createPiManagerReloadHandoff({ namespace: "test-invalid" });
    const ticket = handoff.open({ sessionId: "s4", cwd: "/workspace", destination: "operation-result" });
    expect(() => handoff.open({ sessionId: "s4", cwd: "/workspace", destination: "install-result" })).toThrow(/pending/);
    expect(() => handoff.publish(ticket, { ...report, envelope: { ...envelope, data: { secret: Symbol("x") } } } as never)).toThrow();
    handoff.fail(ticket, new Error("native detail must not cross"));
  });
});
