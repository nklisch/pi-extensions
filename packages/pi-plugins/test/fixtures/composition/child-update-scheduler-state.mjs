import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPluginHostPathPlan } from "../../../src/composition/plugin-host-paths.js";
import { createNodeLifecycleStateAdapters } from "../../../src/infrastructure/state/sqlite-lifecycle-state-store.js";
import { createSqliteScopeLockManager } from "../../../src/infrastructure/state/sqlite-scope-lock.js";
import { createKeyedMutationScheduler } from "../../../src/infrastructure/state/keyed-mutation-scheduler.js";
import { createGenerationMutationCoordinator } from "../../../src/application/generation-mutation-coordinator.js";
import { createStateUpdateSchedulerLeasePort } from "../../../src/application/update-scheduler-lease-state.js";
import { createMarketplaceUpdateRecordsMutation } from "../../../src/application/marketplace-update-state.js";
import { deriveUpdateSchedule } from "../../../src/application/update-schedule.js";
import { createMarketplaceConfigurationRecord } from "../../../src/domain/update-policy.js";
import { deriveMarketplaceRegistrationId } from "../../../src/domain/marketplace-registration.js";
import { createScopeContext, deriveProjectKey } from "../../../src/domain/state/scope.js";

const [agentDir, projectRoot, mode, nowText, valueText] = process.argv.slice(2);
if (![agentDir, projectRoot, mode, nowText].every((value) => typeof value === "string" && value.length > 0)) throw new Error("scheduler child arguments are required");
const now = Number(nowText);
const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = { kind: "path-only", canonicalRoot: pathToFileURL(projectRoot).href, limitation: "identity-changes-with-canonical-root" };
const project = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
if (project.kind !== "project") throw new Error("project scope unavailable");
const paths = createPluginHostPathPlan(agentDir);
const state = await createNodeLifecycleStateAdapters({ paths, currentProject: project, sha256, verifyLocalFilesystem: async () => {} });
const locks = await createSqliteScopeLockManager({ lockRoot: paths.lockRoot, retryDelayMs: { minimum: 1, maximum: 2 }, verifyLocalFilesystem: async () => {} });
const mutations = createGenerationMutationCoordinator({ scheduler: createKeyedMutationScheduler(), locks, state: state.state });
const authority = {
  currentProject: project,
  projectTrust: { async assess(key) { return { kind: key === project.projectKey ? "trusted" : "untrusted" }; } },
  async revalidateCurrentProject() { return { identity, projectKey: project.projectKey, trust: { kind: "trusted" } }; },
};
const port = createStateUpdateSchedulerLeasePort({
  state: state.state, inventory: state.inventory, mutations,
  clock: { nowEpochMilliseconds: () => now, monotonicMilliseconds: () => now },
  sha256, ...authority,
});
try {
  if (mode === "lease") {
    const result = await port.acquire({ kind: "user" }, valueText, now, 1_000, new AbortController().signal);
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } else if (mode === "seed") {
    const loaded = await state.state.read({ kind: "user" }, new AbortController().signal);
    if (!loaded.ok) throw new Error("user state unavailable");
    const source = { kind: "github", repository: "example/community" };
    const registrationId = deriveMarketplaceRegistrationId({ scope: { kind: "user" }, source }, sha256);
    const failureCount = Number(valueText);
    const schedule = deriveUpdateSchedule({ registrationId, outcome: "failure", failureCount, anchorAt: now, cadence: "balanced" }, sha256);
    const record = createMarketplaceConfigurationRecord({ marketplace: "community", source, refresh: { consecutiveFailures: failureCount, schedule } });
    const result = await mutations.runPreparedMutation(
      { scope: { kind: "user" }, plugins: [], expectedGeneration: loaded.snapshot.generation },
      async ({ snapshot }) => ({ mutation: createMarketplaceUpdateRecordsMutation(snapshot, [record], sha256), value: schedule }),
      new AbortController().signal,
    );
    process.stdout.write(`${JSON.stringify({ result: result.kind, schedule })}\n`);
  } else if (mode === "inventory") {
    const inventory = await port.inventory(new AbortController().signal);
    const user = inventory.plans.find((plan) => plan.scope.kind === "user");
    process.stdout.write(`${JSON.stringify({ complete: inventory.complete, plan: user })}\n`);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  await state.close();
}
