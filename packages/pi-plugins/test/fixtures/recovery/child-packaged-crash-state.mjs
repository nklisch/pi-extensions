import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPluginHostPathPlan } from "../../../src/composition/plugin-host-paths.js";
import { createNodeLifecycleStateAdapters } from "../../../src/infrastructure/state/sqlite-lifecycle-state-store.js";
import { createNodeRecoveryAdapters } from "../../../src/infrastructure/recovery/create-node-recovery-adapters.js";
import { createScopeContext, deriveProjectKey } from "../../../src/domain/state/scope.js";
import { createContentManifest } from "../../../src/domain/content-manifest.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../../src/domain/source.js";
import { NormalizedPluginSchema } from "../../../src/domain/plugin.js";
import { evaluateCompatibility } from "../../../src/domain/compatibility-evaluator.js";
import { capabilities } from "../../fixtures/compatibility/common.js";
import { createInstalledPluginRecord, createInstalledRevisionRecord, createInstalledUserStateDocument, createMarketplaceSnapshotRecord, InstalledPluginRecordSchema } from "../../../src/domain/state/installed-state.js";
import { createActiveProjectionExpectation, createInactiveProjectionExpectation, createPluginRuntimeProjection } from "../../../src/application/ports/runtime-projection.js";
import { createLifecycleTransitionRecord } from "../../../src/application/ports/lifecycle-transition-store.js";
import { parseStateMutation } from "../../../src/application/state-contract.js";

const [agentDir, projectRoot] = process.argv.slice(2);
const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = { kind: "path-only", canonicalRoot: pathToFileURL(projectRoot).href, limitation: "identity-changes-with-canonical-root" };
const project = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
const paths = createPluginHostPathPlan(agentDir);
const state = await createNodeLifecycleStateAdapters({ paths, currentProject: project, sha256, verifyLocalFilesystem: async () => {} });
const recovery = await createNodeRecoveryAdapters({ hostRoot: paths.hostRoot, verifyLocalFilesystem: async () => {} });
try {
  const scope = { kind: "user" };
  const plugin = NormalizedPluginSchema.parse({
    identity: { key: "crash@local", marketplaceName: "local", marketplaceEntryName: "crash" },
    source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/crash.git", revision: "a".repeat(40) }, sha256),
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
    metadata: [],
  });
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const content = createContentManifest([], sha256);
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope }, sha256);
  const candidate = createInstalledPluginRecord({
    scope,
    plugin: plugin.identity.key,
    activation: "enabled",
    selectedRevision: revision.revision,
    revisions: [revision],
  }, sha256);
  const candidateProjection = createActiveProjectionExpectation(createPluginRuntimeProjection({ scope, plugin, compatibility, revision, sha256 }), sha256);
  const previousProjection = createInactiveProjectionExpectation({ scope, plugin: plugin.identity.key, sha256 });
  const record = createLifecycleTransitionRecord({
    operationId: "00000000-0000-4000-8000-000000000099",
    operation: "install",
    origin: "manual",
    scope,
    plugin: plugin.identity.key,
    startingGeneration: 0,
    previous: null,
    candidate,
    final: candidate,
    previousProjection,
    candidateProjection,
    retainedData: "keep",
    sha256,
  });
  await recovery.transitionStore.prepare({ record, preparedAt: Date.now() }, new AbortController().signal);
  const pending = InstalledPluginRecordSchema.parse({ ...candidate, pendingTransition: record.reference });
  const loaded = await state.state.read(scope, new AbortController().signal);
  if (!loaded.ok) throw new Error("default state unavailable");
  const marketplace = createMarketplaceSnapshotRecord({
    marketplace: "local",
    source: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/local" }, revision: "c".repeat(40) }, sha256),
    content,
  }, sha256);
  const installed = createInstalledUserStateDocument({ ...loaded.snapshot.installed, generation: 0, marketplaces: [marketplace], plugins: [pending] }, sha256);
  const committed = await state.state.commit(parseStateMutation({ scope, expectedGeneration: 0, replace: { installed } }, sha256), new AbortController().signal);
  if (committed.kind !== "committed") throw new Error("crash state commit lost");
  process.stdout.write(`${JSON.stringify({ reference: record.reference })}\n`);
} finally {
  await state.close();
  await recovery.close();
}
