import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProjectSyncService } from "../../src/application/project-sync-service.js";
import { createScopeContext, deriveProjectKey } from "../../src/domain/state/scope.js";
import { createProjectLocalStateDocument } from "../../src/domain/state/project-state.js";
import { createMarketplaceConfigurationRecord } from "../../src/domain/update-policy.js";
import { createInstalledPluginRecord, createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { encodeProjectIntentDeclaration } from "../../src/application/project-intent-codec.js";
import { createNativeInstalledHarness } from "../helpers/native-installed-inspection.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { capabilities } from "../fixtures/compatibility/common.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { toScopeReference } from "../../src/domain/state/scope.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const previewId = `native-operation-preview-v1:sha256:${"1".repeat(64)}` as never;

function fixture(configure?: (scope: any) => Readonly<{ records: readonly any[]; declaration: any }>) {
  const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/" as never, limitation: "identity-changes-with-canonical-root" as const };
  const scope = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
  if (scope.kind !== "project") throw new Error("project fixture failed");
  let snapshot: any = {
    scope,
    generation: 0,
    pointers: {},
    project: createProjectLocalStateDocument({ schemaVersion: 4, generation: 0, projectKey: scope.projectKey, identity: scope.identity, declarationDigest: `sha256:${"0".repeat(64)}`, scope: {}, marketplaces: [], plugins: [], marketplaceUpdates: [] }, scope, sha256),
    corruptions: [],
  };
  const configured = configure?.(scope);
  if (configured !== undefined) {
    snapshot = {
      ...snapshot,
      project: {
        ...snapshot.project,
        marketplaces: [],
        marketplaceUpdates: [createMarketplaceConfigurationRecord({ marketplace: "compatibility", source: { kind: "github", repository: "owner/market" }, origin: { kind: "native" } })],
        plugins: [...configured.records],
      },
    };
  }
  let declaration: any = configured?.declaration;
  let readinessTag = "4";
  let readinessMissing = false;
  let changeReadinessAfterWrite = false;
  let observation: any = Object.freeze({ publicId: `project-intent-observation-v1:sha256:${"2".repeat(64)}` });
  const replace = vi.fn(async (request: any) => {
    if (request.expected !== observation) return { kind: "stale" as const };
    declaration = request.declaration;
    observation = Object.freeze({ publicId: `project-intent-observation-v1:sha256:${"3".repeat(64)}` });
    if (changeReadinessAfterWrite) readinessTag = "9";
    return { kind: "written" as const, observation, digest: encodeProjectIntentDeclaration(declaration, sha256).digest };
  });
  const files = {
    async read() { return declaration === undefined ? { kind: "missing" as const, observation } : { kind: "found" as const, observation, declaration, digest: encodeProjectIntentDeclaration(declaration, sha256).digest }; },
    replace,
    async cleanup() {},
  };
  const state = { async read() { return { ok: true as const, snapshot }; }, async commit() { throw new Error("coordinator owns commit"); } };
  let ambiguousCommit = false;
  const mutations = {
    async runPreparedMutation(request: any, callback: any) {
      if (request.expectedGeneration !== snapshot.generation) return { kind: "stale-generation" as const, expected: request.expectedGeneration, actual: snapshot.generation };
      const prepared = await callback({ snapshot, assertOwned: async () => undefined });
      if (ambiguousCommit) { ambiguousCommit = false; return { kind: "commit-ambiguous" as const, expected: request.expectedGeneration }; }
      const generation = snapshot.generation + 1;
      snapshot = { ...snapshot, generation, project: { ...prepared.mutation.replace.project, generation } };
      return { kind: "committed" as const, value: prepared.value, snapshot };
    },
  };
  const root: any = Object.freeze({ kind: "trusted-project-root-v1", identity: scope.identity, projectKey: scope.projectKey, canonicalRoot: scope.identity.canonicalRoot });
  const lifecycle = {
    enable: vi.fn(), disable: vi.fn(), update: vi.fn(), install: vi.fn(),
    uninstall: vi.fn(async (request: any) => {
      const generation = snapshot.generation + 1;
      snapshot = { ...snapshot, generation, project: { ...snapshot.project, generation, plugins: snapshot.project.plugins.filter((entry: any) => entry.plugin !== request.plugin) } };
      return { kind: "changed" as const, operation: "uninstall" as const, snapshot, observation: { kind: "inactive" } };
    }),
  };
  const registrations = {
    remove: vi.fn(async () => {
      const generation = snapshot.generation + 1;
      snapshot = { ...snapshot, generation, project: { ...snapshot.project, generation, marketplaceUpdates: [] } };
      return { kind: "removed" as const };
    }),
  };
  const service = createProjectSyncService({
    state: state as any,
    mutations: mutations as any,
    projectRoots: { async acquire() { return root; }, verify() { return scope; }, async revalidate() { return scope; } },
    projectTrust: { async assess() { return { kind: "trusted" as const }; } },
    files,
    writeIds: { async create() { return `project-intent-write-v1:${"A".repeat(32)}` as never; } },
    lifecycle: lifecycle as any,
    registrations: registrations as any,
    configurationPathContext() { return { scope, trustedProjectRoot: root }; },
    async readiness() {
      return {
        capabilityDigest: `sha256:${readinessTag.repeat(64)}` as never,
        projectTrustFingerprint: `sha256:${"5".repeat(64)}` as never,
        plugins: snapshot.project.plugins.map((record: any) => ({
          plugin: record.plugin,
          trust: readinessMissing ? "missing" as const : "ready" as const,
          trustFingerprint: `sha256:${"6".repeat(64)}` as never,
          configuration: readinessMissing ? "missing" as const : "ready" as const,
          configurationRevision: null,
        })),
      };
    },
    sha256,
  });
  return {
    scope, service, replace, lifecycle, registrations,
    get snapshot() { return snapshot; },
    failNextCommit() { ambiguousCommit = true; },
    advance() {
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        project: { ...snapshot.project, generation: snapshot.generation + 1, declarationDigest: `sha256:${"e".repeat(64)}` },
      };
    },
    advanceUpdateEvidence() {
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        project: { ...snapshot.project, generation: snapshot.generation + 1, scope: { ...snapshot.project.scope, application: "automatic" } },
      };
    },
    changeReadiness() { readinessTag = "8"; },
    makeReadinessMissing() { readinessMissing = true; readinessTag = "8"; },
    changeReadinessAfterWrite() { changeReadinessAfterWrite = true; },
  };
}

function installedRecords(scope: any) {
  const base = createNativeInstalledHarness({ enabled: true }).plugin;
  const second = NormalizedPluginSchema.parse({
    ...base,
    identity: { ...base.identity, key: "second@compatibility", marketplaceEntryName: "second" },
  });
  const content = createContentManifest([], sha256);
  return [base, second].map((plugin) => {
    const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
    const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope: toScopeReference(scope) }, sha256);
    return createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "enabled", selectedRevision: revision.revision, revisions: [revision], scope: toScopeReference(scope) }, sha256);
  });
}

describe("project sync service", () => {
  it("publishes local intent then records its digest without prerequisite mutation", async () => {
    const value = fixture();
    const preview = await value.service.preview({ mode: "publish-intent", projectKey: value.scope.projectKey, previewId }, signal);
    expect(preview.kind).toBe("ready");
    if (preview.kind !== "ready") return;
    const result = await value.service.apply({ context: preview.context, resolutions: [] }, undefined, signal);
    expect(result).toMatchObject({ kind: "succeeded", operation: "project-sync", effects: { projectFile: "written" } });
    expect(value.replace).toHaveBeenCalledOnce();
    expect(value.snapshot.project.declarationDigest).toBe(result.kind === "succeeded" ? result.syncDigest : undefined);
    expect(value.lifecycle.enable).not.toHaveBeenCalled();
    expect(value.lifecycle.update).not.toHaveBeenCalled();
    expect(value.registrations.remove).not.toHaveBeenCalled();
  });

  it("rejects apply-intent with a missing file and performs no writes", async () => {
    const value = fixture();
    expect(await value.service.preview({ mode: "apply-intent", projectKey: value.scope.projectKey, previewId }, signal)).toEqual({ kind: "rejected", code: "PROJECT_INTENT_MISSING" });
    expect(value.replace).not.toHaveBeenCalled();
  });

  it("detects project intent authority replacement before the first file or state effect", async () => {
    const value = fixture();
    const preview = await value.service.preview({ mode: "publish-intent", projectKey: value.scope.projectKey, previewId }, signal);
    expect(preview.kind).toBe("ready");
    if (preview.kind !== "ready") return;
    value.advance();
    const result = await value.service.apply({ context: preview.context, resolutions: [] }, undefined, signal);
    expect(result).toMatchObject({ kind: "conflict", reason: "state-generation-changed", effects: { state: "unchanged" } });
    expect(value.replace).not.toHaveBeenCalled();
  });

  it("rebases update-only project evidence and preserves it through intent finalization", async () => {
    const value = fixture();
    const preview = await value.service.preview({ mode: "publish-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (preview.kind !== "ready") throw new Error("preview fixture failed");
    value.advanceUpdateEvidence();
    const result = await value.service.apply({ context: preview.context, resolutions: [] }, undefined, signal);
    expect(result).toMatchObject({ kind: "succeeded", effects: { projectFile: "written" } });
    expect(value.snapshot.project.scope.application).toBe("automatic");
  });

  it("binds exact readiness before the first effect", async () => {
    const value = fixture();
    const preview = await value.service.preview({ mode: "publish-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (preview.kind !== "ready") throw new Error("preview fixture failed");
    value.changeReadiness();
    const result = await value.service.apply({ context: preview.context, resolutions: [] }, undefined, signal);
    expect(result).toMatchObject({ kind: "stale", reason: "capability", effects: { state: "unchanged", projectFile: "unchanged" } });
    expect(value.replace).not.toHaveBeenCalled();
    expect(value.snapshot.project.declarationDigest).toBe(`sha256:${"0".repeat(64)}`);
  });

  it("revalidates readiness immediately before digest commit and reports truthful file effects", async () => {
    const value = fixture();
    const preview = await value.service.preview({ mode: "publish-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (preview.kind !== "ready") throw new Error("preview fixture failed");
    value.changeReadinessAfterWrite();
    const result = await value.service.apply({ context: preview.context, resolutions: [] }, undefined, signal);
    expect(result).toMatchObject({ kind: "stale", reason: "capability", effects: { state: "partially-changed", projectFile: "written" } });
    expect(value.snapshot.project.declarationDigest).toBe(`sha256:${"0".repeat(64)}`);
  });

  it("retries a crash after file publication as digest-only convergence", async () => {
    const value = fixture();
    const first = await value.service.preview({ mode: "publish-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (first.kind !== "ready") throw new Error("preview fixture failed");
    value.failNextCommit();
    expect(await value.service.apply({ context: first.context, resolutions: [] }, undefined, signal)).toMatchObject({ kind: "recovery-required", effects: { projectFile: "written" } });
    expect(value.snapshot.project.declarationDigest).toBe(`sha256:${"0".repeat(64)}`);
    const retry = await value.service.preview({ mode: "publish-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (retry.kind !== "ready") throw new Error("retry preview fixture failed");
    expect(retry.plan.actions.map((action) => action.kind)).toEqual(["record-intent-digest"]);
    expect(await value.service.apply({ context: retry.context, resolutions: [] }, undefined, signal)).toMatchObject({ kind: "succeeded" });
    expect(value.replace).toHaveBeenCalledTimes(1);
  });

  it("spends one reload action per apply and converges a two-plugin plan by deterministic re-preview", async () => {
    const desired = { schemaVersion: 1 as const, marketplaces: [], plugins: [] };
    const value = fixture((scope) => ({ records: installedRecords(scope), declaration: desired }));
    const first = await value.service.preview({ mode: "apply-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (first.kind !== "ready") throw new Error("multi-action preview failed");
    expect(first.plan.actions.map((action) => action.kind)).toEqual(["uninstall-plugin", "uninstall-plugin", "remove-marketplace", "record-intent-digest"]);
    const partial = await value.service.apply({ context: first.context, resolutions: [] }, undefined, signal);
    expect(partial).toMatchObject({ kind: "needs-action", actions: [{ kind: "repreview-sync", action: "retry-read" }], effects: { state: "partially-changed" } });
    expect(value.lifecycle.uninstall).toHaveBeenCalledTimes(1);
    expect(value.snapshot.project.declarationDigest).toBe(`sha256:${"0".repeat(64)}`);

    const second = await value.service.preview({ mode: "apply-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (second.kind !== "ready") throw new Error("multi-action retry preview failed");
    const secondPartial = await value.service.apply({ context: second.context, resolutions: [] }, undefined, signal);
    expect(secondPartial).toMatchObject({ kind: "needs-action", actions: [{ kind: "repreview-sync" }], effects: { state: "partially-changed" } });
    expect(value.lifecycle.uninstall).toHaveBeenCalledTimes(2);
    expect(value.snapshot.project.declarationDigest).toBe(`sha256:${"0".repeat(64)}`);

    const third = await value.service.preview({ mode: "apply-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (third.kind !== "ready") throw new Error("multi-action final preview failed");
    const converged = await value.service.apply({ context: third.context, resolutions: [] }, undefined, signal);
    expect(converged).toMatchObject({ kind: "succeeded", effects: { state: "changed" } });
    expect(value.registrations.remove).toHaveBeenCalledOnce();
    expect(value.snapshot.project.plugins).toEqual([]);
    expect(value.snapshot.project.declarationDigest).toBe(encodeProjectIntentDeclaration(desired, sha256).digest);
  });

  it("turns readiness changes after one reload into required actions with the baseline unchanged", async () => {
    const value = fixture((scope) => {
      const records = installedRecords(scope);
      return {
        records,
        declaration: {
          schemaVersion: 1 as const,
          marketplaces: [{ marketplace: "compatibility", source: { kind: "github" as const, repository: "owner/market" } }],
          plugins: [{ plugin: records[1]!.plugin, enabled: true }],
        },
      };
    });
    const first = await value.service.preview({ mode: "apply-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (first.kind !== "ready") throw new Error("readiness race preview failed");
    expect(await value.service.apply({ context: first.context, resolutions: [] }, undefined, signal)).toMatchObject({ kind: "needs-action", actions: [{ kind: "repreview-sync" }] });
    value.makeReadinessMissing();
    const second = await value.service.preview({ mode: "apply-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (second.kind !== "ready") throw new Error("readiness race retry preview failed");
    expect(second.plan.actions).toEqual([]);
    expect(second.plan.requiredActions.map((action) => action.kind).sort()).toEqual(["provide-configuration", "review-trust"]);
    expect(value.snapshot.project.declarationDigest).toBe(`sha256:${"0".repeat(64)}`);
  });

  it("rejects replay of an already-consumed execution context", async () => {
    const value = fixture();
    const preview = await value.service.preview({ mode: "publish-intent", projectKey: value.scope.projectKey, previewId }, signal);
    if (preview.kind !== "ready") throw new Error("preview fixture failed");
    await value.service.apply({ context: preview.context, resolutions: [] }, undefined, signal);
    expect(await value.service.apply({ context: preview.context, resolutions: [] }, undefined, signal)).toMatchObject({ kind: "stale", reason: "session" });
  });
});
