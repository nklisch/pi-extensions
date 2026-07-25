import { describe, expect, it, vi } from "vitest";
import { executeTrustedInstallLifecycle } from "../../src/application/trusted-install-lifecycle.js";

const revision = `sha256:${"1".repeat(64)}` as never;
const candidate = {
  binding: { scope: { kind: "user" }, plugin: "demo@market", immutableRevision: revision },
  revision: { revision },
  resolved: {
    scope: { kind: "user" },
    entry: { source: { value: { kind: "git", url: "https://example.invalid/plugin.git" } } },
    marketplace: { source: {}, root: "/private/market", content: { rootDigest: `sha256:${"2".repeat(64)}` }, binding: `sha256:${"3".repeat(64)}` },
  },
  lease: { release: vi.fn(async () => undefined) },
} as never;

function setup(record?: { selectedRevision: string; activation: "enabled" | "disabled"; pendingTransition?: string }) {
  const installPrepared = vi.fn(async () => ({ kind: "changed" as const, operation: "install" as const, snapshot: {}, observation: {} }));
  const enable = vi.fn(async () => ({ kind: "changed" as const, operation: "enable" as const, snapshot: {}, observation: {} }));
  const state = { read: vi.fn(async () => ({ ok: true as const, snapshot: { installed: { plugins: record === undefined ? [] : [{ plugin: "demo@market", ...record }] } } })) };
  return { installPrepared, enable, state };
}

const pathContext = { scope: { kind: "user" as const }, trustedBaseDirectory: "/session/cwd" };

describe("trusted-install lifecycle bridge", () => {
  it("transfers an absent exact candidate to prepared install", async () => {
    const value = setup();
    const result = await executeTrustedInstallLifecycle(candidate, pathContext, {
      state: value.state as never, prepared: { installPrepared: value.installPrepared } as never, publicLifecycle: { enable: value.enable } as never,
    }, new AbortController().signal);
    expect(result.kind).toBe("lifecycle");
    expect(value.installPrepared).toHaveBeenCalledTimes(1);
    expect(value.enable).not.toHaveBeenCalled();
  });

  it("returns current state or enables only the exact selected revision", async () => {
    const current = setup({ selectedRevision: revision, activation: "enabled" });
    await expect(executeTrustedInstallLifecycle(candidate, pathContext, { state: current.state as never, prepared: { installPrepared: current.installPrepared } as never, publicLifecycle: { enable: current.enable } as never }, new AbortController().signal))
      .resolves.toMatchObject({ kind: "current-state", activation: "enabled", revision });
    const disabled = setup({ selectedRevision: revision, activation: "disabled" });
    const result = await executeTrustedInstallLifecycle(candidate, pathContext, { state: disabled.state as never, prepared: { installPrepared: disabled.installPrepared } as never, publicLifecycle: { enable: disabled.enable } as never }, new AbortController().signal);
    expect(result.kind).toBe("lifecycle");
    expect(disabled.enable).toHaveBeenCalledTimes(1);
    expect(disabled.installPrepared).not.toHaveBeenCalled();
  });

  it("never turns another installed revision into update", async () => {
    const value = setup({ selectedRevision: `sha256:${"9".repeat(64)}`, activation: "enabled" });
    await expect(executeTrustedInstallLifecycle(candidate, pathContext, { state: value.state as never, prepared: { installPrepared: value.installPrepared } as never, publicLifecycle: { enable: value.enable } as never }, new AbortController().signal))
      .resolves.toEqual({ kind: "conflict", reason: "already-installed-different-revision" });
    expect(value.installPrepared).not.toHaveBeenCalled();
    expect(value.enable).not.toHaveBeenCalled();
  });
});
