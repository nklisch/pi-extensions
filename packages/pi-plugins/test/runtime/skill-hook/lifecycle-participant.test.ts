import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInactiveProjectionExpectation, createActiveProjectionExpectation, createPluginRuntimeProjection } from "../../../src/application/ports/runtime-projection.js";
import { createSkillHookRuntimeParticipant } from "../../../src/runtime/skill-hook/lifecycle-participant.js";
import { createSkillHookSnapshotLoader, type SkillHookSnapshotResult } from "../../../src/runtime/skill-hook/runtime-snapshot.js";
import { CompatibilityReportSchema } from "../../../src/domain/compatibility.js";
import { createContentManifest } from "../../../src/domain/content-manifest.js";
import { createPluginStoreIdentityFromEvidence } from "../../../src/domain/content-store.js";
import { NormalizedPluginSchema } from "../../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../../src/domain/state/installed-state.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

function setup() {
  const source = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "d".repeat(40), path: "./plugin" }, sha256);
  const plugin = NormalizedPluginSchema.parse({ identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" }, source, configuration: { options: [] }, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, metadata: [] });
  const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
  const content = createContentManifest([], sha256);
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope: { kind: "user" } }, sha256);
  const projection = createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision, sha256 });
  const expectation = createActiveProjectionExpectation(projection, sha256);
  const storeIdentity = createPluginStoreIdentityFromEvidence({ sourceHash: revision.evidence.source.sourceHash, binding: revision.revision }, sha256);
  const loader = createSkillHookSnapshotLoader({
    content: {
      async resolvePlugin() { return { kind: "plugin", root: "/content", identity: storeIdentity, manifest: content, contentRef: revision.contentRef }; },
      async ensureDataRoot(input) { return { root: "/data", scope: input.scope, plugin: input.plugin, dataRef: input.dataRef }; },
    },
    projectRoots: { async acquire() { throw new Error("current project unavailable"); }, verify() { throw new Error("not used"); } },
    projectTrust: { async assess() { return { kind: "trusted" as const }; } }, sha256,
  });
  // The participant test uses a prebuilt snapshot to isolate atomic catalog
  // behavior from the loader's adapter tests.
  const project = { identity: { kind: "path-only", canonicalRoot: "file:///workspace/", limitation: "identity-changes-with-canonical-root" }, projectKey: `project-v1:sha256:${"1".repeat(64)}`, trust: { kind: "trusted" as const } } as never;
  const snapshot = { schemaVersion: 1 as const, scope: { kind: "user" as const }, plugin: projection.plugin, revision: projection.revision, projectionDigest: projection.digest, projectionRef: expectation.projectionRef, currentProject: project, content: { kind: "plugin" as const, root: "/content", identity: storeIdentity, manifest: content, contentRef: revision.contentRef }, data: { root: "/data", scope: { kind: "user" as const }, plugin: projection.plugin, dataRef: revision.dataRef }, skills: [], hooks: [], contributionDigest: `sha256:${"2".repeat(64)}` };
  let loadResult: SkillHookSnapshotResult = { kind: "ready", snapshot };
  const participant = createSkillHookRuntimeParticipant({ loader: { async load() { return loadResult; } }, sha256 });
  return { participant, expectation, plugin: projection.plugin, loader, revision, snapshot, currentProject: project, setLoadResult(value: SkillHookSnapshotResult) { loadResult = value; } }; 
}

describe("skill/hook lifecycle participant", () => {
  it("atomically publishes, observes exact active ids, then proves inactive absence", async () => {
    const { participant, expectation, plugin, revision, currentProject } = setup();
    expect(await participant.participant.observe(expectation, signal)).toMatchObject({ kind: "failed", code: "CATALOG_UNINITIALIZED" });
    expect(await participant.participant.reconcile({ active: [{ prepared: { expectation, projection: expectation.projection, payloadDigest: `sha256:${"3".repeat(64)}` }, revision }], currentProject }, signal)).toMatchObject({ kind: "applied", count: 1 });
    const active = await participant.participant.observe(expectation, signal);
    expect(active).toMatchObject({ kind: "ready", observation: { kind: "active", participant: "skills-hooks-snapshot", skillComponentIds: [], hookComponentIds: [] } });
    expect(await participant.participant.reconcile({ active: [], currentProject }, signal)).toEqual({ kind: "applied", count: 0 });
    const inactive = await participant.participant.observe(createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin, sha256 }), signal);
    expect(inactive).toMatchObject({ kind: "ready", observation: { kind: "inactive", projectionDigest: expect.any(String) } });
  });

  it("rejects target collisions before changing the catalog", async () => {
    const { participant, expectation, revision, currentProject } = setup();
    const selection = { prepared: { expectation, projection: expectation.projection, payloadDigest: `sha256:${"3".repeat(64)}` }, revision };
    expect(await participant.participant.reconcile({ active: [selection, selection], currentProject }, signal)).toEqual({ kind: "failed", code: "TARGET_COLLISION" });
    expect(participant.catalog.list()).toEqual([]);
  });

  it("preserves the previously published catalog when a later snapshot fails", async () => {
    const value = setup();
    const selection = { prepared: { expectation: value.expectation, projection: value.expectation.projection, payloadDigest: `sha256:${"3".repeat(64)}` }, revision: value.revision };
    expect(await value.participant.participant.reconcile({ active: [selection], currentProject: value.currentProject }, signal)).toMatchObject({ kind: "applied" });
    const previous = value.participant.catalog.list();
    value.setLoadResult({ kind: "failed", code: "CONTENT_UNAVAILABLE" });
    expect(await value.participant.participant.reconcile({ active: [selection], currentProject: value.currentProject }, signal)).toEqual({ kind: "failed", code: "SNAPSHOT_FAILED" });
    expect(value.participant.catalog.list()).toBe(previous);
  });

  it("cancels before the synchronous swap and retains the previous catalog", async () => {
    const value = setup();
    const selection = { prepared: { expectation: value.expectation, projection: value.expectation.projection, payloadDigest: `sha256:${"3".repeat(64)}` }, revision: value.revision };
    let cancel = false;
    const controller = new AbortController();
    const cancelling = createSkillHookRuntimeParticipant({
      loader: { async load() { if (cancel) controller.abort(); return { kind: "ready" as const, snapshot: value.snapshot }; } },
      sha256,
    });
    expect(await cancelling.participant.reconcile({ active: [selection], currentProject: value.currentProject }, signal)).toMatchObject({ kind: "applied" });
    const previous = cancelling.catalog.list();
    cancel = true;
    expect(await cancelling.participant.reconcile({ active: [selection], currentProject: value.currentProject }, controller.signal)).toEqual({ kind: "cancelled" });
    expect(cancelling.catalog.list()).toBe(previous);
  });

  it("rejects wrong snapshot bindings and exact observation mismatches", async () => {
    const value = setup();
    const selection = { prepared: { expectation: value.expectation, projection: value.expectation.projection, payloadDigest: `sha256:${"3".repeat(64)}` }, revision: value.revision };
    value.setLoadResult({ kind: "ready", snapshot: { ...value.snapshot, revision: `sha256:${"e".repeat(64)}` as typeof value.snapshot.revision } });
    expect(await value.participant.participant.reconcile({ active: [selection], currentProject: value.currentProject }, signal)).toEqual({ kind: "failed", code: "SNAPSHOT_FAILED" });

    value.setLoadResult({ kind: "ready", snapshot: value.snapshot });
    expect(await value.participant.participant.reconcile({ active: [selection], currentProject: value.currentProject }, signal)).toMatchObject({ kind: "applied" });
    const wrongs = [
      { ...value.expectation, projection: { ...value.expectation.projection, plugin: "other@community" as typeof value.expectation.projection.plugin } },
      { ...value.expectation, projection: { ...value.expectation.projection, revision: `sha256:${"e".repeat(64)}` as typeof value.expectation.projection.revision } },
      { ...value.expectation, projection: { ...value.expectation.projection, digest: `sha256:${"f".repeat(64)}` as typeof value.expectation.projection.digest } },
      createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: value.plugin, sha256 }),
    ];
    for (const wrong of wrongs) expect(await value.participant.participant.observe(wrong, signal)).toMatchObject({ kind: "failed", code: "OBSERVATION_MISMATCH" });
  });

  it("rejects project-untrusted snapshots before they can become observation evidence", async () => {
    const value = setup();
    const projectKey = `project-v1:sha256:${"1".repeat(64)}`;
    const projectSnapshot = { ...value.snapshot, scope: { kind: "project" as const, projectKey }, currentProject: { ...value.snapshot.currentProject, projectKey, trust: { kind: "untrusted" as const } } };
    const projectExpectation = { ...value.expectation, projection: { ...value.expectation.projection, scope: { kind: "project" as const, projectKey } } };
    value.setLoadResult({ kind: "ready", snapshot: projectSnapshot });
    expect(await value.participant.participant.reconcile({ active: [{ prepared: { expectation: projectExpectation, projection: projectExpectation.projection, payloadDigest: `sha256:${"3".repeat(64)}` }, revision: value.revision }], currentProject: value.currentProject }, signal)).toEqual({ kind: "failed", code: "SNAPSHOT_FAILED" });
  });
});