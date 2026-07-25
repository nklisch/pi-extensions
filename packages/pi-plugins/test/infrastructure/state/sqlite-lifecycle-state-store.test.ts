import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseStateMutation } from "../../../src/application/state-contract.js";
import { createPluginHostPathPlan } from "../../../src/composition/plugin-host-paths.js";
import { createScopeContext, deriveProjectKey, type ProjectIdentity } from "../../../src/domain/state/scope.js";
import { createNodeLifecycleStateAdapters } from "../../../src/infrastructure/state/sqlite-lifecycle-state-store.js";

const roots: string[] = [];
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plugin-host-state-"));
  roots.push(root);
  const identity: ProjectIdentity = {
    kind: "path-only",
    canonicalRoot: pathToFileURL(root).href as never,
    limitation: "identity-changes-with-canonical-root",
  };
  const project = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
  if (project.kind !== "project") throw new Error("project fixture failed");
  const paths = createPluginHostPathPlan(root);
  const adapters = await createNodeLifecycleStateAdapters({
    paths,
    currentProject: project,
    sha256,
    verifyLocalFilesystem: async () => {},
  });
  return { root, paths, project, adapters };
}

describe("SQLite lifecycle state store", () => {
  it("creates exact current-schema generation-zero user and project snapshots", async () => {
    const { project, adapters } = await fixture();
    const signal = new AbortController().signal;
    const user = await adapters.state.read({ kind: "user" }, signal);
    const local = await adapters.state.read(project, signal);
    expect(user).toMatchObject({ ok: true, snapshot: { generation: 0, config: { schemaVersion: 4 }, installed: { schemaVersion: 2 }, trust: { schemaVersion: 1 } } });
    expect(local).toMatchObject({ ok: true, snapshot: { generation: 0, project: { schemaVersion: 4, projectKey: project.projectKey, marketplaces: [], plugins: [] } } });
    expect(JSON.stringify(local)).not.toContain("plugins.json");
    const inventory = await adapters.inventory.discover(signal);
    expect(inventory).toEqual({ scopes: [{ kind: "user" }, project], complete: true });
    await adapters.close();
    await adapters.close();
  });

  it("performs final generation CAS and retains one complete prior generation", async () => {
    const { paths, adapters } = await fixture();
    const signal = new AbortController().signal;
    const mutation = parseStateMutation({
      scope: { kind: "user" },
      expectedGeneration: 0,
      replace: { config: { schemaVersion: 4, generation: 0, records: [] } },
    }, sha256);
    const [first, second] = await Promise.all([
      adapters.state.commit(mutation, signal),
      adapters.state.commit(mutation, signal),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["committed", "stale-generation"]);
    await adapters.close();
    const database = new DatabaseSync(paths.stateDatabase({ kind: "user" }), { readOnly: true });
    expect(database.prepare("SELECT generation FROM generation_pointers ORDER BY generation").all()).toEqual([
      { generation: 0 }, { generation: 1 },
    ]);
    database.close();
  });

  it("reinitializes the scope for a stale pointer version without reporting corruption", async () => {
    const { paths, project, adapters } = await fixture();
    await adapters.close();
    const database = new DatabaseSync(paths.stateDatabase({ kind: "user" }));
    database.prepare("UPDATE current_pointer SET pointer_json = ? WHERE singleton = 1").run('{"schemaVersion":99}');
    database.close();
    const reopened = await createNodeLifecycleStateAdapters({
      paths,
      currentProject: project,
      sha256,
      verifyLocalFilesystem: async () => {},
    });
    // A stale pointer version is a clean cut-over: the scope is reinitialized
    // to fresh generation-zero defaults instead of degrading as corruption.
    const cutover = await reopened.state.read({ kind: "user" }, new AbortController().signal);
    expect(cutover).toMatchObject({
      ok: true,
      snapshot: {
        generation: 0,
        config: { schemaVersion: 4, records: [] },
        installed: { schemaVersion: 2, marketplaces: [], plugins: [] },
        trust: { schemaVersion: 1, records: [] },
        corruptions: [],
      },
    });
    await expect(reopened.state.read(project, new AbortController().signal)).resolves.toMatchObject({ ok: true });
    const verify = new DatabaseSync(paths.stateDatabase({ kind: "user" }), { readOnly: true });
    expect(verify.prepare("SELECT generation, pointer_json FROM current_pointer WHERE singleton = 1").get()).toMatchObject({ generation: 0 });
    expect((verify.prepare("SELECT pointer_json FROM current_pointer WHERE singleton = 1").get() as { pointer_json: string }).pointer_json)
      .not.toBe('{"schemaVersion":99}');
    verify.close();
    await reopened.close();
  });
});
