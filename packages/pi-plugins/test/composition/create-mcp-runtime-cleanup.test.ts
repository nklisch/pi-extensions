import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const cleanupMocks = vi.hoisted(() => ({
  drain: vi.fn(async () => undefined),
  reconcile: vi.fn(async () => ({ kind: "applied" as const })),
  observe: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../../src/runtime/mcp/revision-lease-provider.js", () => ({
  createMcpRevisionLeaseProvider: () => ({
    acquire: vi.fn(),
    release: vi.fn(),
    drain: cleanupMocks.drain,
  }),
}));

vi.mock("../../src/runtime/mcp/lifecycle-participant.js", () => ({
  createMcpLifecycleParticipant: (input: Readonly<{
    runtimeLeases(registration: unknown): unknown;
  }>) => {
    // Seed one provider so the regression can distinguish fail-fast setup from
    // the helper's normal attempt-all cleanup path.
    input.runtimeLeases({});
    return {
      reconcile: cleanupMocks.reconcile,
      observe: cleanupMocks.observe,
      status: cleanupMocks.status,
    };
  },
}));

import { createComposedMcpRuntime } from "../../src/composition/create-mcp-runtime.js";

const digest = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

describe("composed MCP runtime cleanup", () => {
  it("stops at synchronous inactive-expectation setup failure without draining providers", async () => {
    const setupError = new Error("inactive expectation setup failed");
    let failSetup = false;
    const sha256 = (bytes: Uint8Array): Uint8Array => {
      if (failSetup) throw setupError;
      return digest(bytes);
    };
    const currentProject = { trust: { kind: "trusted" as const } };
    const runtime = createComposedMcpRuntime({
      selections: {} as never,
      content: {} as never,
      project: {
        current: () => currentProject,
        authority: {} as never,
        trust: {} as never,
      } as never,
      configuration: {} as never,
      environment: {} as never,
      leases: {} as never,
      clock: {} as never,
      sessionId: "cleanup-test",
      sha256,
    });
    const source = {
      kind: "source",
      expectation: {
        projection: {
          scope: { kind: "user" },
          plugin: "fixture@cleanup",
        },
      },
    } as never;

    await expect(runtime.reconcileAll([
      { from: source, to: source },
    ], new AbortController().signal)).resolves.toEqual([{ kind: "applied" }]);
    failSetup = true;

    let rejection: unknown;
    try {
      await runtime.close();
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBe(setupError);
    expect((rejection as Error).message).toBe("inactive expectation setup failed");
    expect(cleanupMocks.reconcile).toHaveBeenCalledTimes(1);
    expect(cleanupMocks.drain).not.toHaveBeenCalled();
  });
});
