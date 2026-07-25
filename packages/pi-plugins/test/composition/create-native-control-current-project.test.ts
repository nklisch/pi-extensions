import { describe, expect, it, vi } from "vitest";
import { createNativeControlCurrentProjectPort } from "../../src/composition/create-native-control-current-project.js";

const scope = {
  kind: "project" as const,
  projectKey: `project-v1:sha256:${"a".repeat(64)}`,
  identity: { kind: "path-only" as const, canonicalRoot: "file:///workspace/", limitation: "identity-changes-with-canonical-root" as const },
};
const trusted = { identity: scope.identity, projectKey: scope.projectKey, trust: { kind: "trusted" as const } };
const untrusted = { ...trusted, trust: { kind: "untrusted" as const } };

describe("native control current project binding", () => {
  it("distinguishes trusted, stale, untrusted, and unavailable bindings", async () => {
    const assess = vi.fn(async () => ({ kind: "trusted" as const }));
    const trustedPort = createNativeControlCurrentProjectPort({ scope: scope as never, current: () => trusted as never, revalidate: async () => trusted as never, trust: { assess } });
    await expect(trustedPort.current(new AbortController().signal)).resolves.toMatchObject({ kind: "trusted", projectKey: scope.projectKey });

    const stalePort = createNativeControlCurrentProjectPort({ scope: scope as never, current: () => trusted as never, revalidate: async () => untrusted as never, trust: { assess } });
    await expect(stalePort.current(new AbortController().signal)).resolves.toEqual({ kind: "stale" });

    const untrustedPort = createNativeControlCurrentProjectPort({ scope: scope as never, current: () => untrusted as never, revalidate: async () => untrusted as never, trust: { assess } });
    await expect(untrustedPort.current(new AbortController().signal)).resolves.toEqual({ kind: "untrusted" });

    const unavailablePort = createNativeControlCurrentProjectPort({ scope: scope as never, current: () => trusted as never, revalidate: async () => { throw new Error("offline"); }, trust: { assess } });
    await expect(unavailablePort.current(new AbortController().signal)).resolves.toEqual({ kind: "unavailable" });
  });

  it("rethrows abort instead of collapsing it into stale or unavailable", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    const port = createNativeControlCurrentProjectPort({
      scope: scope as never,
      current: () => trusted as never,
      revalidate: vi.fn(),
      trust: { assess: vi.fn() },
    });
    await expect(port.current(controller.signal)).rejects.toBe(reason);
  });
});
