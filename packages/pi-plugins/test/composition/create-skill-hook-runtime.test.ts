import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createComposedSkillHookRuntime } from "../../src/composition/create-skill-hook-runtime.js";
import { createRuntimeSelectionCatalog } from "../../src/composition/runtime-selection-catalog.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import { createPluginHostRuntimeDelegates } from "../../src/pi/plugin-host-runtime-delegates.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = { kind: "path-only" as const, canonicalRoot: "file:///workspace/project/" as never, limitation: "identity-changes-with-canonical-root" as const };
const projectKey = deriveProjectKey(identity, sha256);
const currentProject = { identity, projectKey, trust: { kind: "trusted" as const } };

function piFixture() {
  const handlers = new Map<string, Array<(event: never, context: ExtensionContext) => unknown>>();
  const pi = {
    on(name: string, handler: (event: never, context: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage: vi.fn(),
    setSessionName: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

const binding = {
  current: () => ({ sessionId: "session-1", cwd: "/workspace/project", mode: "tui" as const, projectTrusted: true }),
  assertContext: vi.fn(),
  isProjectTrusted: () => true,
};
const project = {
  scope: { kind: "project" as const, identity, projectKey },
  current: () => currentProject,
  authority: { acquire: vi.fn(), verify: vi.fn() },
  trust: { assess: vi.fn() },
} as never;
const configuration = {
  withResolvedPluginConfiguration: vi.fn(),
  dependencies: {},
} as never;

describe("composed skill/hook runtime", () => {
  it("keeps delegates inert until startup, owns one session lease, and closes idempotently", async () => {
    const { pi, handlers } = piFixture();
    const delegates = createPluginHostRuntimeDelegates(pi);
    const context = {} as ExtensionContext;
    await handlers.get("input")?.[0]?.({ type: "input", text: "before", source: "interactive" } as never, context);
    expect(binding.assertContext).not.toHaveBeenCalled();
    const leases = {
      acquire: vi.fn(async (request) => ({ leaseId: crypto.randomUUID(), sessionId: request.sessionId, artifacts: request.artifacts, acquiredAt: request.at })),
      replace: vi.fn(),
      release: vi.fn(),
      list: vi.fn(),
    } as never;
    const runtime = await createComposedSkillHookRuntime({
      pi,
      binding,
      content: { content: {} as never, installed: {} as never },
      selection: createRuntimeSelectionCatalog(currentProject),
      project,
      configuration,
      leases,
      clock: { nowEpochMilliseconds: () => 1 as never, monotonicMilliseconds: () => 1 },
      sha256,
      delegates,
    });
    await runtime.replaceSessionLease([], new AbortController().signal);
    expect(leases.acquire).toHaveBeenCalledOnce();
    await runtime.close();
    await runtime.close();
    expect(leases.release).toHaveBeenCalledOnce();
    await handlers.get("input")?.[0]?.({ type: "input", text: "after", source: "interactive" } as never, context);
    expect(binding.assertContext).not.toHaveBeenCalled();
  });

  it("clears partially wired delegates when optional participant qualification fails", async () => {
    const { pi, handlers } = piFixture();
    const delegates = createPluginHostRuntimeDelegates(pi);
    await expect(createComposedSkillHookRuntime({
      pi,
      binding,
      content: { content: {} as never, installed: {} as never },
      selection: createRuntimeSelectionCatalog(currentProject),
      project,
      configuration,
      leases: {} as never,
      clock: { nowEpochMilliseconds: () => 1 as never, monotonicMilliseconds: () => 1 },
      subagents: { capabilities: async () => { throw new Error("qualification failed"); } } as never,
      sha256,
      delegates,
    })).rejects.toThrow("qualification failed");
    await handlers.get("input")?.[0]?.({ type: "input", text: "after", source: "interactive" } as never, {} as ExtensionContext);
    expect(binding.assertContext).not.toHaveBeenCalled();
  });
});
