import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSkillResourceDiscovery } from "../../src/pi/skill-resource-discovery.js";
import type { SkillResourceDiscoveryPort, SkillResourceDiscoveryResult } from "../../src/runtime/skills/resource-discovery.js";

type Handler = (...args: readonly unknown[]) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = { on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function context(trusted: boolean, cwd = "/workspace"): ExtensionContext {
  return { cwd, isProjectTrusted: () => trusted } as unknown as ExtensionContext;
}

const event = (reason: "startup" | "reload", cwd = "/workspace") => ({ type: "resources_discover" as const, reason, cwd });
const shutdown = () => ({ type: "session_shutdown" as const, reason: "reload" as const });

describe("Pi skill resources_discover adapter", () => {
  it("registers exactly the typed discovery and shutdown handlers", async () => {
    const fake = fakePi();
    const requests: Array<{ reason: string; projectTrusted: boolean }> = [];
    const resources: SkillResourceDiscoveryPort = { async discover(request) { requests.push(request); return { kind: "ready", skillPaths: ["/immutable/SKILL.md"], failedTargets: [] }; } };
    registerSkillResourceDiscovery(fake.pi, resources);
    expect(fake.handlers.get("resources_discover")).toHaveLength(1);
    expect(fake.handlers.get("session_shutdown")).toHaveLength(1);
    expect(fake.handlers.size).toBe(2);
    const result = await fake.handlers.get("resources_discover")![0]!(event("startup"), context(true));
    expect(result).toEqual({ skillPaths: ["/immutable/SKILL.md"] });
    await fake.handlers.get("resources_discover")![0]!(event("reload"), context(false));
    expect(requests).toEqual([{ reason: "startup", projectTrusted: true }, { reason: "reload", projectTrusted: false }]);
  });

  it("returns healthy paths despite target failures and exposes safe global failures", async () => {
    const fake = fakePi();
    const resources: SkillResourceDiscoveryPort = { async discover(): Promise<SkillResourceDiscoveryResult> { return { kind: "ready", skillPaths: ["/healthy/SKILL.md"], failedTargets: [{ scope: { kind: "user" }, plugin: "bad@source" as never, code: "ROOT_MUTATED" }] }; } };
    registerSkillResourceDiscovery(fake.pi, resources);
    await expect(fake.handlers.get("resources_discover")![0]!(event("startup"), context(true))).resolves.toEqual({ skillPaths: ["/healthy/SKILL.md"] });

    const failed: SkillResourceDiscoveryPort = { async discover() { return { kind: "failed", code: "ADAPTER_FAILED" }; } };
    const second = fakePi();
    registerSkillResourceDiscovery(second.pi, failed);
    await expect(second.handlers.get("resources_discover")![0]!(event("startup"), context(true))).rejects.toMatchObject({ message: "ADAPTER_FAILED" });
  });

  it("owns cancellation for the extension lifetime and does not publish a stale result", async () => {
    const fake = fakePi();
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const resources: SkillResourceDiscoveryPort = { async discover(_request, receivedSignal) { signal = receivedSignal; await pending; return receivedSignal.aborted ? { kind: "cancelled" } : { kind: "ready", skillPaths: ["/stale/SKILL.md"], failedTargets: [] }; } };
    registerSkillResourceDiscovery(fake.pi, resources);
    const running = fake.handlers.get("resources_discover")![0]!(event("reload"), context(true));
    fake.handlers.get("session_shutdown")![0]!(shutdown(), context(true));
    expect(signal?.aborted).toBe(true);
    release();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects an event/context cwd disagreement without exposing paths", async () => {
    const fake = fakePi();
    let called = false;
    const resources: SkillResourceDiscoveryPort = { async discover() { called = true; return { kind: "ready", skillPaths: ["/should-not-return"], failedTargets: [] }; } };
    registerSkillResourceDiscovery(fake.pi, resources);
    await expect(fake.handlers.get("resources_discover")![0]!(event("startup", "/event"), context(true, "/context"))).rejects.toMatchObject({ message: "CURRENT_PROJECT_MISMATCH" });
    expect(called).toBe(false);
  });
});