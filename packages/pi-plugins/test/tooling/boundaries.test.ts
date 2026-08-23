import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const retired = [
  "src/application/recovery-service.ts",
  "src/application/lifecycle-transition-reconciler.ts",
  "src/application/recovery-contract.ts",
  "src/application/revision-collection-service.ts",
  "src/application/native-uninstall-cleanup.ts",
  "src/application/generation-mutation-coordinator.ts",
  "src/application/keyed-mutation-scheduler.ts",
  "src/application/mutation-coordination.ts",
  "src/application/ports/mutation-execution-context.ts",
  "src/application/ports/lifecycle-transition-store.ts",
  "src/application/ports/recovery-artifacts.ts",
  "src/application/ports/revision-lease-store.ts",
  "src/application/ports/revision-retention-store.ts",
  "src/application/ports/scope-lock.ts",
  "src/infrastructure/recovery/sqlite-transition-journal.ts",
  "src/infrastructure/recovery/sqlite-revision-retention.ts",
  "src/infrastructure/recovery/process-revision-leases.ts",
  "src/infrastructure/recovery/recovery-artifact-scanner.ts",
  "src/infrastructure/recovery/local-recovery-filesystem.ts",
  "src/infrastructure/recovery/revision-artifact-store.ts",
  "src/infrastructure/recovery/create-node-recovery-adapters.ts",
  "src/infrastructure/state/sqlite-scope-lock.ts",
  "src/infrastructure/state/keyed-mutation-scheduler.ts",
  "src/runtime/mcp/revision-lease-provider.ts",
];
const retiredTests = [
  "test/application/recovery-service.test.ts",
  "test/application/recovery-contract.test.ts",
  "test/application/lifecycle-transition-reconciler.test.ts",
  "test/application/generation-mutation-coordinator.test.ts",
  "test/application/revision-collection-service.test.ts",
  "test/application/native-uninstall-cleanup.test.ts",
  "test/infrastructure/recovery/process-revision-leases.test.ts",
  "test/infrastructure/recovery/recovery-artifact-scanner.test.ts",
  "test/infrastructure/recovery/revision-artifact-store.test.ts",
  "test/infrastructure/recovery/sqlite-transition-journal.test.ts",
  "test/infrastructure/state/sqlite-scope-lock.test.ts",
  "test/integration/lifecycle-recovery.test.ts",
  "test/integration/mcp-lifecycle-recovery.test.ts",
  "test/integration/packaged-host-crash-recovery.test.ts",
  "test/integration/packaged-host-startup-recovery.test.ts",
  "test/integration/trusted-installation-recovery.test.ts",
  "test/integration/recovery-review-hardening.test.ts",
  "test/integration/revision-collection.test.ts",
  "test/e2e/chaos/lifecycle-crash-recovery.e2e.test.ts",
];
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);
}
describe("convergent lifecycle structural boundaries", () => {
  it("does not ship the removed coordinator, journal, or scope-fence cluster", () => {
    expect(retired.filter((path) => existsSync(join(root, path)))).toEqual([]);
  });
  it("does not ship the removed recovery and lifecycle suites", () => {
    expect(retiredTests.filter((path) => existsSync(join(root, path)))).toEqual([]);
  });
  it("keeps removed lifecycle vocabulary confined to the migration decoder", () => {
    const legacy = ["pendingTransition", "recovery-required", "LifecycleTransitionStore", "install.recover"];
    const offenders = sourceFiles(join(root, "src")).filter((path) => path !== join(root, "src/infrastructure/state/lifecycle-convergence-migration.ts") && legacy.some((term) => readFileSync(path, "utf8").includes(term)));
    expect(offenders).toEqual([]);
  });
});
