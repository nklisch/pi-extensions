import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeUninstallCleanupService } from "../../src/application/native-uninstall-cleanup.js";
import { createLifecycleTransitionRecord, LifecycleTransitionJournalEntrySchemaV2, migrateLifecycleTransitionJournalEntryV1 } from "../../src/application/ports/lifecycle-transition-store.js";
import { deriveLifecyclePendingTransitionRef } from "../../src/application/plugin-lifecycle-contract.js";
import { createInactiveProjectionExpectation } from "../../src/application/ports/runtime-projection.js";
import { createInstalledPluginRecord } from "../../src/domain/state/installed-state.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const plugin = NormalizedPluginSchema.parse({ identity: { key: "cleanup@market", marketplaceName: "market", marketplaceEntryName: "cleanup" }, source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/plugin.git", revision: "a".repeat(40) }, sha256), configuration: { options: [] }, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, metadata: [] });
const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
const content = createContentManifest([], sha256);
const installed = createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "disabled", revisions: [{ plugin, compatibility, content, scope: { kind: "user" } }] }, sha256);
const projection = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: plugin.identity.key, sha256 });
function transition(retainedData: "keep" | "delete-confirmed") {
  const operationId = retainedData === "keep" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002";
  const reference = deriveLifecyclePendingTransitionRef({ operationId, scope: { kind: "user" }, plugin: plugin.identity.key, startingGeneration: 0 }, sha256);
  return createLifecycleTransitionRecord({ operationId, operation: "uninstall", origin: "manual", scope: { kind: "user" }, plugin: plugin.identity.key, startingGeneration: 0, previous: installed, candidate: installed, final: null, previousProjection: projection, candidateProjection: projection, retainedData, reference, sha256 });
}
function entry(retainedData: "keep" | "delete-confirmed", cleanup: "not-required" | "pending-data-delete" | "recovery-required" | "completed") {
  return LifecycleTransitionJournalEntrySchemaV2.parse({ schemaVersion: 2, record: transition(retainedData), status: { kind: "completed", generation: 1 }, cleanup, preparedAt: 1, statusAt: 2 });
}

describe("native uninstall cleanup", () => {
  it("retains configuration/trust by construction and never removes data for keep", async () => {
    const remove = vi.fn();
    const service = createNativeUninstallCleanupService({ transitions: () => ({} as any), data: { remove }, clock: { nowEpochMilliseconds: () => 3 as never, monotonicMilliseconds: () => 3 } });
    expect(await service.recover(entry("keep", "not-required"), signal)).toEqual({ kind: "retained" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("marks deletion recovery-required after a crash/failure and retries idempotently", async () => {
    let cleanup: "pending-data-delete" | "recovery-required" | "completed" = "pending-data-delete";
    const markCleanup = vi.fn(async (request: any) => { cleanup = request.status; return "stored" as const; });
    const remove = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce("already-absent");
    const service = createNativeUninstallCleanupService({ transitions: () => ({ markCleanup } as any), data: { remove }, clock: { nowEpochMilliseconds: () => 3 as never, monotonicMilliseconds: () => 3 } });
    expect(await service.recover(entry("delete-confirmed", cleanup), signal)).toMatchObject({ kind: "recovery-required" });
    expect(cleanup).toBe("recovery-required");
    expect(await service.recover(entry("delete-confirmed", cleanup), signal)).toEqual({ kind: "deleted" });
    expect(cleanup).toBe("completed");
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("migrates completed v1 delete-confirmed journals to pending deletion", () => {
    const migrated = migrateLifecycleTransitionJournalEntryV1({ schemaVersion: 1, record: transition("delete-confirmed"), status: { kind: "completed", generation: 1 }, preparedAt: 1, statusAt: 2 });
    expect(migrated).toMatchObject({ schemaVersion: 2, cleanup: "pending-data-delete" });
  });
});
