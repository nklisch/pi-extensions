import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNodeMarketplaceDiscoveryServices } from "../../src/composition/create-marketplace-discovery-services.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import { deriveMarketplaceSourceIdentity } from "../../src/domain/update-policy.js";
import type { Sha256 } from "../../src/domain/source.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" as const };
const currentProject = { kind: "project" as const, identity, projectKey: deriveProjectKey(identity, sha256) };

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    state: { read: vi.fn(), commit: vi.fn() } as never,
    inventory: { discover: vi.fn() } as never,
    mutations: { runPreparedMutation: vi.fn() } as never,
    clock: { nowEpochMilliseconds: () => 0, monotonicMilliseconds: () => 0 },
    claimIds: { create: vi.fn() } as never,
    materializers: { marketplaces: { materialize: vi.fn() } as never },
    inspection: { inspect: vi.fn() } as never,
    content: {} as never,
    currentProject,
    projectTrust: { assess: vi.fn() } as never,
    sha256,
    userHome: "/home/test",
    ...overrides,
  };
}

describe("marketplace discovery composition", () => {
  it("constructs one inert capability and keeps compatibility and candidate-resolution seams private", () => {
    const read = vi.fn();
    const discover = vi.fn();
    const materialize = vi.fn();
    const inspect = vi.fn();
    const assess = vi.fn();
    const revalidateCurrentProject = vi.fn();
    const services = createNodeMarketplaceDiscoveryServices(dependencies({
      state: { read, commit: vi.fn() } as never,
      inventory: { discover } as never,
      materializers: { marketplaces: { materialize } as never },
      inspection: { inspect } as never,
      projectTrust: { assess } as never,
      revalidateCurrentProject,
    }));

    expect(Object.keys(services).sort()).toEqual(["adoption", "catalog", "policy", "refresh", "registration"]);
    expect(Object.keys(services.registration).sort()).toEqual(["add", "list", "remove"]);
    expect(Object.keys(services.catalog).sort()).toEqual(["detail", "search"]);
    expect(Object.keys(services.adoption).sort()).toEqual(["import", "preview"]);
    expect(services.catalog).not.toHaveProperty("resolve");
    expect(services.registration).not.toHaveProperty("register");
    expect(services.adoption).not.toHaveProperty("discover");
    expect(services.adoption).not.toHaveProperty("adopt");
    expect(read).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(assess).not.toHaveBeenCalled();
    expect(revalidateCurrentProject).not.toHaveBeenCalled();
  });

  it("binds all-current operations to user state when no current project exists", async () => {
    const signal = new AbortController().signal;
    const read = vi.fn(async (scope) => ({ ok: false as const, scope, corruptions: [] }));
    const discover = vi.fn().mockResolvedValue({ scopes: [{ kind: "user" }, currentProject], complete: true });
    const configured = dependencies({ state: { read, commit: vi.fn() } as never, inventory: { discover } as never });
    const { currentProject: _project, projectTrust: _trust, ...userOnly } = configured;
    const services = createNodeMarketplaceDiscoveryServices(userOnly);

    await services.registration.list({ scope: "all-current", limit: 50 }, signal);
    await services.refresh.nextScheduledAt(signal);
    await services.catalog.search({ scope: "all-current", query: "", limit: 50 }, signal);

    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(([scope]) => scope.kind === "user")).toBe(true);
  });

  it("revalidates project identity and binds policy mutation to the exact current project", async () => {
    const signal = new AbortController().signal;
    const read = vi.fn().mockResolvedValue({ ok: false, scope: currentProject, corruptions: [] });
    const assess = vi.fn().mockResolvedValue({ kind: "trusted" });
    const revalidateCurrentProject = vi.fn().mockResolvedValue({ projectKey: currentProject.projectKey, trust: { kind: "trusted" } });
    const services = createNodeMarketplaceDiscoveryServices(dependencies({
      state: { read, commit: vi.fn() } as never,
      projectTrust: { assess } as never,
      revalidateCurrentProject,
    }));

    const result = await services.policy.setApplicationPreference({
      scope: "project",
      marketplace: "community",
      sourceIdentity: deriveMarketplaceSourceIdentity({ kind: "github", repository: "example/community" }, sha256),
      preference: "manual",
    }, signal);

    expect(result).toEqual({ kind: "rejected", code: "STATE_STALE" });
    expect(revalidateCurrentProject).toHaveBeenCalledWith(signal);
    expect(assess).toHaveBeenCalledWith(currentProject.projectKey, signal);
    expect(read).toHaveBeenCalledWith(currentProject, signal);
  });
});
