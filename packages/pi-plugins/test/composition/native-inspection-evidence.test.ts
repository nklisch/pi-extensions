import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeInspectionEvidence } from "../../src/composition/native-inspection-evidence.js";
import { createRuntimeSelectionCatalog } from "../../src/composition/runtime-selection-catalog.js";
import { capabilities } from "../fixtures/compatibility/common.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createMarketplaceSnapshotRecord } from "../../src/domain/state/installed-state.js";
import { createMarketplaceConfigurationRecord } from "../../src/domain/update-policy.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { deriveMarketplaceRegistrationId } from "../../src/domain/marketplace-registration.js";
import type { MarketplaceCacheStatus } from "../../src/application/marketplace-management-contract.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = `sha256:${"11".repeat(32)}` as never;
const projectKey = `project-v1:sha256:${"22".repeat(32)}` as never;
const projectIdentity = { kind: "path-only" as const, canonicalRoot: "file:///workspace/private/" as never, limitation: "identity-changes-with-canonical-root" as const };

function fixture() {
  let generation = 0;
  let trust: "trusted" | "untrusted" = "trusted";
  let now = 100;
  let quarantined = false;
  let failingCatalogScope: "user" | "project" | undefined;
  let catalogCache: MarketplaceCacheStatus;
  let updateState: "running" | "degraded" = "running";
  const currentProject = () => ({ identity: projectIdentity, projectKey, trust: { kind: trust } as const });
  const source = { kind: "github" as const, repository: "example/community" };
  const resolved = createResolvedMarketplaceSource({ declared: source, revision: "a".repeat(40) }, sha256);
  const contentManifest = createContentManifest([], sha256);
  const marketplaceSnapshot = createMarketplaceSnapshotRecord({ marketplace: "community", source: resolved, content: contentManifest, binding: createMaterializationBinding(resolved.hash, contentManifest.rootDigest, sha256) }, sha256);
  const registration = createMarketplaceConfigurationRecord({ marketplace: "community", source });
  const registrationId = deriveMarketplaceRegistrationId({ scope: { kind: "user" }, source }, sha256);
  catalogCache = { kind: "ready", validator: { kind: "git-commit", revision: resolved.revision }, etag: { kind: "not-applicable" } };
  const corruption = { document: "installedUser", scope: { kind: "user" }, code: "RECORD_INVALID", recordIdentity: "broken@community", location: { kind: "pointer", value: "/plugins/0" }, summary: "state record was quarantined" } as const;
  const catalogSearch = vi.fn(async (request: { scope: "user" | "project" }) => {
    if (request.scope === failingCatalogScope) throw new Error("native catalog adapter failure /private/path");
    return { candidates: [], observations: [{ registrationId, marketplace: "community", status: catalogCache.kind === "ready" ? "ready" : catalogCache.kind, cache: catalogCache }] };
  });
  const state = {
    read: vi.fn(async (scope: { kind: "user" | "project" }) => scope.kind === "user"
      ? { ok: true as const, snapshot: { scope: { kind: "user" as const }, generation, corruptions: quarantined ? [corruption] : [], installed: { plugins: [{ plugin: "demo@market", activation: "disabled", selectedRevision: digest, revisions: [] }], marketplaces: [marketplaceSnapshot] }, config: { records: [registration] }, trust: { records: [] } } }
      : { ok: true as const, snapshot: { scope: { kind: "project" as const, identity: projectIdentity, projectKey }, generation, corruptions: [], project: { plugins: [], marketplaces: [], marketplaceUpdates: [] } } }),
    commit: vi.fn(() => { throw new Error("must not mutate"); }),
  };
  const selections = createRuntimeSelectionCatalog(currentProject() as never);
  const skillHook = { observe: vi.fn(async (expectation: any) => ({ kind: "ready" as const, observation: {
    kind: "inactive" as const,
    participant: "skills-hooks" as const,
    scope: expectation.scope,
    plugin: expectation.plugin,
    projectionDigest: expectation.digest,
    currentProject: currentProject(),
    contributionDigest: digest,
    skillComponentIds: [],
    hookComponentIds: [],
  } })) };
  const mcp = { status: vi.fn(async (owner: any) => ({ kind: "ready" as const, owner, status: null })) };
  const revalidateProject = vi.fn(async () => currentProject() as never);
  const port = createNativeInspectionEvidence({
    state: state as never,
    catalog: { search: catalogSearch } as never,
    scopes: [{ kind: "user" }, { kind: "project", identity: projectIdentity, projectKey }] as never,
    revalidateProject,
    selections,
    desired: () => undefined,
    skillHook,
    mcp,
    capabilities: capabilities(),
    recovery: { results: [], deferred: false, processed: 0 },
    startup: { status: "ready", blocked: [], capabilities: {
      mcp: { status: "unavailable", explanation: "not composed" },
      subagents: { status: "unavailable", explanation: "not composed" },
      piReload: { status: "available", explanation: "ready" },
      secrets: { status: "available", explanation: "ready" },
    } },
    status: { snapshot: () => ({ status: updateState === "degraded" ? "degraded" : "ready", local: { recovery: "settled", runtime: "reconciled" }, update: { state: updateState, unreadCount: 0, unresolvedCount: 0 }, blocked: [], capabilities: {
      mcp: { status: "unavailable", explanation: "not composed" }, subagents: { status: "unavailable", explanation: "not composed" }, piReload: { status: "available", explanation: "ready" }, secrets: { status: "available", explanation: "ready" },
    } }) } as never,
    clock: { nowEpochMilliseconds: () => now } as never,
    sha256,
  });
  return {
    port,
    state,
    selections,
    skillHook,
    mcp,
    catalogSearch,
    revalidateProject,
    currentProject,
    setGeneration: (value: number) => { generation = value; },
    setQuarantined: (value: boolean) => { quarantined = value; },
    setCatalogFailure: (value: "user" | "project" | undefined) => { failingCatalogScope = value; },
    setCatalogCache: (value: MarketplaceCacheStatus) => { catalogCache = value; },
    setTrust: (value: "trusted" | "untrusted") => { trust = value; },
    setNow: (value: number) => { now = value; },
    setUpdateState: (value: "running" | "degraded") => { updateState = value; },
  };
}

describe("native inspection evidence", () => {
  it("captures deterministic path-free bindings without mutation or probing", async () => {
    const value = fixture();
    const snapshot = await value.port.capture(new AbortController().signal);
    const binding = JSON.stringify(snapshot.binding);
    expect(binding).not.toContain("workspace");
    expect(binding).not.toContain("private");
    expect(snapshot.runtime).toHaveLength(1);
    expect(snapshot.runtime[0]?.skillsHooks.kind).toBe("ready");
    expect(snapshot.binding.catalogs[0]?.scope).toEqual({ kind: "user" });
    expect(snapshot.runtime[0]?.mcp.status).toEqual({ kind: "ready", status: null });
    expect(value.state.commit).not.toHaveBeenCalled();
    expect(value.revalidateProject).toHaveBeenCalledOnce();
    expect(value.skillHook.observe).toHaveBeenCalledOnce();
    expect(value.mcp.status).toHaveBeenCalledOnce();
  });

  it("invalidates state, project-trust, and runtime epochs", async () => {
    const stateChange = fixture();
    const first = await stateChange.port.capture(new AbortController().signal);
    stateChange.setGeneration(1);
    expect(await stateChange.port.validate(first.binding, new AbortController().signal)).toBe("stale");
    expect(await stateChange.port.validateForInstall?.(first.binding, new AbortController().signal)).toBe("current");

    const trustChange = fixture();
    const second = await trustChange.port.capture(new AbortController().signal);
    trustChange.setTrust("untrusted");
    expect(await trustChange.port.validate(second.binding, new AbortController().signal)).toBe("stale");

    const runtimeChange = fixture();
    const third = await runtimeChange.port.capture(new AbortController().signal);
    await runtimeChange.selections.replace([], runtimeChange.currentProject() as never);
    expect(await runtimeChange.port.validate(third.binding, new AbortController().signal)).toBe("stale");

    const updateChange = fixture();
    const fourth = await updateChange.port.capture(new AbortController().signal);
    updateChange.setUpdateState("degraded");
    expect(await updateChange.port.validate(fourth.binding, new AbortController().signal)).toBe("stale");
  });

  it("binds quarantined v3 records while preserving readable siblings", async () => {
    const value = fixture();
    value.setQuarantined(true);
    const snapshot = await value.port.capture(new AbortController().signal);
    expect(snapshot.binding.scopes[0]).toMatchObject({ status: "corrupt", corruptionCodes: ["RECORD_INVALID"] });
    expect(snapshot.binding.scopes[0]?.corruptionDigest).toMatch(/^sha256:/u);
    expect(snapshot.states[0]?.ok).toBe(true);
    expect(snapshot.runtime).toHaveLength(1);
  });

  it("consumes the catalog service's finalized publication corruption evidence", async () => {
    const value = fixture();
    value.setCatalogCache({ kind: "corrupt" });
    const snapshot = await value.port.capture(new AbortController().signal);
    expect(snapshot.binding.catalogs).toMatchObject([
      { scope: { kind: "user" }, cache: { kind: "corrupt" } },
      { scope: { kind: "project" }, cache: { kind: "corrupt" } },
    ]);
    expect(value.catalogSearch).toHaveBeenCalledTimes(2);
  });

  it("isolates publication capture per readable scope when one catalog adapter fails", async () => {
    const value = fixture();
    value.setCatalogFailure("user");
    const snapshot = await value.port.capture(new AbortController().signal);
    expect(snapshot.binding.catalogs).toMatchObject([
      { scope: { kind: "user" }, cache: { kind: "unavailable" } },
      { scope: { kind: "project" }, cache: { kind: "ready" } },
    ]);
    expect(value.catalogSearch.mock.calls.map(([request]) => request.scope)).toEqual(["user", "project"]);
    expect(JSON.stringify(snapshot.binding)).not.toContain("adapter failure");
    expect(JSON.stringify(snapshot.binding)).not.toContain("private/path");
  });

  it("turns thrown participant failures into fixed unavailable evidence without aborting capture", async () => {
    const value = fixture();
    value.skillHook.observe.mockRejectedValueOnce(new Error("skill native failure /private/skill"));
    value.mcp.status.mockRejectedValueOnce(new Error("mcp native failure credential-value"));
    const snapshot = await value.port.capture(new AbortController().signal);
    expect(snapshot.runtime[0]?.skillsHooks).toEqual({ kind: "unavailable", code: "ADAPTER_FAILED" });
    expect(snapshot.runtime[0]?.mcp.status).toEqual({ kind: "unavailable", code: "ADAPTER_FAILED" });
    expect(JSON.stringify(snapshot)).not.toContain("native failure");
    expect(JSON.stringify(snapshot)).not.toContain("credential-value");
  });

  it("does not make elapsed capture time stale by itself", async () => {
    const value = fixture();
    const snapshot = await value.port.capture(new AbortController().signal);
    value.setNow(200);
    expect(await value.port.validate(snapshot.binding, new AbortController().signal)).toBe("current");
  });
});
