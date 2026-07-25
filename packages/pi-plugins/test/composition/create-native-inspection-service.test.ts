import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createComposedNativeInspectionService } from "../../src/composition/create-native-inspection-service.js";
import { createRuntimeSelectionCatalog } from "../../src/composition/runtime-selection-catalog.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const project = { identity: { kind: "path-only" as const, canonicalRoot: "file:///project/" as never, limitation: "identity-changes-with-canonical-root" as const }, projectKey: `project-v1:sha256:${"11".repeat(32)}` as never, trust: { kind: "trusted" as const } };

describe("composed native inspection service", () => {
  it("constructs a read-only clean-host service without touching candidate/runtime mutation seams", async () => {
    const state = {
      read: vi.fn(async (scope: any) => scope.kind === "user"
        ? { ok: true, snapshot: { scope: { kind: "user" }, generation: 0, corruptions: [], installed: { plugins: [], marketplaces: [] }, config: { records: [] }, trust: { records: [] } } }
        : { ok: true, snapshot: { scope: { kind: "project", identity: project.identity, projectKey: project.projectKey }, generation: 0, corruptions: [], project: { plugins: [], marketplaces: [], marketplaceUpdates: [] } } }),
      commit: vi.fn(),
    };
    const catalogSearch = vi.fn(async () => ({ candidates: [], observations: [] }));
    const candidateMaterialize = vi.fn();
    const service = createComposedNativeInspectionService({
      state: state as never,
      scopes: [{ kind: "user" }, { kind: "project", identity: project.identity, projectKey: project.projectKey }] as never,
      revalidateProject: async () => project,
      selections: createRuntimeSelectionCatalog(project),
      desired: () => undefined,
      skillHook: { observe: vi.fn() },
      mcp: { status: vi.fn() },
      recovery: { results: [], deferred: false, processed: 0 },
      startup: { status: "ready", blocked: [], capabilities: { mcp: { status: "unavailable", explanation: "none" }, subagents: { status: "unavailable", explanation: "none" }, piReload: { status: "available", explanation: "ready" }, secrets: { status: "available", explanation: "ready" } } },
      configurations: { read: vi.fn(), replace: vi.fn(), remove: vi.fn() },
      projectTrust: { assess: async () => ({ kind: "trusted" }) },
      secretCustody: { status: "available", explanation: "ready" },
      installed: { load: vi.fn() },
      candidateContent: { withMaterialized: candidateMaterialize },
      bundleInspector: { inspect: vi.fn() },
      marketplace: { catalog: { search: catalogSearch, detail: vi.fn(), resolve: vi.fn() }, adoption: { preview: vi.fn() } } as never,
      clock: { nowEpochMilliseconds: () => 1 } as never,
      sha256,
    });
    const page = await service.list({ subjects: ["installed"], scope: "all-current", query: "", limit: 50 }, new AbortController().signal);
    expect(page.items).toEqual([]);
    expect(page.condition).toBe("ready");
    expect(state.commit).not.toHaveBeenCalled();
    expect(catalogSearch).not.toHaveBeenCalled();
    expect(candidateMaterialize).not.toHaveBeenCalled();
  });
});
