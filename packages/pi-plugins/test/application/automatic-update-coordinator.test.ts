import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAutomaticUpdateCoordinator } from "../../src/application/automatic-update-coordinator.js";
import { createMarketplaceConfigurationRecord, deriveMarketplaceSourceIdentity, derivePluginSourceIdentity, deriveUpdateCandidateKey } from "../../src/domain/update-policy.js";
import { deriveMarketplaceRegistrationId } from "../../src/domain/marketplace-registration.js";
import { deriveUpdateNoticeId } from "../../src/application/native-update-identifiers.js";
import { ContentDigestSchema } from "../../src/domain/content-manifest.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const scope = { kind: "user" as const };
const source = { kind: "github" as const, repository: "example/community" };
const marketplaceIdentity = deriveMarketplaceSourceIdentity(source, sha256);
const pluginIdentity = derivePluginSourceIdentity({ kind: "git", url: "https://example.com/demo.git" }, sha256);

function environment(noticeCount = 1, application: "automatic" | "manual" = "automatic") {
  const notices = ["b", "c"].slice(0, noticeCount).map((suffix, index) => {
    const plugin = `${index === 0 ? "demo" : "second"}@community` as const;
    const immutableRevision = ContentDigestSchema.parse(`sha256:${suffix.repeat(64)}`);
    const candidate = deriveUpdateCandidateKey({ scope, plugin, marketplaceSourceIdentity: marketplaceIdentity, pluginSourceIdentity: pluginIdentity, immutableRevision }, sha256);
    return {
      id: deriveUpdateNoticeId({ scope, plugin, candidate }, sha256),
      scope,
      plugin,
      registrationId: deriveMarketplaceRegistrationId({ scope, source }, sha256),
      snapshot: `marketplace-snapshot-v1:sha256:${suffix.repeat(64)}`,
      candidateId: `marketplace-candidate-v1:sha256:${suffix.repeat(64)}`,
      candidate,
      available: { immutableRevision, marketplaceSourceIdentity: marketplaceIdentity, pluginSourceIdentity: pluginIdentity, sourceRevision: suffix.repeat(40) },
      display: { installed: "1.0.0", available: "1.1.0" },
      disposition: "automatic-pending" as const,
      publication: "pending" as const,
      unread: true,
      discoveredAt: index + 1,
      automatic: { state: "pending" as const },
    };
  });
  const ids = notices.map((notice) => notice.id);
  const id = ids[0]!;
  let generation = 0;
  let record: any = createMarketplaceConfigurationRecord({
    marketplace: "community", source, applicationOverride: "automatic", notices,
  });
  const snapshot = () => ({ scope, generation, config: { schemaVersion: 4, generation, global: { application: "manual", cadence: "balanced" }, scope: {}, records: [record] }, installed: { schemaVersion: 2, generation, marketplaces: [], plugins: [] }, trust: { schemaVersion: 1, generation, records: [] }, pointers: { schemaVersion: 1, scope, generation, documents: [] }, corruptions: [] }) as any;
  let authority: any = { candidate: "current", source: "stable", target: "current", project: "trusted", recovery: "clear", configuration: "valid", secrets: "available", capability: "available" };
  let lifecycleResult: any = { kind: "staged" };
  let applyCalls = 0;
  let stageCalls = 0;
  let onApply: (() => void) | undefined;
  const mutationSignals: AbortSignal[] = [];
  const ensureCalls: string[] = [];
  const ensureSignals: (AbortSignal | undefined)[] = [];
  let onEnsure: (() => void) | undefined;
  const dependencies = {
    state: { async read() { return { ok: true as const, snapshot: snapshot() }; } },
    inventory: { async discover() { return { scopes: [scope], complete: true }; } },
    mutations: { async runPreparedMutation(_request: any, prepare: any, mutationSignal: AbortSignal) { mutationSignals.push(mutationSignal); const prepared = await prepare({ snapshot: snapshot(), assertOwned: async () => undefined }); record = prepared.mutation.replace.config.records[0]; generation += 1; return { kind: "committed", value: prepared.value, snapshot: snapshot() }; } },
    policy: { async resolve() { return { application, winningLevel: "marketplace" as const, sourceGuard: "none" as const }; } },
    lifecycle: {
      async inspect() { return authority; },
      async apply() { applyCalls += 1; onApply?.(); return lifecycleResult; },
      async stage() { stageCalls += 1; onApply?.(); return lifecycleResult; },
    },
    continuity: { async ensure(ensureScope: any, ensureSignal?: AbortSignal) { ensureCalls.push(ensureScope.kind === "user" ? "user" : ensureScope.projectKey); ensureSignals.push(ensureSignal); onEnsure?.(); return { kind: "ensured" as const, granted: [] }; } },
    clock: { nowEpochMilliseconds: () => 100, monotonicMilliseconds: () => 100 }, sha256,
  } as any;
  return {
    id, service: createAutomaticUpdateCoordinator(dependencies),
    setAuthority(value: Partial<typeof authority>) { authority = { ...authority, ...value }; },
    setResult(value: any) { lifecycleResult = value; },
    ids,
    setRetryAt(retryAt: number) { record = { ...record, notices: record.notices.map((notice: any, index: number) => index === 0 ? { ...notice, disposition: "automatic-retryable", automatic: { state: "retryable", reason: "retryable", attemptedAt: 50, retryAt } } : notice) }; },
    acknowledgeDuringApply() { onApply = () => { record = { ...record, notices: record.notices.map((notice: any, index: number) => index === 0 ? { ...notice, unread: false, acknowledgedAt: 99 } : notice) }; }; },
    onApply(hook: () => void) { onApply = hook; },
    onEnsure(hook: () => void) { onEnsure = hook; },
    ensureCalls,
    ensureSignals,
    mutationSignals,
    notice: () => record.notices[0], applyCalls: () => applyCalls, stageCalls: () => stageCalls,
  };
}

describe("automatic update coordinator", () => {
  it("stages without any reload-capable context and resolves the notice", async () => {
    const env = environment();
    await expect(env.service.evaluate({ noticeId: env.id }, signal)).resolves.toMatchObject({ kind: "eligible" });
    await expect(env.service.run({ noticeIds: [env.id], limit: 1 }, signal)).resolves.toMatchObject({ outcomes: [{ kind: "staged", plugin: "demo@community" }] });
    expect(env.stageCalls()).toBe(1);
    expect(env.applyCalls()).toBe(0);
    expect(env.notice()).toMatchObject({ disposition: "automatic-applied", resolution: { kind: "installed" } });
  });

  it.each([
    [{ source: "changed" }, "approval-required"],
    [{ candidate: "stale" }, "stale"],
    [{ target: "stale" }, "stale"],
    [{ project: "untrusted" }, "project-untrusted"],
    [{ recovery: "required" }, "recovery-required"],
    [{ configuration: "required" }, "configuration-required"],
    [{ secrets: "unavailable" }, "secret-unavailable"],
    [{ capability: "unavailable" }, "capability-unavailable"],
  ] as const)("rechecks trust/root/configuration/capability drift %j", async (drift, expected) => {
    const env = environment();
    env.setAuthority(drift);
    await expect(env.service.evaluate({ noticeId: env.id }, signal)).resolves.toMatchObject({ kind: expected });
    expect(env.stageCalls()).toBe(0);
    expect(env.applyCalls()).toBe(0);
  });

  it("honors persisted retry backoff before inspecting or applying lifecycle", async () => {
    const env = environment();
    env.setRetryAt(200);
    await expect(env.service.run({ noticeIds: [env.id], limit: 1 }, signal)).resolves.toMatchObject({ outcomes: [{ kind: "retryable" }] });
    expect(env.stageCalls()).toBe(0);
    expect(env.notice()).toMatchObject({ automatic: { retryAt: 200 } });
  });

  it("lets explicit foreground Update All bypass manual policy while retaining lifecycle safety", async () => {
    const env = environment(1, "manual");
    await expect(env.service.run({ noticeIds: [env.id], limit: 1 }, signal)).resolves.toMatchObject({ outcomes: [{ kind: "blocked", reason: "manual" }] });
    expect(env.stageCalls()).toBe(0);

    const explicit = environment(1, "manual");
    await expect(explicit.service.run({ noticeIds: [explicit.id], limit: 1, explicit: true }, signal)).resolves.toMatchObject({ outcomes: [{ kind: "staged" }] });
    expect(explicit.stageCalls()).toBe(1);
  });

  it("stages every eligible candidate in one run without spending reload authority", async () => {
    const env = environment(2);
    await expect(env.service.run({ noticeIds: env.ids, limit: 2 }, signal)).resolves.toMatchObject({
      outcomes: [{ kind: "staged" }, { kind: "staged" }],
    });
    expect(env.stageCalls()).toBe(2);
    expect(env.applyCalls()).toBe(0);
  });

  it("apply mode drives immediate activation through the lifecycle authority", async () => {
    const env = environment();
    env.setResult({ kind: "changed" });
    await expect(env.service.run({ noticeIds: [env.id], limit: 1, mode: "apply" }, signal)).resolves.toMatchObject({ outcomes: [{ kind: "applied" }] });
    expect(env.applyCalls()).toBe(1);
    expect(env.stageCalls()).toBe(0);
    expect(env.notice()).toMatchObject({ disposition: "automatic-applied", unread: true, resolution: { kind: "installed" } });
  });

  it("does not revert a concurrent acknowledgment when lifecycle completion commits", async () => {
    const env = environment();
    env.acknowledgeDuringApply();
    await env.service.run({ noticeIds: [env.id], limit: 1 }, signal);
    expect(env.notice()).toMatchObject({ unread: false, acknowledgedAt: 99, resolution: { kind: "installed" } });
  });

  it.each([
    [{ kind: "staged" }, "staged", "automatic-applied"],
    [{ kind: "rolled-back" }, "retryable", "automatic-retryable"],
    [{ kind: "recovery-required" }, "recovery-required", "recovery-required"],
  ] as const)("settles lifecycle %s truth with a fresh signal after caller abort", async (result, outcome, disposition) => {
    const env = environment();
    const controller = new AbortController();
    env.setResult(result);
    env.onApply(() => controller.abort(new Error("caller stopped after possible commit")));
    await expect(env.service.run({ noticeIds: [env.id], limit: 1 }, controller.signal)).resolves.toMatchObject({ outcomes: [{ kind: outcome }] });
    expect(env.notice()).toMatchObject({ disposition });
    expect(env.mutationSignals.at(-1)?.aborted).toBe(false);
  });

  it("excludes historical project scopes before any coordinator state read", async () => {
    const identityA = { kind: "path-only" as const, canonicalRoot: "file:///project-a/" as never, limitation: "identity-changes-with-canonical-root" as const };
    const identityB = { kind: "path-only" as const, canonicalRoot: "file:///project-b/" as never, limitation: "identity-changes-with-canonical-root" as const };
    const projectA = { kind: "project" as const, identity: identityA, projectKey: `project-v1:sha256:${"a".repeat(64)}` as never };
    const projectB = { kind: "project" as const, identity: identityB, projectKey: `project-v1:sha256:${"b".repeat(64)}` as never };
    const reads: string[] = [];
    const service = createAutomaticUpdateCoordinator({
      state: { async read(context: typeof scope | typeof projectA | typeof projectB) {
        reads.push(context.kind === "user" ? "user" : context.projectKey);
        if (context.kind === "project" && context.projectKey === projectA.projectKey) throw new Error("historical project must not be read");
        return context.kind === "user"
          ? { ok: true as const, snapshot: { scope, config: { records: [] } } as never }
          : { ok: true as const, snapshot: { scope: projectB, project: { marketplaceUpdates: [] } } as never };
      } },
      inventory: { async discover() { return { scopes: [scope, projectA, projectB], complete: true }; } },
      mutations: {} as never, policy: {} as never, lifecycle: {} as never,
      clock: { nowEpochMilliseconds: () => 1, monotonicMilliseconds: () => 1 }, sha256,
      currentProject: projectB,
      projectTrust: { async assess(key) { return { kind: key === projectB.projectKey ? "trusted" as const : "untrusted" as const }; } },
      async revalidateCurrentProject() { return { identity: identityB, projectKey: projectB.projectKey, trust: { kind: "trusted" as const } }; },
    });
    await expect(service.nextRetryAt(signal)).resolves.toBeUndefined();
    expect(reads).toEqual(["user", projectB.projectKey]);
  });

  it("preserves unresolved state on concurrent stale/rollback and reports recovery authority", async () => {
    const env = environment();
    env.setResult({ kind: "stale" });
    await expect(env.service.run({ noticeIds: [env.id], limit: 1 }, signal)).resolves.toMatchObject({ outcomes: [{ kind: "stale" }] });
    expect(env.notice().resolution).toBeUndefined();

    const recovery = environment();
    recovery.setResult({ kind: "recovery-required" });
    await recovery.service.run({ noticeIds: [recovery.id], limit: 1 }, signal);
    expect(recovery.notice()).toMatchObject({ disposition: "recovery-required" });
    expect(recovery.notice().resolution).toBeUndefined();
  });

  it("runs trust continuity for every authorized context even without notices", async () => {
    const env = environment(0);
    await expect(env.service.run({ limit: 1 }, signal)).resolves.toMatchObject({ outcomes: [] });
    expect(env.ensureCalls).toEqual(["user"]);
  });

  it("chains trust continuity after a committed stage but not after stale or rejected outcomes", async () => {
    const staged = environment();
    await staged.service.run({ noticeIds: [staged.id], limit: 1 }, signal);
    expect(staged.ensureCalls).toEqual(["user", "user"]);
    // The post-commit chain must not inherit caller cancellation: the update
    // has already committed, so continuity settles with a fresh signal.
    expect(staged.ensureSignals[0]).toBe(signal);
    expect(staged.ensureSignals[1]).not.toBe(signal);
    expect(staged.ensureSignals[1]?.aborted).toBe(false);

    const stale = environment();
    stale.setResult({ kind: "stale" });
    await stale.service.run({ noticeIds: [stale.id], limit: 1 }, signal);
    expect(stale.ensureCalls).toEqual(["user"]);

    const rejected = environment();
    rejected.setResult({ kind: "rejected", code: "UNTRUSTED" });
    await rejected.service.run({ noticeIds: [rejected.id], limit: 1 }, signal);
    expect(rejected.ensureCalls).toEqual(["user"]);
  });

  it("continues notice processing when trust continuity fails", async () => {
    const env = environment();
    let calls = 0;
    env.onEnsure(() => { calls += 1; throw new Error("continuity unavailable"); });
    await expect(env.service.run({ noticeIds: [env.id], limit: 1 }, signal)).resolves.toMatchObject({ outcomes: [{ kind: "staged" }] });
    expect(calls).toBe(2);
    expect(env.stageCalls()).toBe(1);
  });
});
