import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createPromotionPlan } from "../../src/application/content-promotion.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createInstalledPluginRecord, createInstalledUserStateDocument, createMarketplaceSnapshotRecord } from "../../src/domain/state/installed-state.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { createInactiveProjectionExpectation } from "../../src/application/ports/runtime-projection.js";
import { createLifecycleTransitionRecord } from "../../src/application/ports/lifecycle-transition-store.js";
import { deriveLifecyclePendingTransitionRef } from "../../src/application/plugin-lifecycle-contract.js";
import { createRevisionCollectionService } from "../../src/application/revision-collection-service.js";
import { createNodeContentStoreWithPlatform } from "../../src/infrastructure/filesystem/create-content-store.js";
import { createNodeContentStorePlatform, renameNoReplaceByProbe } from "../../src/infrastructure/filesystem/content-store-durability.js";
import { createNodeTransitionJournal } from "../../src/infrastructure/recovery/sqlite-transition-journal.js";
import { createProcessRevisionLeaseStore } from "../../src/infrastructure/recovery/process-revision-leases.js";
import { createNodeRecoveryAdapters } from "../../src/infrastructure/recovery/create-node-recovery-adapters.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const fixture = resolve(process.cwd(), "test/fixtures/recovery/child-recovery-adapter.mjs");
const loader = resolve(process.cwd(), "test/fixtures/locking/source-loader.mjs");

type ChildEvent = Readonly<Record<string, unknown>>;
type RecoveryChild = Readonly<{
  process: ChildProcessWithoutNullStreams;
  events: ChildEvent[];
  send(command: string): void;
  waitFor(predicate: (event: ChildEvent) => boolean): Promise<ChildEvent>;
}>;

const closedChildren = new WeakSet<ChildProcessWithoutNullStreams>();

function startChild(mode: string, hostRoot: string, environment: Record<string, string>): RecoveryChild {
  const childProcess = spawn(process.execPath, [
    "--experimental-strip-types",
    "--experimental-transform-types",
    "--loader",
    loader,
    fixture,
    mode,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, NODE_OPTIONS: "", VITEST: undefined },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: ChildEvent[] = [];
  let stderr = "";
  childProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const waiters: Array<{
    predicate: (event: ChildEvent) => boolean;
    resolve: (event: ChildEvent) => void;
    reject: (error: Error) => void;
  }> = [];
  createInterface({ input: childProcess.stdout }).on("line", (line) => {
    try {
      const event = JSON.parse(line) as ChildEvent;
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(event)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    } catch {
      // Missing expected events surface the child stderr through waitFor.
    }
  });
  childProcess.once("close", (code, childSignal) => {
    closedChildren.add(childProcess);
    const error = new Error(`recovery child exited before expected event: ${code ?? childSignal}; stderr: ${stderr}`);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  return {
    process: childProcess,
    events,
    send(command: string) { childProcess.stdin.write(`${command}\n`); },
    waitFor(predicate: (event: ChildEvent) => boolean) {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
        return Promise.reject(new Error(`recovery child exited before expected event; stderr: ${stderr}`));
      }
      return new Promise((resolvePromise, rejectPromise) => waiters.push({ predicate, resolve: resolvePromise, reject: rejectPromise }));
    },
  };
}

async function waitForExit(childProcess: ChildProcessWithoutNullStreams): Promise<void> {
  if (closedChildren.has(childProcess) || childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => childProcess.once("close", () => resolvePromise()));
}

function transitionRecord(operationId: string, operation: "disable" | "enable" = "disable") {
  const plugin = NormalizedPluginSchema.parse({
    identity: { key: "journal@community", marketplaceName: "community", marketplaceEntryName: "journal" },
    source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/journal.git", revision: "a".repeat(40) }, sha256),
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
    metadata: [],
  });
  const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
  const content = createContentManifest([], sha256);
  const state = createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "disabled", revisions: [{ plugin, compatibility, content }], scope: { kind: "user" } }, sha256);
  const projection = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: plugin.identity.key, sha256 });
  const reference = deriveLifecyclePendingTransitionRef({ operationId, scope: { kind: "user" }, plugin: plugin.identity.key, startingGeneration: 0 }, sha256);
  return createLifecycleTransitionRecord({ operationId, operation, origin: "manual", scope: { kind: "user" }, plugin: plugin.identity.key, startingGeneration: 0, previous: state, candidate: state, final: state, previousProjection: projection, candidateProjection: projection, retainedData: "keep", reference, sha256 });
}

async function temporaryRoot(prefix: string): Promise<string> {
  return mkdtemp(join(process.cwd(), prefix));
}

describe("recovery hardening real-process acceptance", () => {
  it("leaves no row before prepare acknowledgment and preserves one complete row after acknowledgment", async () => {
    const root = await temporaryRoot(".test-recovery-crash-");
    const record = transitionRecord("00000000-0000-4000-8000-000000000101");
    const child = startChild("journal", root, { RECOVERY_HOST_ROOT: root, RECOVERY_RECORD_JSON: JSON.stringify(record), RECOVERY_PREPARED_AT: "10" });
    try {
      await child.waitFor((event) => event.event === "ready");
      child.process.kill("SIGKILL");
      await waitForExit(child.process);
      let restarted = await createNodeTransitionJournal({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      expect((await restarted.read({ scope: { kind: "user" }, reference: record.reference }, signal)).kind).toBe("missing");
      expect((await restarted.list({ kind: "user" }, signal)).entries).toHaveLength(0);

      const acknowledged = startChild("journal", root, { RECOVERY_HOST_ROOT: root, RECOVERY_RECORD_JSON: JSON.stringify(record), RECOVERY_PREPARED_AT: "10" });
      try {
        await acknowledged.waitFor((event) => event.event === "ready");
        acknowledged.send("prepare");
        await acknowledged.waitFor((event) => event.event === "prepared");
        acknowledged.process.kill("SIGKILL");
        await waitForExit(acknowledged.process);
        restarted = await createNodeTransitionJournal({ hostRoot: root, verifyLocalFilesystem: async () => {} });
        const listed = await restarted.list({ kind: "user" }, signal);
        expect(listed.complete).toBe(true);
        expect(listed.entries).toHaveLength(1);
        expect(listed.entries[0]?.record).toEqual(record);
      } finally {
        if (acknowledged.process.exitCode === null) acknowledged.process.kill("SIGKILL");
        await waitForExit(acknowledged.process);
      }
    } finally {
      if (child.process.exitCode === null) child.process.kill("SIGKILL");
      await waitForExit(child.process);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("converges identical prepares and isolates conflicting evidence across processes", async () => {
    const root = await temporaryRoot(".test-recovery-concurrency-");
    const record = transitionRecord("00000000-0000-4000-8000-000000000102");
    // Bootstrap the shared recovery root before fanning out. The acceptance
    // boundary is SQLite transaction convergence, not first-directory setup.
    await createNodeTransitionJournal({ hostRoot: root, verifyLocalFilesystem: async () => {} });
    const children = [
      startChild("journal", root, { RECOVERY_HOST_ROOT: root, RECOVERY_RECORD_JSON: JSON.stringify(record), RECOVERY_PREPARED_AT: "10" }),
      startChild("journal", root, { RECOVERY_HOST_ROOT: root, RECOVERY_RECORD_JSON: JSON.stringify(record), RECOVERY_PREPARED_AT: "10" }),
    ];
    try {
      await Promise.all(children.map((child) => child.waitFor((event) => event.event === "ready")));
      children.forEach((child) => child.send("prepare"));
      const results = await Promise.all(children.map((child) => child.waitFor((event) => event.event === "prepared" || event.event === "error")));
      expect(results.map((event) => event.result).sort(), JSON.stringify(results)).toEqual(["already-present", "stored"]);
      const accepted = await createNodeTransitionJournal({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      expect((await accepted.list({ kind: "user" }, signal)).entries).toHaveLength(1);
      children.forEach((child) => child.send("release"));
      await Promise.all(children.map((child) => waitForExit(child.process)));

      const conflicting = transitionRecord("00000000-0000-4000-8000-000000000102", "enable");
      const winner = startChild("journal", root, { RECOVERY_HOST_ROOT: root, RECOVERY_RECORD_JSON: JSON.stringify(record), RECOVERY_PREPARED_AT: "10" });
      const loser = startChild("journal", root, { RECOVERY_HOST_ROOT: root, RECOVERY_RECORD_JSON: JSON.stringify(conflicting), RECOVERY_PREPARED_AT: "10" });
      try {
        await Promise.all([winner.waitFor((event) => event.event === "ready"), loser.waitFor((event) => event.event === "ready")]);
        winner.send("prepare");
        loser.send("prepare");
        const terminal = await Promise.all([winner.waitFor((event) => event.event === "prepared" || event.event === "error"), loser.waitFor((event) => event.event === "prepared" || event.event === "error")]);
        expect(terminal.some((event) => event.event === "prepared")).toBe(true);
        expect(terminal.some((event) => event.event === "error" && event.code === "RECOVERY_CONFLICT")).toBe(true);
        winner.send("release");
        await waitForExit(loser.process);
        await waitForExit(winner.process);
        expect((await accepted.list({ kind: "user" }, signal)).entries).toHaveLength(1);
        expect((await accepted.read({ scope: { kind: "user" }, reference: record.reference }, signal)).kind).toBe("found");
      } finally {
        if (winner.process.exitCode === null) winner.process.kill("SIGKILL");
        if (loser.process.exitCode === null) loser.process.kill("SIGKILL");
        await Promise.all([waitForExit(winner.process), waitForExit(loser.process)]);
      }
    } finally {
      for (const child of children) if (child.process.exitCode === null) child.process.kill("SIGKILL");
      await Promise.all(children.map((child) => waitForExit(child.process)));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses real content, retention, and artifact adapters to prune state before physical removal", async () => {
    const root = await temporaryRoot(".test-recovery-prune-order-");
    const publishedRoots: string[] = [];
    try {
      const contentStore = await createNodeContentStoreWithPlatform({
        hostRoot: root,
        platform: createNodeContentStorePlatform({ renameNoReplace: renameNoReplaceByProbe }),
        randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index + 7),
      });
      const content = createContentManifest([], sha256);
      const plugin = (revision: string) => NormalizedPluginSchema.parse({
        identity: { key: "collector@community", marketplaceName: "community", marketplaceEntryName: "collector" },
        source: createResolvedPluginSource({ kind: "git", url: `https://example.invalid/collector-${revision}.git`, revision: revision.repeat(40) }, sha256),
        configuration: { options: [] }, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, metadata: [],
      });
      const publish = async (value: ReturnType<typeof plugin>) => {
        const allocation = await contentStore.allocateStaging(signal);
        await mkdir(join(allocation.slot.root, "content"));
        const binding = createMaterializationBinding(value.source.hash, content.rootDigest, sha256);
        const plan = createPromotionPlan({
          kind: "plugin",
          allocation,
          materialized: { root: join(allocation.slot.root, "content"), source: value.source, content, binding },
        }, sha256);
        const result = await contentStore.promote(plan, signal);
        publishedRoots.push(result.root.replace(/[/\\\\]content$/, ""));
        return result;
      };
      const oldPlugin = plugin("a");
      const currentPlugin = plugin("b");
      await publish(oldPlugin);
      await publish(currentPlugin);
      const compatibility = (value: ReturnType<typeof plugin>) => CompatibilityReportSchema.parse({ plugin: value.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
      const oldSingle = createInstalledPluginRecord({ plugin: oldPlugin.identity.key, activation: "disabled", revisions: [{ plugin: oldPlugin, compatibility: compatibility(oldPlugin), content }], scope: { kind: "user" } }, sha256);
      const currentSingle = createInstalledPluginRecord({ plugin: currentPlugin.identity.key, activation: "disabled", revisions: [{ plugin: currentPlugin, compatibility: compatibility(currentPlugin), content }], scope: { kind: "user" } }, sha256);
      const installedRecord = createInstalledPluginRecord({ plugin: oldPlugin.identity.key, activation: "disabled", selectedRevision: currentSingle.selectedRevision, revisions: [oldSingle.revisions[0]!, currentSingle.revisions[0]!], scope: { kind: "user" } }, sha256);
      const marketplaceSource = createResolvedMarketplaceSource({ declared: { kind: "git", url: "https://example.invalid/community.git" }, revision: "c".repeat(40) }, sha256);
      const installed = createInstalledUserStateDocument({
        generation: 0,
        marketplaces: [createMarketplaceSnapshotRecord({ marketplace: "community", source: marketplaceSource, content }, sha256)],
        plugins: [installedRecord],
      }, sha256);
      let snapshot = { scope: { kind: "user" }, generation: 0, installed } as never;
      const adapters = await createNodeRecoveryAdapters({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      let removals = 0;
      const service = createRevisionCollectionService({
        state: { async read() { return { ok: true, snapshot }; }, async commit() { throw new Error("state commit is coordinated by the test mutation port"); } },
        inventory: { async discover() { return { scopes: [{ kind: "user" }], complete: true }; } },
        transitions: adapters.transitions,
        leases: adapters.leases,
        retention: adapters.retention,
        artifacts: {
          scan: adapters.artifacts.scan,
          async remove(candidate, removeSignal) {
            expect((snapshot as { installed: { plugins: readonly { revisions: readonly unknown[] }[] } }).installed.plugins[0]?.revisions).toHaveLength(1);
            removals += 1;
            return adapters.artifacts.remove(candidate, removeSignal);
          },
        },
        mutations: {
          async runPreparedMutation(_request: unknown, prepare: (context: { snapshot: never; assertOwned(): Promise<void> }) => Promise<{ mutation: unknown; value: undefined }>) {
            const prepared = await prepare({ snapshot, assertOwned: async () => {} });
            const replacement = (prepared.mutation as { replace: { installed: unknown } }).replace.installed;
            snapshot = { ...(snapshot as object), generation: 1, installed: replacement } as never;
            return { kind: "committed", value: undefined, snapshot };
          },
        } as never,
        sha256,
        clock: { nowEpochMilliseconds: () => 86_400_001, monotonicMilliseconds: () => 0 },
      });
      const result = await service.collect({ policy: { unreferencedGraceMs: 0 } }, signal);
      expect(result).toMatchObject({ kind: "collected", prunedRevisions: 1, removedArtifacts: 1 });
      expect(removals).toBe(1);
      expect((await adapters.artifacts.scan(signal)).artifacts).toHaveLength(1);
    } finally {
      for (const publishedRoot of publishedRoots) {
        await chmod(join(publishedRoot, "READY"), 0o644).catch(() => undefined);
        await chmod(join(publishedRoot, "metadata.json"), 0o644).catch(() => undefined);
        await chmod(join(publishedRoot, "content"), 0o755).catch(() => undefined);
        await chmod(publishedRoot, 0o755).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses a live second-process lease to pin an artifact until explicit release", async () => {
    const root = await temporaryRoot(".test-recovery-lease-");
    const reference = { kind: "plugin" as const, key: `plugin-store-v1:sha256:${"b".repeat(64)}` as never };
    const candidate = Object.freeze({ kind: "plugin" as const, key: reference.key, reference, capability: {} });
    const child = startChild("lease", root, { RECOVERY_HOST_ROOT: root, RECOVERY_ARTIFACTS_JSON: JSON.stringify([reference]) });
    let removed = 0;
    try {
      await child.waitFor((event) => event.event === "acquired");
      const leases = await createProcessRevisionLeaseStore({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      const service = createRevisionCollectionService({
        state: {} as never,
        inventory: { async discover() { return { scopes: [], complete: true }; } },
        transitions: (() => ({}) as never),
        leases,
        artifacts: { async scan() { return { complete: true, artifacts: [candidate] }; }, async remove() { removed += 1; return "removed"; } },
        retention: { async reconcile({ observed }: { observed: readonly unknown[] }) { return { complete: true, marks: observed.map((value) => ({ reference: value, firstUnreferencedAt: 0 })) }; }, async markRemoved() {} } as never,
        mutations: {} as never,
        sha256,
        clock: { nowEpochMilliseconds: () => 86_400_001, monotonicMilliseconds: () => 0 },
      });
      await service.collect({ policy: { unreferencedGraceMs: 0 } }, signal);
      expect(removed).toBe(0);
      child.send("release");
      await child.waitFor((event) => event.event === "released");
      await waitForExit(child.process);
      await service.collect({ policy: { unreferencedGraceMs: 0 } }, signal);
      expect(removed).toBe(1);
    } finally {
      if (child.process.exitCode === null) child.process.kill("SIGKILL");
      await waitForExit(child.process);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
