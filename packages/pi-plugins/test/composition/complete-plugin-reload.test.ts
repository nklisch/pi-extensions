import { describe, expect, it, vi } from "vitest";
import { createCompletePluginReloadPort } from "../../src/composition/complete-plugin-reload.js";
import { createRuntimeSelectionCatalog } from "../../src/composition/runtime-selection-catalog.js";
import { createPiReloadBroker } from "../../src/pi/pi-reload-broker.js";

const project = {
  identity: { kind: "path-only" as const, canonicalRoot: "file:///workspace/" as never, limitation: "identity-changes-with-canonical-root" as const },
  projectKey: `project-v1:sha256:${"a".repeat(64)}` as never,
  trust: { kind: "trusted" as const },
};
const desired = { currentProject: project, selections: [], skillHook: { active: [], currentProject: project }, mcp: [], blocked: [] };

function fixture(fail = false, commandContext?: { reload(): Promise<void> }) {
  const events: string[] = [];
  const catalog = createRuntimeSelectionCatalog(project);
  let reconciles = 0;
  const skill = {
    participant: {
      reconcile: vi.fn(async () => {
        events.push("skill");
        reconciles += 1;
        return fail && reconciles === 1 ? { kind: "failed", code: "ADAPTER_FAILED" } : { kind: "applied", count: 0 };
      }),
      observe: vi.fn(),
    },
    resources: { discover: vi.fn(async () => { events.push("resources"); return { kind: "ready", skillPaths: [], failedTargets: [] }; }) },
    replaceSessionLease: vi.fn(async () => { events.push("lease"); }),
    quiesce: vi.fn(() => events.push("quiesce")),
    resume: vi.fn(() => events.push("resume")),
  };
  const mcp = { reconcileAll: vi.fn(async () => { events.push("mcp"); return []; }), participant: { observe: vi.fn() } };
  const broker = createPiReloadBroker();
  let availableContext = commandContext;
  const reload = createCompletePluginReloadPort({
    binding: { current: () => ({ sessionId: "s", cwd: "/workspace", mode: "interactive", projectTrusted: true }), assertContext: vi.fn(), isProjectTrusted: () => true },
    operationContext: { takeReloadContext: () => { const current = availableContext; availableContext = undefined; return current as never; } },
    broker,
    desired: { load: async () => { events.push("desired"); return desired; } },
    selections: catalog,
    skillHook: skill as never,
    mcp: mcp as never,
    transitions: () => ({} as never),
    sha256: () => new Uint8Array(32),
  });
  return { events, reload, catalog, skill, mcp, broker };
}

describe("complete plugin reload", () => {
  it("reconciles desired skills, MCP, resources, leases, and admission in canonical order", async () => {
    const test = fixture();
    await expect(test.reload.reconcileCurrent(new AbortController().signal)).resolves.toEqual([]);
    expect(test.events).toEqual(["desired", "quiesce", "skill", "mcp", "resources", "lease", "resume"]);
    expect(test.catalog.snapshot().selections).toEqual([]);
  });

  it("rolls the candidate epoch back and restores the previous participant set on failure", async () => {
    const test = fixture(true);
    await expect(test.reload.reconcileCurrent(new AbortController().signal)).rejects.toThrow(/skill\/hook reconciliation failed/);
    expect(test.catalog.snapshot().selections).toEqual([]);
    expect(test.skill.resume).not.toHaveBeenCalled();
    expect(test.events).toEqual(["desired", "quiesce", "skill", "quiesce", "skill", "mcp"]);
  });

  it("consumes one old Pi reload context and settles only through successor broker evidence", async () => {
    let test!: ReturnType<typeof fixture>;
    const context = { reload: vi.fn(async () => {
      test.events.push("shutdown");
      const ticket = test.broker.claimSuccessor({ sessionId: "s", cwd: "/workspace", mode: "interactive", projectTrusted: true });
      if (ticket === undefined) throw new Error("successor did not claim ticket");
      test.events.push("successor-start");
      test.events.push("successor-discover");
      test.broker.publish(ticket, []);
    }) };
    test = fixture(false, context);
    const request = { scope: { kind: "user" as const }, transition: `pending:${"c".repeat(64)}` as never };
    await expect(test.reload.reload(request, new AbortController().signal)).resolves.toEqual({ kind: "accepted" });
    expect(context.reload).toHaveBeenCalledOnce();
    expect(test.events).toEqual(["shutdown", "successor-start", "successor-discover"]);
    await expect(test.reload.reload(request, new AbortController().signal)).resolves.toEqual({ kind: "failed", code: "PI_RELOAD_CONTEXT_UNAVAILABLE" });
    expect(context.reload).toHaveBeenCalledOnce();
  });

  it("fails closed when lifecycle reload has no exact Pi command context", async () => {
    const test = fixture();
    await expect(test.reload.reload({ scope: { kind: "user" }, transition: `pending:${"b".repeat(64)}` as never }, new AbortController().signal))
      .resolves.toEqual({ kind: "failed", code: "PI_RELOAD_CONTEXT_UNAVAILABLE" });
  });
});
