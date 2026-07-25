import { describe, expect, it } from "vitest";
import {
  CommittedMutationCleanupError,
  MutationCleanupError,
  createGenerationMutationCoordinator,
} from "../../src/application/generation-mutation-coordinator.js";
import { createKeyedMutationScheduler } from "../../src/infrastructure/state/keyed-mutation-scheduler.js";
import {
  parseStateMutation,
  type GenerationSnapshot,
  type Generation,
  type StateCommitResult,
  type StateLoadResult,
  type VerifiedStateMutation,
} from "../../src/application/state-contract.js";
import type { ScopeLockManager } from "../../src/application/ports/scope-lock.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import { GenerationSchema, HostConfigDocumentSchema } from "../../src/domain/state/config-state.js";
import { InstalledUserStateDocumentSchema } from "../../src/domain/state/installed-state.js";
import { ProjectLocalStateDocumentSchema } from "../../src/domain/state/project-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { createMarketplaceConfigurationRecord } from "../../src/domain/update-policy.js";
import type { ScopeContext, ScopeReference } from "../../src/domain/state/scope.js";
import type { PluginKey } from "../../src/domain/identity.js";
import { MarketplaceSourceSchema } from "../../src/domain/source.js";

const user: ScopeContext = { kind: "user" };
const otherProject: ScopeContext = {
  kind: "project",
  identity: {
    kind: "path-only",
    canonicalRoot: "file:///workspace/other/" as never,
    limitation: "identity-changes-with-canonical-root",
  },
  projectKey: `project-v1:sha256:${"c".repeat(64)}` as never,
};
const plugin = "demo@marketplace" as PluginKey;
const sha256 = () => new Uint8Array(32);
const config = HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: 0, records: [] });

const digest = `sha256:${"0".repeat(64)}`;
const stateBlob = `state-blob-v1:sha256:${"1".repeat(64)}`;

function snapshot(scope: ScopeContext, generation: number): GenerationSnapshot {
  const value = GenerationSchema.parse(generation);
  const scopeReference = scope.kind === "user"
    ? { kind: "user" as const }
    : { kind: "project" as const, projectKey: scope.projectKey };
  const documentKinds = scope.kind === "user"
    ? ["hostConfig", "installedUser", "trust"] as const
    : ["projectLocal"] as const;
  const pointers = StatePointersDocumentSchema.parse({
    schemaVersion: 1,
    scope: scopeReference,
    generation: value,
    documents: documentKinds.map((kind) => ({ kind, generation: value, blob: stateBlob, digest })),
  });
  if (scope.kind === "user") {
    return {
      scope,
      generation: value,
      pointers,
      config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: value, records: [] }),
      installed: InstalledUserStateDocumentSchema.parse({ schemaVersion: 2, generation: value, marketplaces: [], plugins: [] }),
      trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation: value, records: [] }),
      corruptions: [],
    };
  }
  return {
    scope,
    generation: value,
    pointers,
    project: ProjectLocalStateDocumentSchema.parse({
      schemaVersion: 4,
      generation: value,
      projectKey: scope.projectKey,
      identity: scope.identity,
      declarationDigest: digest,
      marketplaces: [],
      plugins: [],
      marketplaceUpdates: [],
    }),
    corruptions: [],
  };
}

function mutation(expectedGeneration = 0, scope: ScopeContext = user): VerifiedStateMutation {
  return parseStateMutation({
    scope,
    expectedGeneration,
    replace: { config: HostConfigDocumentSchema.parse({ ...config, generation: expectedGeneration }) },
  }, sha256);
}

function lockManager(options: Readonly<{
  events: string[];
  releaseError?: unknown;
  owned?: () => boolean;
}>): ScopeLockManager {
  return {
    async acquire(scope: ScopeReference, signal: AbortSignal) {
      options.events.push("lock.acquire");
      return {
        scope,
        async assertOwned(assertSignal: AbortSignal) {
          options.events.push("lock.assert");
          if (assertSignal.aborted) throw assertSignal.reason;
          if (options.owned !== undefined && !options.owned()) throw new Error("lease lost");
          void signal;
        },
        async release() {
          options.events.push("lock.release");
          if (options.releaseError !== undefined) throw options.releaseError;
        },
      };
    },
  };
}

function stateStore(options: Readonly<{
  events: string[];
  loaded?: StateLoadResult;
  commit?: (mutation: VerifiedStateMutation) => Promise<StateCommitResult>;
}>): LifecycleStateStore {
  return {
    async read() {
      options.events.push("state.read");
      return options.loaded ?? { ok: true, snapshot: snapshot(user, 0) };
    },
    async commit(value) {
      options.events.push("state.commit");
      return options.commit?.(value) ?? { kind: "committed", snapshot: snapshot(user, 1) };
    },
  };
}

function coordinator(events: string[], store: LifecycleStateStore, locks?: ScopeLockManager) {
  return createGenerationMutationCoordinator({
    scheduler: createKeyedMutationScheduler(),
    locks: locks ?? lockManager({ events }),
    state: store,
  });
}

describe("generation-guarded prepared mutation coordinator", () => {
  it("returns stale before callback or promotion work", async () => {
    const events: string[] = [];
    let callback = false;
    const service = coordinator(events, stateStore({ events, loaded: { ok: true, snapshot: snapshot(user, 3) } }));
    const result = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => {
        callback = true;
        return { mutation: mutation(), value: "never" };
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "stale-generation", expected: 0, actual: 3 });
    expect(callback).toBe(false);
    expect(events).toEqual(["lock.acquire", "lock.assert", "state.read", "lock.release"]);
  });

  it("keeps the critical order and commits a verified mutation once", async () => {
    const events: string[] = [];
    const service = coordinator(events, stateStore({ events }));
    const result = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async (context) => {
        events.push("callback");
        await context.assertOwned();
        return { mutation: mutation(), value: "promoted" };
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "committed", value: "promoted", snapshot: snapshot(user, 1) });
    expect(events).toEqual([
      "lock.acquire", "lock.assert", "state.read", "lock.assert", "callback", "lock.assert", "lock.assert", "state.commit", "lock.release",
    ]);
  });

  it("runs the final authority guard under the lease and blocks commit on revocation", async () => {
    const events: string[] = [];
    const service = coordinator(events, stateStore({ events }));
    await expect(service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({
        mutation: mutation(),
        value: "blocked",
        async beforeCommit() {
          events.push("authority.revalidate");
          throw new Error("authority revoked");
        },
      }),
      new AbortController().signal,
    )).rejects.toThrow("authority revoked");
    expect(events).toEqual([
      "lock.acquire", "lock.assert", "state.read", "lock.assert", "lock.assert", "authority.revalidate", "lock.release",
    ]);
    expect(events).not.toContain("state.commit");
  });

  it("proves a non-empty adapter config against the verified mutation", async () => {
    const events: string[] = [];
    const before = snapshot(user, 0);
    const record = createMarketplaceConfigurationRecord({
      marketplace: "marketplace",
      source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/plugins" }),
    });
    const after = {
      ...snapshot(user, 1),
      config: HostConfigDocumentSchema.parse({
        ...before.config,
        generation: 1,
        records: [record],
      }),
    };
    const service = coordinator(events, {
      async read() { return { ok: true, snapshot: before }; },
      async commit() { return { kind: "committed", snapshot: after }; },
    });
    const result = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({
        mutation: parseStateMutation({
          scope: user,
          expectedGeneration: 0,
          replace: { config: HostConfigDocumentSchema.parse({ ...before.config, records: [record] }) },
        }, sha256),
        value: "promoted",
      }),
      new AbortController().signal,
    );
    expect(result.kind).toBe("committed");
  });

  it("rejects unverified, wrong-generation, and wrong-scope callback output before commit", async () => {
    const cases: readonly [string, unknown][] = [
      ["unverified", { value: "bad" }],
      ["wrong generation", { mutation: mutation(1), value: "bad" }],
    ];
    for (const [name, output] of cases) {
      const events: string[] = [];
      const service = coordinator(events, stateStore({ events }));
      const result = await service.runPreparedMutation(
        { scope: user, plugins: [plugin], expectedGeneration: 0 },
        async () => output as never,
        new AbortController().signal,
      ).then(() => undefined, (error: unknown) => error);
      expect(result, name).toBeInstanceOf(Error);
      expect(events).not.toContain("state.commit");
    }

    const project = otherProject;
    const wrongScopeEvents: string[] = [];
    const wrongScopeService = coordinator(
      wrongScopeEvents,
      stateStore({ loaded: { ok: true, snapshot: snapshot(project, 0) }, events: wrongScopeEvents }),
    );
    const wrongScope = await wrongScopeService.runPreparedMutation(
      { scope: project, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "bad" }),
      new AbortController().signal,
    ).then(() => undefined, (error: unknown) => error);
    expect(wrongScope).toBeInstanceOf(Error);
    expect(wrongScopeEvents).not.toContain("state.commit");
  });

  it("rejects forged load scope and generation responses before promotion", async () => {
    const wrongScopeEvents: string[] = [];
    const wrongScope = await coordinator(
      wrongScopeEvents,
      stateStore({ events: wrongScopeEvents, loaded: { ok: true, snapshot: snapshot(otherProject, 0) } }),
    ).runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "wrong scope" }),
      new AbortController().signal,
    ).then(() => undefined, (error: unknown) => error);
    expect(wrongScope).toBeInstanceOf(Error);
    expect(wrongScopeEvents).not.toContain("state.commit");

    const wrongGenerationEvents: string[] = [];
    const wrongGeneration = await coordinator(
      wrongGenerationEvents,
      stateStore({ events: wrongGenerationEvents, loaded: { ok: true, snapshot: { scope: user, generation: "not-a-generation" } as never } }),
    ).runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "wrong generation" }),
      new AbortController().signal,
    ).then(() => undefined, (error: unknown) => error);
    expect(wrongGeneration).toBeInstanceOf(Error);
    expect(wrongGenerationEvents).not.toContain("state.commit");
  });

  it("converts a store-level stale response into the typed outer result", async () => {
    const events: string[] = [];
    const service = coordinator(events, stateStore({
      events,
      commit: async () => ({ kind: "stale-generation", expected: 0, actual: 7 }),
    }));
    const result = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "not committed" }),
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "stale-generation", expected: 0, actual: 7 });
  });

  it("reconciles a commit that writes durable state before throwing", async () => {
    const events: string[] = [];
    let generation = 0;
    const commitError = new Error("response lost after write");
    const store: LifecycleStateStore = {
      async read() {
        events.push("state.read");
        return { ok: true, snapshot: snapshot(user, generation) };
      },
      async commit() {
        events.push("state.commit");
        generation = 1;
        throw commitError;
      },
    };
    const service = coordinator(events, store);
    const result = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "reconciled" }),
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "committed", value: "reconciled", snapshot: snapshot(user, 1) });
    expect(events).toEqual([
      "lock.acquire", "lock.assert", "state.read", "lock.assert", "lock.assert", "state.commit", "lock.assert", "state.read", "lock.release",
    ]);
  });

  it("reconciles a commit that writes durable state before cancellation", async () => {
    const events: string[] = [];
    let generation = 0;
    const controller = new AbortController();
    const reason = new Error("commit cancelled after write");
    const service = coordinator(events, {
      async read() {
        return { ok: true, snapshot: snapshot(user, generation) };
      },
      async commit() {
        generation = 1;
        controller.abort(reason);
        throw reason;
      },
    });
    await expect(service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "cancel-reconciled" }),
      controller.signal,
    )).resolves.toEqual({ kind: "committed", value: "cancel-reconciled", snapshot: snapshot(user, 1) });
  });

  it("does not report an unrelated expected-plus-one advance as committed", async () => {
    const events: string[] = [];
    const before = snapshot(user, 0);
    const unrelated = {
      ...snapshot(user, 1),
      config: HostConfigDocumentSchema.parse({
        schemaVersion: 4,
        generation: 1,
        records: [createMarketplaceConfigurationRecord({
          marketplace: "unrelated",
          source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/unrelated" }),
        })],
      }),
    };
    let current: GenerationSnapshot = before;
    const commitError = new Error("response lost after unrelated write");
    const service = coordinator(events, {
      async read() {
        return { ok: true, snapshot: current };
      },
      async commit() {
        current = unrelated;
        throw commitError;
      },
    });
    const result = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "not-proven" }),
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "commit-ambiguous", value: "not-proven", expected: 0, actual: 1 });
  });

  it("preserves ambiguous evidence and classification when release also fails", async () => {
    const events: string[] = [];
    const before = snapshot(user, 0);
    const unrelated = {
      ...snapshot(user, 1),
      config: HostConfigDocumentSchema.parse({
        schemaVersion: 4,
        generation: 1,
        records: [createMarketplaceConfigurationRecord({
          marketplace: "unrelated",
          source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/unrelated" }),
        })],
      }),
    };
    let current: GenerationSnapshot = before;
    const commitError = new Error("ambiguous commit");
    const releaseError = new Error("release also failed");
    const service = coordinator(events, {
      async read() { return { ok: true, snapshot: current }; },
      async commit() { current = unrelated; throw commitError; },
    }, lockManager({ events, releaseError }));
    const error = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "evidence" }),
      new AbortController().signal,
    ).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(MutationCleanupError);
    const cleanup = error as MutationCleanupError;
    expect(cleanup.operationError).toBe(commitError);
    expect(cleanup.cleanupError).toBe(releaseError);
    expect(cleanup.outcome?.kind).toBe("commit-ambiguous");
    expect(cleanup.observedSnapshot).toEqual(unrelated);
  });

  it("does not turn an aborted commit with no durable write into a bare cancellation", async () => {
    const events: string[] = [];
    const reason = new Error("commit cancelled");
    const service = coordinator(events, stateStore({
      events,
      commit: async () => { throw reason; },
    }));
    const result = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "not committed" }),
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "commit-failed", value: "not committed", expected: 0, actual: 0 });
  });

  it("rejects forged committed responses unless authority reconciliation proves expected plus one", async () => {
    for (const forgedSnapshot of [snapshot(user, 9), snapshot(otherProject, 1)]) {
      const events: string[] = [];
      const service = coordinator(events, stateStore({
        events,
        commit: async () => ({ kind: "committed", snapshot: forgedSnapshot }),
      }));
      const result = await service.runPreparedMutation(
        { scope: user, plugins: [plugin], expectedGeneration: 0 },
        async () => ({ mutation: mutation(), value: "forged" }),
        new AbortController().signal,
      );
      expect(result).toEqual({ kind: "commit-failed", value: "forged", expected: 0, actual: 0 });
    }
  });

  it("preserves abort identity when ownership is released before the callback", async () => {
    const events: string[] = [];
    const reason = new Error("deadline");
    const controller = new AbortController();
    let owned = true;
    const service = coordinator(events, stateStore({ events }), lockManager({ events, owned: () => owned }));
    owned = false;
    const result = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "bad" }),
      controller.signal,
    ).then(() => undefined, (error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("lease lost");
    controller.abort(reason);
  });

  it("retains committed evidence when release fails and both failures when work fails", async () => {
    const events: string[] = [];
    const releaseError = new Error("cleanup failed");
    const service = coordinator(events, stateStore({ events }), lockManager({ events, releaseError }));
    const committedFailure = await service.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: 42 }),
      new AbortController().signal,
    ).then(() => undefined, (error: unknown) => error);
    expect(committedFailure).toBeInstanceOf(CommittedMutationCleanupError);
    expect((committedFailure as CommittedMutationCleanupError<number>).committed.value).toBe(42);
    expect((committedFailure as CommittedMutationCleanupError<number>).cause).toBe(releaseError);

    const callbackError = new Error("callback failed");
    const secondEvents: string[] = [];
    const second = coordinator(secondEvents, stateStore({ events: secondEvents }), lockManager({ events: secondEvents, releaseError }));
    const workFailure = await second.runPreparedMutation(
      { scope: user, plugins: [plugin], expectedGeneration: 0 },
      async () => { throw callbackError; },
      new AbortController().signal,
    ).then(() => undefined, (error: unknown) => error);
    expect(workFailure).toBeInstanceOf(MutationCleanupError);
    expect((workFailure as MutationCleanupError).operationError).toBe(callbackError);
    expect((workFailure as MutationCleanupError).cleanupError).toBe(releaseError);
  });

  it("rejects duplicate plugins before acquiring a lock and allows an explicit empty scope mutation", async () => {
    const events: string[] = [];
    const service = coordinator(events, stateStore({ events }));
    await expect(service.runPreparedMutation(
      { scope: user, plugins: [plugin, plugin], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "bad" }),
      new AbortController().signal,
    )).rejects.toThrow(/unique/);
    expect(events).toEqual([]);

    const result = await service.runPreparedMutation(
      { scope: user, plugins: [], expectedGeneration: 0 },
      async () => ({ mutation: mutation(), value: "scope" }),
      new AbortController().signal,
    );
    expect(result.kind).toBe("committed");
  });
});
