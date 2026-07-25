import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNativeUpdatePolicyService } from "../../src/application/native-update-policy-service.js";
import { GenerationSchema, HostConfigDocumentSchema } from "../../src/domain/state/config-state.js";
import { ProjectLocalStateDocumentSchema } from "../../src/domain/state/project-state.js";
import { createMarketplaceConfigurationRecord } from "../../src/domain/update-policy.js";
import { deriveMarketplaceRegistrationId } from "../../src/domain/marketplace-registration.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import { createUpdateSchedulerStatusProjection } from "../../src/application/update-scheduler-status.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

function environment(records: readonly unknown[] = []) {
  let generation = 0;
  let config = HostConfigDocumentSchema.parse({
    schemaVersion: 4,
    generation: GenerationSchema.parse(0),
    global: { application: "manual", cadence: "balanced" },
    scope: {},
    records,
  });
  let readCount = 0;
  let advanceAtRead: number | undefined;
  const snapshot = () => ({
    scope: { kind: "user" as const },
    generation: GenerationSchema.parse(generation),
    pointers: { schemaVersion: 1, scope: { kind: "user" }, generation, documents: [] },
    config,
    installed: { schemaVersion: 2, generation, marketplaces: [], plugins: [] },
    trust: { schemaVersion: 1, generation, records: [] },
    corruptions: [],
  }) as any;
  const state = { async read() {
    readCount += 1;
    if (readCount === advanceAtRead) {
      generation += 1;
      config = HostConfigDocumentSchema.parse({ ...config, generation, scope: { application: "automatic" } });
    }
    return { ok: true as const, snapshot: snapshot() };
  } };
  const mutations = {
    async runPreparedMutation(request: any, prepare: any) {
      if (request.expectedGeneration !== generation) return { kind: "stale-generation" as const, expected: request.expectedGeneration, actual: generation };
      const prepared = await prepare({ snapshot: snapshot(), assertOwned: async () => undefined });
      await prepared.beforeCommit?.();
      generation += 1;
      config = HostConfigDocumentSchema.parse({ ...prepared.mutation.replace.config, generation });
      return { kind: "committed" as const, value: prepared.value, snapshot: snapshot() };
    },
  };
  const dependencies = {
    state, mutations,
    inventory: { async discover() { return { scopes: [{ kind: "user" as const }], complete: true }; } },
    sha256,
    clock: { nowEpochMilliseconds: () => 100, monotonicMilliseconds: () => 100 },
  } as any;
  return {
    service: createNativeUpdatePolicyService(dependencies),
    dependencies,
    config: () => config,
    advanceAfterReads(count: number) { advanceAtRead = readCount + count; },
  };
}

describe("native update policy service", () => {
  it("previews automatic breadth, requires exact consent, and applies through CAS", async () => {
    const env = environment();
    const change = { kind: "application" as const, target: { kind: "global" as const }, mode: "automatic" as const };
    const result = await env.service.preview(change, signal);
    expect(result.kind).toBe("previewed");
    if (result.kind !== "previewed") return;
    expect(result.preview.consent).toMatchObject({ required: true, disclosure: "global-current-and-future" });
    await expect(env.service.apply({ change, expectedPreviewId: result.preview.previewId }, signal)).resolves.toMatchObject({ kind: "rejected", code: "CONSENT_REQUIRED" });
    await expect(env.service.apply({ change, expectedPreviewId: result.preview.previewId, consent: { kind: "grant", consentId: result.preview.consent.consentId! } }, signal)).resolves.toMatchObject({ kind: "changed" });
    expect(env.config().global.application).toBe("automatic");
  });

  it("allows marketplace policy before any plugin from that marketplace is installed", async () => {
    const source = { kind: "github" as const, repository: "example/community" };
    const env = environment([createMarketplaceConfigurationRecord({ marketplace: "community", source })]);
    const change = {
      kind: "application" as const,
      target: { kind: "marketplace" as const, scope: { kind: "user" as const }, registrationId: deriveMarketplaceRegistrationId({ scope: { kind: "user" }, source }, sha256) },
      mode: "manual" as const,
    };
    const preview = await env.service.preview(change, signal);
    expect(preview.kind).toBe("previewed");
    if (preview.kind !== "previewed") return;
    await expect(env.service.apply({ change, expectedPreviewId: preview.preview.previewId }, signal)).resolves.toMatchObject({ kind: "changed" });
  });

  it("rejects an authority race between the apply-time preview and mutation read", async () => {
    const env = environment();
    const change = { kind: "cadence" as const, target: { kind: "global" as const }, cadence: "frequent" as const };
    const preview = await env.service.preview(change, signal);
    if (preview.kind !== "previewed") throw new Error("expected preview");
    env.advanceAfterReads(2);
    await expect(env.service.apply({ change, expectedPreviewId: preview.preview.previewId }, signal))
      .resolves.toMatchObject({ kind: "stale", reason: "generation" });
    expect(env.config().global.cadence).toBe("balanced");
  });

  it.each(["project", "trust"] as const)("binds project CAS to the real authority epoch and returns typed %s staleness with zero writes", async (drift) => {
    let generation = 0;
    let commits = 0;
    const identity = { kind: "path-only" as const, canonicalRoot: "file:///project-a/" as never, limitation: "identity-changes-with-canonical-root" as const };
    const changedIdentity = { ...identity, canonicalRoot: "file:///project-b/" as never };
    const projectKey = deriveProjectKey(identity, sha256);
    const projectScope = { kind: "project" as const, identity, projectKey };
    const userSnapshot = () => ({ scope: { kind: "user" as const }, generation: 0, config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: 0, global: { application: "manual", cadence: "balanced" }, scope: {}, records: [] }), installed: { plugins: [] }, trust: { records: [] }, pointers: { generation: 0, scope: { kind: "user" }, documents: [] }, corruptions: [] }) as never;
    const projectSnapshot = () => ({ scope: projectScope, generation, project: ProjectLocalStateDocumentSchema.parse({ schemaVersion: 4, generation, projectKey, identity, declarationDigest: `sha256:${"b".repeat(64)}`, scope: {}, marketplaces: [], plugins: [], marketplaceUpdates: [] }), pointers: { generation, scope: { kind: "project", projectKey }, documents: [] }, corruptions: [] }) as never;
    let currentIdentity = identity;
    let currentTrust: "trusted" | "untrusted" = "trusted";
    const service = createNativeUpdatePolicyService({
      state: { async read(context) { return { ok: true as const, snapshot: context.kind === "user" ? userSnapshot() : projectSnapshot() }; } },
      inventory: { async discover() { return { scopes: [{ kind: "user" as const }, projectScope], complete: true }; } },
      mutations: { async runPreparedMutation(_request, prepare) {
        const prepared = await prepare({ snapshot: projectSnapshot(), assertOwned: async () => undefined });
        if (drift === "project") currentIdentity = changedIdentity;
        else currentTrust = "untrusted";
        await prepared.beforeCommit?.();
        commits += 1;
        generation += 1;
        return { kind: "committed" as const, value: prepared.value, snapshot: projectSnapshot() };
      } },
      sha256, clock: { nowEpochMilliseconds: () => 100, monotonicMilliseconds: () => 100 },
      currentProject: projectScope,
      projectTrust: { async assess() { return { kind: currentTrust }; } },
      async revalidateCurrentProject() { return { identity: currentIdentity, projectKey, trust: { kind: currentTrust } }; },
    } as never);
    const change = { kind: "application" as const, target: { kind: "scope" as const, scope: { kind: "project" as const, projectKey } }, mode: "manual" as const };
    const preview = await service.preview(change, signal);
    if (preview.kind !== "previewed") throw new Error("expected project preview");
    await expect(service.apply({ change, expectedPreviewId: preview.preview.previewId }, signal)).resolves.toMatchObject({ kind: "stale", reason: drift });
    expect(commits).toBe(0);
  });

  it("makes a reused preview stale after another process commits", async () => {
    const env = environment();
    const second = createNativeUpdatePolicyService(env.dependencies);
    const change = { kind: "cadence" as const, target: { kind: "global" as const }, cadence: "frequent" as const };
    const preview = await env.service.preview(change, signal);
    if (preview.kind !== "previewed") throw new Error("expected preview");
    await expect(env.service.apply({ change, expectedPreviewId: preview.preview.previewId }, signal)).resolves.toMatchObject({ kind: "changed" });
    await expect(second.apply({ change, expectedPreviewId: preview.preview.previewId }, signal)).resolves.toMatchObject({ kind: "stale", reason: "preview" });
  });

  it("uses the shared scheduler projection for self ownership", async () => {
    const env = environment();
    const schedulerStatus = createUpdateSchedulerStatusProjection();
    schedulerStatus.publish({ state: "running", scopes: [{ scope: { kind: "user" }, ownership: "self", nextAt: 500 }] });
    const service = createNativeUpdatePolicyService({ ...env.dependencies, schedulerStatus });
    await expect(service.status({ scope: "all-current" }, signal)).resolves.toMatchObject({
      scopes: [{ ownership: "self", nextAt: 500 }],
    });
  });

  it("reports network-free global and lease-safe status", async () => {
    const env = environment();
    await expect(env.service.status({ scope: "all-current" }, signal)).resolves.toMatchObject({
      global: { application: "manual", cadence: "balanced" },
      scopes: [{ ownership: "none", clock: "current" }],
      inventoryComplete: true,
    });
  });
});
