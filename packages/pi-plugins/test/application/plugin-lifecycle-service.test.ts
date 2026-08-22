import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPluginLifecycleService, type PluginLifecycleServiceDependencies } from "../../src/application/plugin-lifecycle-service.js";
import { deriveLifecycleTargetDigest } from "../../src/application/native-lifecycle-target.js";
import type { LifecycleReloadPort } from "../../src/application/ports/lifecycle-reload.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import type { StateCommitResult, StateMutation, GenerationSnapshot } from "../../src/application/state-contract.js";
import {
  createInstalledPluginRecord,
  createInstalledRevisionRecord,
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
} from "../../src/domain/state/installed-state.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const scope = { kind: "user" as const };
const sourceRevision = "a".repeat(40);
const marketplaceSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/community" }, revision: sourceRevision }, sha256);
const entry = readClaudeMarketplace({ name: "community", plugins: [{ name: "fixture", source: "./plugin", strict: false }] }).marketplace.entries[0]!;
const plugin = NormalizedPluginSchema.parse({
  identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" },
  source: createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: sourceRevision, path: "plugin" }, sha256),
  configuration: { options: [] },
  components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
  metadata: [],
});
const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
const content = createContentManifest([], sha256);
const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope }, sha256);
const marketplace = createMarketplaceSnapshotRecord({ marketplace: "community", source: marketplaceSource, content }, sha256);

function installedRecord(activation: "enabled" | "disabled") {
  return createInstalledPluginRecord({ plugin: plugin.identity.key, activation, revisions: [{ plugin, compatibility, content }], scope }, sha256);
}

function snapshot(generation: number, activation?: "enabled" | "disabled"): GenerationSnapshot {
  const plugins = activation === undefined ? [] : [installedRecord(activation)];
  return {
    scope,
    generation,
    installed: createInstalledUserStateDocument({ generation, marketplaces: [marketplace], plugins }, sha256),
  } as unknown as GenerationSnapshot;
}

class MemoryState implements LifecycleStateStore {
  commits = 0;
  constructor(public current: GenerationSnapshot, private staleCommits = 0) {}

  async read(): Promise<{ ok: true; snapshot: GenerationSnapshot }> {
    return { ok: true, snapshot: this.current };
  }

  async commit(mutation: StateMutation): Promise<StateCommitResult> {
    this.commits += 1;
    if (this.staleCommits > 0) {
      this.staleCommits -= 1;
      return { kind: "stale-generation", expected: mutation.expectedGeneration, actual: mutation.expectedGeneration + 1 };
    }
    const replacement = mutation.replace.installed;
    if (replacement === undefined) throw new Error("fixture expected an installed-state replacement");
    const generation = this.current.generation + 1;
    this.current = { ...this.current, generation, installed: { ...replacement, generation } } as GenerationSnapshot;
    return { kind: "committed", snapshot: this.current };
  }
}

function dependencies(state: LifecycleStateStore, reload: LifecycleReloadPort["reload"] = async () => ({ kind: "accepted" })): PluginLifecycleServiceDependencies {
  return {
    state,
    content: {},
    materializer: {},
    inspector: {},
    compatibility: {},
    installed: {},
    projections: {},
    reload: { reload },
    projectTrust: {},
    projectRoots: {},
    configurations: {},
    secrets: {},
    paths: {},
    sha256,
  } as unknown as PluginLifecycleServiceDependencies;
}

describe("plugin lifecycle service", () => {
  it("commits a disable as one state transaction and reports applied activation", async () => {
    const state = new MemoryState(snapshot(0, "enabled"));
    const service = createPluginLifecycleService(dependencies(state));

    const result = await service.disable({ scope, plugin: plugin.identity.key }, signal);

    expect(result).toMatchObject({ kind: "applied", operation: "disable", activation: "applied" });
    expect(state.commits).toBe(1);
    expect(state.current.installed.plugins[0]?.activation).toBe("disabled");
  });

  it("reports live-next-start when the reload context is unavailable after commit", async () => {
    const state = new MemoryState(snapshot(0, "enabled"));
    const service = createPluginLifecycleService(dependencies(state, async () => ({ kind: "failed", code: "PI_RELOAD_CONTEXT_UNAVAILABLE" })));

    const result = await service.disable({ scope, plugin: plugin.identity.key }, signal);

    expect(result).toMatchObject({ kind: "live-next-start", operation: "disable", note: "no-reload-context" });
    expect(state.commits).toBe(1);
    expect(state.current.installed.plugins[0]?.activation).toBe("disabled");
  });

  it("returns current and rejected without opening a transaction", async () => {
    const alreadyDisabled = new MemoryState(snapshot(0, "disabled"));
    const service = createPluginLifecycleService(dependencies(alreadyDisabled));
    expect(await service.disable({ scope, plugin: plugin.identity.key }, signal)).toMatchObject({ kind: "current", operation: "disable" });
    expect(alreadyDisabled.commits).toBe(0);

    const absent = new MemoryState(snapshot(0));
    const absentService = createPluginLifecycleService(dependencies(absent));
    expect(await absentService.disable({ scope, plugin: plugin.identity.key }, signal)).toMatchObject({ kind: "rejected", operation: "disable", code: "NOT_INSTALLED" });
    expect(absent.commits).toBe(0);
  });

  it("rejects an exact target mismatch as stale before preparation or commit", async () => {
    const state = new MemoryState(snapshot(0, "enabled"));
    const target = state.current.installed.plugins[0]!;
    const service = createPluginLifecycleService(dependencies(state));
    const result = await service.disable({
      scope,
      plugin: plugin.identity.key,
      expectedTarget: {
        generation: state.current.generation,
        plugin: plugin.identity.key,
        selectedRevision: target.selectedRevision,
        activation: "disabled",
        targetDigest: deriveLifecycleTargetDigest(scope, target, sha256),
      },
    }, signal);

    expect(result).toMatchObject({ kind: "stale", operation: "disable", expected: 0, actual: 0 });
    expect(state.commits).toBe(0);
  });

  it("retries a stale CAS and commits the re-planned mutation within the bound", async () => {
    const state = new MemoryState(snapshot(0, "enabled"), 1);
    const service = createPluginLifecycleService(dependencies(state));

    const result = await service.disable({ scope, plugin: plugin.identity.key }, signal);

    expect(result.kind).toBe("applied");
    expect(state.commits).toBe(2);
    expect(state.current.installed.plugins[0]?.activation).toBe("disabled");
  });

  it("maps exhausted state-write contention to the typed BUSY rejection", async () => {
    const current = snapshot(0, "enabled");
    const busyState: LifecycleStateStore = {
      async read() { return { ok: true, snapshot: current }; },
      async commit() { throw Object.assign(new Error("another session is mid-write"), { name: "LifecycleStateBusyError" }); },
    };
    const service = createPluginLifecycleService(dependencies(busyState));

    const result = await service.disable({ scope, plugin: plugin.identity.key }, signal);

    expect(result).toMatchObject({ kind: "rejected", operation: "disable", code: "BUSY" });
  });

  it("keeps the selected revision authoritative and does not add a transition marker", async () => {
    const state = new MemoryState(snapshot(0, "enabled"));
    const service = createPluginLifecycleService(dependencies(state));
    await service.disable({ scope, plugin: plugin.identity.key }, signal);
    const record = state.current.installed.plugins[0]!;

    expect(record.selectedRevision).toBe(revision.revision);
    expect(record).not.toHaveProperty("pendingTransition");
  });

  it("rolls back by one pointer flip while preserving roll-forward evidence", async () => {
    const newerSource = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "b".repeat(40), path: "./plugin" }, sha256);
    const newerPlugin = NormalizedPluginSchema.parse({ ...plugin, source: newerSource });
    const newerRevision = createInstalledRevisionRecord({ plugin: newerPlugin, compatibility, content, scope }, sha256);
    const history = createInstalledPluginRecord({
      plugin: plugin.identity.key,
      activation: "enabled",
      selectedRevision: newerRevision.revision,
      previousRevision: revision.revision,
      revisions: [
        { plugin, compatibility, content },
        { plugin: newerPlugin, compatibility, content },
      ],
      scope,
    }, sha256);
    const base = snapshot(0);
    const state = new MemoryState({ ...base, installed: { ...base.installed, plugins: [history] } } as GenerationSnapshot);
    const service = createPluginLifecycleService(dependencies(state));

    const result = await service.rollback({ scope, plugin: plugin.identity.key }, signal);

    expect(result).toMatchObject({ kind: "applied", operation: "rollback", activation: "applied" });
    expect(state.commits).toBe(1);
    expect(state.current.installed.plugins[0]).toMatchObject({ selectedRevision: revision.revision, previousRevision: newerRevision.revision });
  });
});
