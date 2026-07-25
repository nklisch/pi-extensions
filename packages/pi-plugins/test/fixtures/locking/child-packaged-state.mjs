import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPluginHostPathPlan } from "../../../src/composition/plugin-host-paths.js";
import { createScopeContext, deriveProjectKey } from "../../../src/domain/state/scope.js";
import { parseStateMutation } from "../../../src/application/state-contract.js";
import { createNodeLifecycleStateAdapters } from "../../../src/infrastructure/state/sqlite-lifecycle-state-store.js";

const [agentDir, projectRoot, mode = "once", rawCount = "1"] = process.argv.slice(2);
const count = Number(rawCount);
const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = {
  kind: "path-only",
  canonicalRoot: pathToFileURL(projectRoot).href,
  limitation: "identity-changes-with-canonical-root",
};
const currentProject = createScopeContext({
  kind: "project",
  identity,
  projectKey: deriveProjectKey(identity, sha256),
}, sha256);
const adapters = await createNodeLifecycleStateAdapters({
  paths: createPluginHostPathPlan(agentDir),
  currentProject,
  sha256,
  verifyLocalFilesystem: async () => {},
});
try {
  if (mode === "reader") {
    let previous = 0;
    for (let index = 0; index < count; index += 1) {
      const loaded = await adapters.state.read({ kind: "user" }, new AbortController().signal);
      if (!loaded.ok || loaded.snapshot.generation < previous ||
          loaded.snapshot.config.generation !== loaded.snapshot.generation ||
          loaded.snapshot.installed.generation !== loaded.snapshot.generation ||
          loaded.snapshot.trust.generation !== loaded.snapshot.generation) {
        throw new Error("reader observed a partial lifecycle generation");
      }
      previous = loaded.snapshot.generation;
      await new Promise((resolve) => setImmediate(resolve));
    }
    process.stdout.write(`${JSON.stringify({ kind: "reader", generation: previous })}\n`);
  } else if (mode === "writer") {
    let committed = 0;
    while (committed < count) {
      const loaded = await adapters.state.read({ kind: "user" }, new AbortController().signal);
      if (!loaded.ok) throw new Error("writer could not read authority");
      const mutation = parseStateMutation({
        scope: { kind: "user" },
        expectedGeneration: loaded.snapshot.generation,
        replace: { config: { schemaVersion: 4, generation: loaded.snapshot.generation, records: [] } },
      }, sha256);
      const result = await adapters.state.commit(mutation, new AbortController().signal);
      if (result.kind === "committed") committed += 1;
    }
    process.stdout.write(`${JSON.stringify({ kind: "writer", committed })}\n`);
  } else {
    const mutation = parseStateMutation({
      scope: { kind: "user" },
      expectedGeneration: 0,
      replace: { config: { schemaVersion: 4, generation: 0, records: [] } },
    }, sha256);
    const result = await adapters.state.commit(mutation, new AbortController().signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  await adapters.close();
}
