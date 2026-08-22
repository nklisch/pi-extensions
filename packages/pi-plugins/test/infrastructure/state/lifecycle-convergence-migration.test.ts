import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseStateMutation } from "../../../src/application/state-contract.js";
import { createContentManifest, hashContent, hashStateDocument } from "../../../src/index.js";
import { createInstalledPluginRecord, createInstalledUserStateDocument, createMarketplaceSnapshotRecord } from "../../../src/domain/state/installed-state.js";
import { CompatibilityReportSchema } from "../../../src/domain/compatibility.js";
import { NormalizedPluginSchema } from "../../../src/domain/plugin.js";
import { claim } from "../../../src/domain/provenance.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../../src/domain/source.js";
import { deriveStateBlobRef } from "../../../src/domain/state/references.js";
import { createNodeLifecycleStateAdapters } from "../../../src/infrastructure/state/sqlite-lifecycle-state-store.js";
import { createPluginHostPathPlan } from "../../../src/composition/plugin-host-paths.js";
import { createScopeContext, deriveProjectKey, type ProjectIdentity } from "../../../src/domain/state/scope.js";
import { runLifecycleConvergenceMigration } from "../../../src/infrastructure/state/lifecycle-convergence-migration.js";

const roots: string[] = [];
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-migration-"));
  roots.push(root);
  const stateRoot = join(root, "plugin-host", "state", "v1");
  const hostRoot = join(root, "plugin-host");
  await mkdir(stateRoot, { recursive: true });
  return { root, stateRoot, hostRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("lifecycle convergence migration", () => {
  it("strips pending markers through the codec and advances a scope once", async () => {
    const { root, stateRoot, hostRoot } = await fixture();
    const paths = createPluginHostPathPlan(root);
    const identity: ProjectIdentity = {
      kind: "path-only",
      canonicalRoot: pathToFileURL(root).href as never,
      limitation: "identity-changes-with-canonical-root",
    };
    const project = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
    if (project.kind !== "project") throw new Error("project fixture failed");
    const adapters = await createNodeLifecycleStateAdapters({ paths, currentProject: project, sha256, verifyLocalFilesystem: async () => {} });
    const content = createContentManifest([{ kind: "file", path: "README.md", mode: 0o644, size: 7, digest: hashContent(new TextEncoder().encode("content"), sha256) }], sha256);
    const plugin = NormalizedPluginSchema.parse({
      identity: { key: "demo@community", marketplaceName: "community", marketplaceEntryName: "demo" },
      version: claim("1.0.0", { location: { host: "claude", documentKind: "manifest", path: "plugin.json", pointer: "" } }),
      source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/demo.git", revision: "a".repeat(40) }, sha256),
      configuration: { options: [] },
      components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
      metadata: [],
    });
    const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
    const marketplace = createMarketplaceSnapshotRecord({
      marketplace: "community",
      source: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/marketplace" }, revision: "b".repeat(40) }, sha256),
      content,
    }, sha256);
    const record = createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "enabled", revisions: [{ plugin, compatibility, content }], scope: { kind: "user" } }, sha256);
    const loaded = await adapters.state.read({ kind: "user" }, new AbortController().signal);
    if (!loaded.ok || !("installed" in loaded.snapshot)) throw new Error("user state fixture failed");
    const installed = createInstalledUserStateDocument({ ...loaded.snapshot.installed, marketplaces: [marketplace], plugins: [record] }, sha256);
    const committed = await adapters.state.commit(parseStateMutation({ scope: { kind: "user" }, expectedGeneration: loaded.snapshot.generation, replace: { installed } }, sha256), new AbortController().signal);
    if (committed.kind !== "committed") throw new Error("state fixture commit failed");
    await adapters.close();

    const database = new DatabaseSync(paths.stateDatabase({ kind: "user" }));
    const current = database.prepare("SELECT generation, pointer_json FROM current_pointer WHERE singleton = 1").get() as { generation: number; pointer_json: string };
    const pointer = JSON.parse(current.pointer_json) as { documents: Array<{ kind: string; blob: string; digest: string; generation: number }> };
    const selected = pointer.documents.find((entry) => entry.kind === "installedUser")!;
    const row = database.prepare("SELECT document FROM state_blobs WHERE blob_ref = ?").get(selected.blob) as { document: string };
    const raw = JSON.parse(row.document) as { plugins: Array<Record<string, unknown>> };
    raw.plugins[0]!.pendingTransition = `pending-transition-v1:sha256:${"d".repeat(64)}`;
    const digest = hashStateDocument(raw as never, sha256);
    const blob = deriveStateBlobRef({ scope: { kind: "user" }, generation: current.generation, kind: "installedUser", digest }, sha256);
    database.prepare("UPDATE state_blobs SET blob_ref = ?, digest = ?, document = ? WHERE blob_ref = ?").run(blob, digest, JSON.stringify(raw), selected.blob);
    pointer.documents = pointer.documents.map((entry) => entry.kind === "installedUser" ? { ...entry, blob, digest } : entry);
    database.prepare("UPDATE current_pointer SET pointer_json = ? WHERE singleton = 1").run(JSON.stringify({ ...JSON.parse(current.pointer_json), documents: pointer.documents }));
    database.close();

    const options = { stateRoot, hostRoot, stateDatabase: paths.stateDatabase, sha256 };
    const first = await runLifecycleConvergenceMigration(options);
    expect(first.scopes).toEqual(expect.arrayContaining([expect.objectContaining({ scope: { kind: "user" }, changed: true, deferred: false })]));
    const migrated = new DatabaseSync(paths.stateDatabase({ kind: "user" }), { readOnly: true });
    expect(migrated.prepare("SELECT generation FROM current_pointer WHERE singleton = 1").get()).toEqual({ generation: current.generation + 1 });
    migrated.close();
    const reopened = await createNodeLifecycleStateAdapters({ paths, currentProject: project, sha256, verifyLocalFilesystem: async () => {} });
    const verified = await reopened.state.read({ kind: "user" }, new AbortController().signal);
    expect(verified).toMatchObject({ ok: true, snapshot: { generation: current.generation + 1, installed: { plugins: [{ plugin: "demo@community" }] } } });
    if (verified.ok) expect(verified.snapshot.installed.plugins[0]).not.toHaveProperty("pendingTransition");
    await reopened.close();
    const second = await runLifecycleConvergenceMigration(options);
    expect(second.scopes).toContainEqual(expect.objectContaining({ scope: { kind: "user" }, changed: false, deferred: false }));

  });

  it("defers a corrupt legacy scope without wiping it from post-migration reads", async () => {
    const { root, stateRoot, hostRoot } = await fixture();
    const paths = createPluginHostPathPlan(root);
    const identity: ProjectIdentity = {
      kind: "path-only",
      canonicalRoot: pathToFileURL(root).href as never,
      limitation: "identity-changes-with-canonical-root",
    };
    const project = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
    if (project.kind !== "project") throw new Error("project fixture failed");
    const adapters = await createNodeLifecycleStateAdapters({ paths, currentProject: project, sha256, verifyLocalFilesystem: async () => {} });
    await adapters.close();

    const database = new DatabaseSync(paths.stateDatabase({ kind: "user" }));
    const current = database.prepare("SELECT generation, pointer_json FROM current_pointer WHERE singleton = 1").get() as { generation: number; pointer_json: string };
    const pointer = JSON.parse(current.pointer_json) as { documents: Array<{ kind: string; blob: string; digest: string; generation: number }> };
    const selected = pointer.documents.find((entry) => entry.kind === "installedUser")!;
    const row = database.prepare("SELECT document FROM state_blobs WHERE blob_ref = ?").get(selected.blob) as { document: string };
    const raw = JSON.parse(row.document) as { plugins: Array<Record<string, unknown>> };
    raw.generation = current.generation + 1;
    raw.plugins.push({
      plugin: "demo@community",
      activation: "enabled",
      selectedRevision: `sha256:${"0".repeat(64)}`,
      revisions: [],
      pendingTransition: `pending-transition-v1:sha256:${"d".repeat(64)}`,
    });
    const digest = hashStateDocument(raw as never, sha256);
    const blob = deriveStateBlobRef({ scope: { kind: "user" }, generation: current.generation, kind: "installedUser", digest }, sha256);
    database.prepare("UPDATE state_blobs SET blob_ref = ?, digest = ?, document = ? WHERE blob_ref = ?").run(blob, digest, JSON.stringify(raw), selected.blob);
    pointer.documents = pointer.documents.map((entry) => entry.kind === "installedUser" ? { ...entry, blob, digest } : entry);
    database.prepare("UPDATE current_pointer SET pointer_json = ? WHERE singleton = 1").run(JSON.stringify({ ...JSON.parse(current.pointer_json), documents: pointer.documents }));
    database.close();

    const options = { stateRoot, hostRoot, stateDatabase: paths.stateDatabase, sha256 };
    const migration = await runLifecycleConvergenceMigration(options);
    expect(migration.deferred).toBe(true);
    expect(migration.scopes).toContainEqual(expect.objectContaining({ scope: { kind: "user" }, changed: false, deferred: true }));
    const untouched = new DatabaseSync(paths.stateDatabase({ kind: "user" }), { readOnly: true });
    expect(untouched.prepare("SELECT generation FROM current_pointer WHERE singleton = 1").get()).toEqual({ generation: current.generation });
    const untouchedBlob = untouched.prepare("SELECT document FROM state_blobs WHERE blob_ref = ?").get(blob) as { document: string };
    expect(JSON.parse(untouchedBlob.document).plugins[0]).toHaveProperty("pendingTransition");
    untouched.close();

    const reopened = await createNodeLifecycleStateAdapters({ paths, currentProject: project, sha256, verifyLocalFilesystem: async () => {} });
    const read = await reopened.state.read({ kind: "user" }, new AbortController().signal);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.corruptions.length).toBeGreaterThan(0);
    await reopened.close();
  });

  it("harvests completed pending deletes before dropping legacy databases", async () => {
    const { stateRoot, hostRoot } = await fixture();
    const journalRoot = join(hostRoot, "recovery", "journal", "v1");
    const legacy = [join(hostRoot, "recovery", "leases", "v1"), join(hostRoot, "recovery", "retention", "v1"), join(hostRoot, "locks", "v1")];
    await Promise.all([journalRoot, ...legacy].map((directory) => mkdir(directory, { recursive: true })));
    const journalPath = join(journalRoot, "user.sqlite");
    const database = new DatabaseSync(journalPath);
    database.exec("CREATE TABLE lifecycle_transitions (reference TEXT, record_json TEXT, status TEXT, cleanup_status TEXT, status_at INTEGER)");
    const dataRef = `plugin-data-v1:sha256:${"b".repeat(64)}`;
    database.prepare("INSERT INTO lifecycle_transitions VALUES (?, ?, 'completed', 'pending-data-delete', ?)").run(
      "pending-transition-v1:sha256:" + "c".repeat(64),
      JSON.stringify({ scope: { kind: "user" }, plugin: "demo@local", previous: { selectedRevision: "sha256:" + "a".repeat(64), revisions: [{ revision: "sha256:" + "a".repeat(64), dataRef }] } }),
      1234,
    );
    database.close();
    await writeFile(join(hostRoot, "staging.owner"), "owner");
    await writeFile(join(hostRoot, ".identity"), "identity");
    for (const directory of legacy) await writeFile(join(directory, "old.sqlite"), "legacy");

    const options = {
      stateRoot,
      hostRoot,
      stateDatabase: (scope: { kind: "user" } | { kind: "project"; projectKey: string }) => join(stateRoot, scope.kind === "user" ? "user.sqlite" : "project.sqlite"),
      sha256,
    };
    const first = await runLifecycleConvergenceMigration(options);
    expect(first.harvestedMarkers).toBe(1);
    expect(first.deferred).toBe(false);
    await expect(readdir(journalRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(hostRoot, "cleanup", "v1", "pending-deletes"))).toHaveLength(1);
    const markerName = (await readdir(join(hostRoot, "cleanup", "v1", "pending-deletes")))[0]!;
    expect(JSON.parse(await readFile(join(hostRoot, "cleanup", "v1", "pending-deletes", markerName), "utf8"))).toMatchObject({ requestedAt: 1234, plugin: "demo@local", dataRef });
    await expect(readdir(join(hostRoot, "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(hostRoot, "locks", "v1"))).rejects.toMatchObject({ code: "ENOENT" });

    const second = await runLifecycleConvergenceMigration(options);
    expect(second.harvestedMarkers).toBe(0);
    expect(second.deletedLegacyDatabases).toBe(0);
    expect(second.deferred).toBe(false);
  });
});
