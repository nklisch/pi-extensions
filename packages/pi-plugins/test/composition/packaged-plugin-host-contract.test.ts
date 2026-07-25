import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deriveProjectKey, type ProjectIdentity } from "../../src/domain/state/scope.js";
import { createPluginHostPathPlan } from "../../src/composition/plugin-host-paths.js";
import type { NativePluginControlService } from "../../src/application/native-control-service.js";
import type { PackagedPluginHostApplication } from "../../src/composition/packaged-plugin-host-contract.js";
import {
  claimPackagedPluginHostComposition,
  createPluginHostBootstrap,
} from "../../src/pi/plugin-host-bootstrap.js";

const sha256 = (_bytes: Uint8Array): Uint8Array => new Uint8Array(32).fill(0xab);

function fakePi() {
  const handlers = new Map<string, Array<(event: never, context: ExtensionContext) => unknown>>();
  const pi = {
    on(name: string, handler: (event: never, context: ExtensionContext) => unknown): void {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

describe("packaged host construct-only contract", () => {
  it("exposes only the unified native control surface", () => {
    expectTypeOf<PackagedPluginHostApplication["control"]>().toEqualTypeOf<NativePluginControlService>();
    expectTypeOf<PackagedPluginHostApplication>().not.toHaveProperty("inspection");
    expectTypeOf<PackagedPluginHostApplication>().not.toHaveProperty("trustedInstallation");
    expectTypeOf<PackagedPluginHostApplication>().not.toHaveProperty("updates");
    expectTypeOf<PackagedPluginHostApplication>().not.toHaveProperty("marketplace");
  });

  it("plans collision-free paths using only the verified project digest", () => {
    const plan = createPluginHostPathPlan("/agent");
    const identity: ProjectIdentity = {
      kind: "path-only",
      canonicalRoot: "file:///workspace/" as never,
      limitation: "identity-changes-with-canonical-root",
    };
    const projectKey = deriveProjectKey(identity, sha256);

    expect(plan.hostRoot).toBe("/agent/plugin-host");
    expect(plan.stateDatabase({ kind: "user" })).toBe("/agent/plugin-host/state/v1/user.sqlite");
    expect(plan.stateDatabase({ kind: "project", projectKey })).toBe(
      `/agent/plugin-host/state/v1/project-${"ab".repeat(32)}.sqlite`,
    );
    expect(plan.lockRoot).toBe("/agent/plugin-host/locks/v1");
    expect(JSON.stringify(plan)).not.toContain("workspace");
    expect(() => createPluginHostPathPlan("relative")).toThrowError(expect.objectContaining({ code: "HOST_INVALID_OPTIONS" }));
  });

  it("registers inert lifecycle delegates and rejects duplicate composition", async () => {
    const { pi, handlers } = fakePi();
    const claim = claimPackagedPluginHostComposition(pi);
    expect(() => claimPackagedPluginHostComposition(pi)).toThrowError(expect.objectContaining({ code: "HOST_DUPLICATE_COMPOSITION" }));
    const bootstrap = createPluginHostBootstrap(pi);
    const start = vi.fn();
    const context = {} as ExtensionContext;

    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" } as never, context);
    expect(start).not.toHaveBeenCalled();

    bootstrap.activate({ sessionStart: start, sessionShutdown: vi.fn() });
    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" } as never, context);
    expect(start).toHaveBeenCalledOnce();
    bootstrap.clear();
    claim.release();
    expect(() => claimPackagedPluginHostComposition(pi)).not.toThrow();
  });

  it("permits only one exact ticketed draining predecessor overlap", () => {
    const first = fakePi();
    const second = fakePi();
    const third = fakePi();
    const predecessor = claimPackagedPluginHostComposition(first.pi);
    const successor = claimPackagedPluginHostComposition(second.pi);
    const intruder = claimPackagedPluginHostComposition(third.pi);
    predecessor.claimSession("session-a");
    predecessor.markDraining("ticket-a");
    expect(() => successor.claimSession("session-a", "wrong")).toThrowError(expect.objectContaining({ code: "HOST_DUPLICATE_SESSION" }));
    successor.claimSession("session-a", "ticket-a");
    expect(() => intruder.claimSession("session-a", "ticket-a")).toThrowError(expect.objectContaining({ code: "HOST_DUPLICATE_SESSION" }));
    successor.release();
    predecessor.release();
    intruder.release();
  });
});
