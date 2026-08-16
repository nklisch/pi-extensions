import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompatibilityReportSchema } from "../../../src/domain/compatibility.js";
import { createContentManifest } from "../../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../../src/domain/plugin.js";
import { createInstalledPluginRecord } from "../../../src/domain/state/installed-state.js";
import { createResolvedPluginSource } from "../../../src/domain/source.js";
import { createInactiveProjectionExpectation } from "../../../src/application/ports/runtime-projection.js";
import { createLifecycleTransitionRecord } from "../../../src/application/ports/lifecycle-transition-store.js";
import { deriveLifecyclePendingTransitionRef } from "../../../src/application/plugin-lifecycle-contract.js";
import { createLocalRecoveryFilesystem } from "../../../src/infrastructure/recovery/local-recovery-filesystem.js";
import { createSqliteTransitionJournal } from "../../../src/infrastructure/recovery/sqlite-transition-journal.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const plugin = NormalizedPluginSchema.parse({
  identity: { key: "journal@community", marketplaceName: "community", marketplaceEntryName: "journal" },
  source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/journal.git", revision: "a".repeat(40) }, sha256),
  configuration: { options: [] }, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, metadata: [],
});
const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
const content = createContentManifest([], sha256);
const state = createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "disabled", revisions: [{ plugin, compatibility, content }], scope: { kind: "user" } }, sha256);
const projection = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: plugin.identity.key, sha256 });
function record(operationId: string, uninstall = false) {
  const reference = deriveLifecyclePendingTransitionRef({ operationId, scope: { kind: "user" }, plugin: plugin.identity.key, startingGeneration: 0 }, sha256);
  return createLifecycleTransitionRecord({ operationId, operation: uninstall ? "uninstall" : "disable", origin: "manual", scope: { kind: "user" }, plugin: plugin.identity.key, startingGeneration: 0, previous: state, candidate: state, final: uninstall ? null : state, previousProjection: projection, candidateProjection: projection, retainedData: uninstall ? "delete-confirmed" : "keep", reference, sha256 });
}

async function journalRoot() {
  const root = await mkdtemp(join(process.cwd(), ".test-recovery-journal-"));
  const filesystem = await createLocalRecoveryFilesystem({ hostRoot: root, verifyLocalFilesystem: async () => {} });
  return { root, filesystem, journal: createSqliteTransitionJournal({ filesystem }) };
}

describe("SQLite transition journal", () => {
  it("durably stores exact records and enforces resumable/terminal status edges", async () => {
    const fixture = await journalRoot();
    try {
      const first = record("00000000-0000-4000-8000-000000000001");
      expect(await fixture.journal.prepare({ record: first, preparedAt: 10 }, signal)).toBe("stored");
      expect(await fixture.journal.prepare({ record: first, preparedAt: 10 }, signal)).toBe("already-present");
      expect((await fixture.journal.read({ scope: { kind: "user" }, reference: first.reference }, signal)).kind).toBe("found");
      expect(await fixture.journal.markRecoveryRequired!({ scope: { kind: "user" }, reference: first.reference, at: 11 }, signal)).toBe("stored");
      await fixture.journal.settle({ reference: first.reference, outcome: "completed", generation: 1, at: 12 }, signal);
      await fixture.journal.settle({ reference: first.reference, outcome: "completed", generation: 1, at: 13 }, signal);
      await expect(fixture.journal.settle({ reference: first.reference, outcome: "rolled-back", at: 14 }, signal)).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
      const path = fixture.filesystem.journalDatabasePath({ kind: "user" });
      const database = new DatabaseSync(path, { readOnly: true });
      expect((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
      database.close();
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it("ignores stale identity-marker debris from older host versions", async () => {
    const fixture = await journalRoot();
    try {
      const value = record("00000000-0000-4000-8000-000000000006");
      await fixture.journal.prepare({ record: value, preparedAt: 10 }, signal);
      // Pre-removal hosts wrote .identity markers next to each journal
      // database. They are inert debris now and must not affect operation.
      const markerPath = `${fixture.filesystem.journalDatabasePath({ kind: "user" })}.identity`;
      await writeFile(markerPath, `${JSON.stringify({ protocol: "pi-plugin-host-recovery-journal-database", device: "previous-mount-epoch" })}\n`);
      expect((await fixture.journal.read({ scope: { kind: "user" }, reference: value.reference }, signal)).kind).toBe("found");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it("durably tracks terminal uninstall cleanup before allowing journal pruning", async () => {
    const fixture = await journalRoot();
    try {
      const value = record("00000000-0000-4000-8000-000000000005", true);
      await fixture.journal.prepare({ record: value, preparedAt: 10 }, signal);
      expect((await fixture.journal.read({ scope: { kind: "user" }, reference: value.reference }, signal))).toMatchObject({ kind: "found", entry: { cleanup: "pending-data-delete" } });
      await fixture.journal.settle({ scope: { kind: "user" }, reference: value.reference, outcome: "completed", generation: 1, at: 11 }, signal);
      expect(await fixture.journal.markCleanup!({ scope: { kind: "user" }, reference: value.reference, status: "recovery-required", at: 12 }, signal)).toBe("stored");
      expect(await fixture.journal.markCleanup!({ scope: { kind: "user" }, reference: value.reference, status: "completed", at: 13 }, signal)).toBe("stored");
      expect((await fixture.journal.read({ scope: { kind: "user" }, reference: value.reference }, signal))).toMatchObject({ kind: "found", entry: { cleanup: "completed" } });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it("quarantines one digest-invalid row while preserving valid siblings", async () => {
    const fixture = await journalRoot();
    try {
      const valid = record("00000000-0000-4000-8000-000000000002");
      const bad = record("00000000-0000-4000-8000-000000000003");
      await fixture.journal.prepare({ record: valid, preparedAt: 10 }, signal);
      await fixture.journal.prepare({ record: bad, preparedAt: 10 }, signal);
      const database = new DatabaseSync(fixture.filesystem.journalDatabasePath({ kind: "user" }));
      database.prepare("UPDATE lifecycle_transitions SET record_json = ? WHERE reference = ?").run("{bad", bad.reference as string);
      database.close();
      expect((await fixture.journal.list({ kind: "user" }, signal)).entries).toHaveLength(1);
      expect((await fixture.journal.read({ scope: { kind: "user" }, reference: bad.reference }, signal)).kind).toBe("missing");
      expect((await fixture.journal.list({ kind: "user" }, signal)).entries[0]?.record.reference).toBe(valid.reference);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it("does not allow takeover while the owner is live and releases it after recovery-required", async () => {
    const fixture = await journalRoot();
    try {
      const value = record("00000000-0000-4000-8000-000000000004");
      await fixture.journal.prepare({ record: value, preparedAt: 10 }, signal);
      expect(await fixture.journal.ownerStatus({ kind: "user" }, value.reference, signal)).toBe("live");
      await fixture.journal.markRecoveryRequired!({ scope: { kind: "user" }, reference: value.reference, at: 11 }, signal);
      expect(await fixture.journal.ownerStatus({ kind: "user" }, value.reference, signal)).toBe("released");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it("hands a deliberately staged row to the next start without waiting for owner death", async () => {
    const fixture = await journalRoot();
    try {
      const staged = record("00000000-0000-4000-8000-000000000007");
      await fixture.journal.prepare({ record: staged, preparedAt: 10 }, signal);
      // The staging process (this one) is still alive.
      expect(await fixture.journal.ownerStatus({ kind: "user" }, staged.reference, signal)).toBe("live");
      // A deliberate stage hands the row off; any future start may settle it.
      expect(await fixture.journal.releaseOwnership({ scope: { kind: "user" }, reference: staged.reference }, signal)).toBe("released");
      expect(await fixture.journal.ownerStatus({ kind: "user" }, staged.reference, signal)).toBe("released");
      expect(await fixture.journal.releaseOwnership({ scope: { kind: "user" }, reference: staged.reference }, signal)).toBe("released");
      // A foreign owner is mid-flight on the immediate path and stays fenced.
      const foreign = record("00000000-0000-4000-8000-000000000008");
      await fixture.journal.prepare({ record: foreign, preparedAt: 10 }, signal);
      const database = new DatabaseSync(fixture.filesystem.journalDatabasePath({ kind: "user" }));
      database.prepare("UPDATE lifecycle_transitions SET owner_pid = 999999999, owner_start_token = '1' WHERE reference = ?").run(foreign.reference as string);
      database.close();
      expect(await fixture.journal.releaseOwnership({ scope: { kind: "user" }, reference: foreign.reference }, signal)).toBe("retained");
      expect(await fixture.journal.ownerStatus({ kind: "user" }, foreign.reference, signal)).toBe("dead");
      // Settling a released row stays idempotent.
      await fixture.journal.settle({ scope: { kind: "user" }, reference: staged.reference, outcome: "completed", generation: 1, at: 12 }, signal);
      expect(await fixture.journal.ownerStatus({ kind: "user" }, staged.reference, signal)).toBe("released");
      expect(await fixture.journal.releaseOwnership({ scope: { kind: "user" }, reference: `pending-transition-v1:sha256:${"f".repeat(64)}` }, signal)).toBe("missing");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});
