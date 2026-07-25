import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeLifecycleOperationService } from "../../src/application/native-lifecycle-operation-service.js";
import { NativeLifecycleConfigurationRecoveryError } from "../../src/application/native-lifecycle-operation.js";
import { CandidateContentCleanupError } from "../../src/application/ports/candidate-content-lease.js";

const digest = (value: string) => `sha256:${value.repeat(64)}` as never;
const request = {
  operation: "disable" as const,
  target: { inspectionSnapshotId: `inspection-snapshot-v1:sha256:${"1".repeat(64)}` as never, detailId: `inspection-detail-v1:e30.${"2".repeat(64)}` as never },
};
const binding = {
  scope: { kind: "user" as const }, plugin: "demo@market" as never, stateGeneration: 0 as never,
  selectedRevision: digest("3"), activation: "enabled" as const, targetDigest: digest("4"),
  inspectionSnapshotId: request.target.inspectionSnapshotId, detailId: request.target.detailId, transition: "none" as const,
};
const target = { binding, expectation: { generation: 0, plugin: binding.plugin, selectedRevision: binding.selectedRevision, activation: binding.activation, targetDigest: binding.targetDigest, pendingTransition: "none" }, scope: { kind: "user" }, record: {}, snapshot: {}, capabilityDigest: digest("5") } as any;
const safe = (text: string) => ({ text, escaped: false, truncated: false });
function cancellableUpdate(release: () => Promise<void>) {
  const candidateBinding = {
    scope: { kind: "user" as const },
    registrationId: `marketplace-registration-v1:sha256:${"1".repeat(64)}`,
    candidateId: `marketplace-candidate-v1:sha256:${"2".repeat(64)}`,
    catalogSnapshot: `marketplace-snapshot-v1:sha256:${"3".repeat(64)}`,
    plugin: binding.plugin,
    sourceIdentity: digest("4"), immutableRevision: digest("5"), contentDigest: digest("6"),
    compatibilityFingerprint: digest("7"), configurationDescriptorDigest: digest("8"), consentDisclosureDigest: digest("f"),
    trustSubject: `trust-subject-v1:sha256:${"9".repeat(64)}`,
    executableSurfaceDigest: digest("a"), capabilityDigest: digest("b"),
  };
  const components = { counts: { skills: 0, hooks: 0, mcpServers: 0, foreign: 0 }, skills: [], hooks: [], mcpServers: [], foreign: [] };
  const consent = {
    consentId: `trusted-install-consent-v1:sha256:${"c".repeat(64)}`,
    source: { kind: "git" as const, identity: digest("4"), endpoint: { scheme: "https" as const, host: safe("example.invalid"), path: safe("/plugin.git"), queryPresent: false, fragmentPresent: false } },
    immutableRevision: digest("5"), executableSurfaceDigest: digest("a"), components, requirements: [], persistentData: true as const,
    configurationEnvironmentNames: [], subagentInterception: "not-declared" as const, remoteMcpDiscovery: "not-performed" as const,
    statement: safe("Grant exact trust"),
  };
  return {
    target,
    candidate: { binding: candidateBinding, fields: [], consent, detail: { diagnostics: [] }, trust: {}, plugin: { configuration: { options: [] } }, lease: { release } },
    binding: { updateCandidate: `update-candidate-v1:sha256:${"d".repeat(64)}`, target: binding, candidate: candidateBinding },
  } as any;
}

function harness(execute?: any, updates?: any) {
  let monotonic = 0;
  const executor = execute ?? vi.fn(async (context: any) => ({ kind: "current-state", operation: context.operation, previewId: context.previewId, progress: [], diagnostics: [], effects: { state: "unchanged", projectFile: "unchanged", completedActionIds: [], pendingActionIds: [] }, reason: "already-disabled", target: context.target.binding }));
  const composed = createNativeLifecycleOperationService({
    targets: { async resolve() { return { kind: "ready" as const, target }; }, async validate() { return { kind: "ready" as const, target }; } },
    updates: updates ?? { async acquire() { return { kind: "rejected" as const, reason: "candidate" as const }; }, async validate() { return { kind: "rejected" as const, reason: "candidate" as const }; } },
    lifecycle: { execute: executor },
    configurationAuthority: { async readCurrent() { return { kind: "missing" as const }; }, async readExact() { return { kind: "missing" as const }; } },
    sync: { async preview() { return { kind: "rejected" as const, code: "ADAPTER_FAILED" as const }; }, async apply() { throw new Error("not used"); } },
    clock: { nowEpochMilliseconds: () => 1_000 as never, monotonicMilliseconds: () => monotonic },
    sessionIds: { async create() { return randomUUID() as never; } },
    hostEpoch: digest("6"),
    sha256: (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest()),
  } as any);
  return { ...composed, execute: executor, advance(value: number) { monotonic += value; } };
}

const signal = new AbortController().signal;

describe("native lifecycle operation facade", () => {
  it("makes preview/apply and explicit-decision run use the same executor", async () => {
    const value = harness();
    const opened = await value.application.preview(request, signal);
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;
    const confirmation = { kind: "confirm" as const, previewId: opened.session.preview.previewId, expectedVersion: opened.session.version, operation: "disable" as const };
    expect(await value.application.apply({ token: opened.session.token, confirmation }, {}, signal)).toMatchObject({ kind: "current-state" });
    expect(await value.application.run(request, { decisionProvider: async (session) => ({ kind: "confirm", previewId: session.preview.previewId, expectedVersion: session.version, operation: "disable" }) }, signal)).toMatchObject({ kind: "current-state" });
    expect(value.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects stale confirmation before mutation and gives one concurrent apply owner", async () => {
    let resolve!: (result: any) => void;
    const execution = vi.fn((context: any) => new Promise((done) => { resolve = (result) => done(result ?? { kind: "current-state", operation: context.operation, previewId: context.previewId, progress: [], diagnostics: [], effects: { state: "unchanged", projectFile: "unchanged", completedActionIds: [], pendingActionIds: [] }, reason: "already-disabled", target: context.target.binding }); }));
    const value = harness(execution);
    const opened = await value.application.preview(request, signal);
    if (opened.kind !== "opened") throw new Error("preview fixture failed");
    const stale = { kind: "confirm" as const, previewId: opened.session.preview.previewId, expectedVersion: 99, operation: "disable" as const };
    expect(await value.application.apply({ token: opened.session.token, confirmation: stale }, {}, signal)).toMatchObject({ kind: "stale", reason: "session" });
    expect(execution).not.toHaveBeenCalled();
    const confirmation = { ...stale, expectedVersion: 0 };
    const owner = value.application.apply({ token: opened.session.token, confirmation }, {}, signal);
    await Promise.resolve();
    expect(await value.application.apply({ token: opened.session.token, confirmation }, {}, signal)).toMatchObject({ kind: "conflict", reason: "operation-in-progress" });
    resolve(undefined);
    expect(await owner).toMatchObject({ kind: "current-state" });
    expect(execution).toHaveBeenCalledOnce();
  });

  it("preserves recovery evidence when cancellation arrives after admitted execution", async () => {
    let resolve!: (result: any) => void;
    const execution = vi.fn((context: any) => new Promise((done) => { resolve = done; }));
    const value = harness(execution);
    const opened = await value.application.preview(request, signal);
    if (opened.kind !== "opened") throw new Error("preview fixture failed");
    const applying = value.application.apply({ token: opened.session.token, confirmation: { kind: "confirm", previewId: opened.session.preview.previewId, expectedVersion: 0, operation: "disable" } }, {}, signal);
    await Promise.resolve();
    expect(await value.application.cancel({ token: opened.session.token }, signal)).toMatchObject({ kind: "accepted", state: "applying" });
    resolve({ kind: "recovery-required", operation: "disable", previewId: opened.session.preview.previewId, progress: [], diagnostics: [], effects: { state: "unknown", projectFile: "unchanged", completedActionIds: [], pendingActionIds: [] }, code: "PENDING_TRANSITION", action: "run-recovery" });
    expect(await applying).toMatchObject({ kind: "recovery-required" });
  });

  it("classifies cancellation by the last safe phase and never cancels after a durable phase starts", async () => {
    const runAt = async (phase: "authority-revalidation" | "lifecycle-transaction") => {
      const value = harness(async (_context: unknown, _confirmation: unknown, options: any, executionSignal: AbortSignal) => {
        await options.onProgress({ sequence: 0, operation: "disable", phase, state: "started", plugin: binding.plugin });
        throw executionSignal.reason;
      });
      const opened = await value.application.preview(request, signal);
      if (opened.kind !== "opened") throw new Error("preview fixture failed");
      const controller = new AbortController();
      controller.abort(new DOMException("cancelled", "AbortError"));
      const result = await value.application.apply({
        token: opened.session.token,
        confirmation: { kind: "confirm", previewId: opened.session.preview.previewId, expectedVersion: 0, operation: "disable" },
      }, {}, controller.signal);
      await value.close();
      return result;
    };

    expect(await runAt("authority-revalidation")).toMatchObject({ kind: "cancelled", phase: "authority-revalidation" });
    expect(await runAt("lifecycle-transaction")).toMatchObject({ kind: "failed", code: "ADAPTER_FAILED" });
  });

  it("retains candidate cleanup authority from update preview and retries it on close", async () => {
    const retry = vi.fn(async () => undefined);
    const value = harness(undefined, {
      async acquire() { return { kind: "cleanup-failed" as const, cleanup: { retry } as never }; },
      async validate() { throw new Error("not used"); },
    });
    const result = await value.application.preview({ operation: "update", target: request.target, candidate: request.target }, signal);
    expect(result).toEqual({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] });
    expect(retry).not.toHaveBeenCalled();
    await value.close();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("rejects update confirmation when its exact configuration/trust authority differs from preview", async () => {
    const release = vi.fn(async () => undefined);
    const update = cancellableUpdate(release);
    const value = harness(undefined, {
      async acquire() { return { kind: "ready" as const, update }; },
      async validate() { return { kind: "ready" as const, update }; },
    });
    const opened = await value.application.preview({ operation: "update", target: request.target, candidate: request.target }, signal);
    if (opened.kind !== "opened" || opened.session.preview.update === undefined) throw new Error("update authority preview failed");
    const authority = opened.session.preview.update.authority;
    const stale = await value.application.apply({
      token: opened.session.token,
      confirmation: {
        kind: "confirm-update",
        previewId: opened.session.preview.previewId,
        expectedVersion: opened.session.version,
        input: { nonSensitive: [], sensitive: [], consent: { kind: "grant", consentId: opened.session.preview.update.consent.consentId }, authority: { ...authority, trustFingerprint: digest("e") } },
      },
    }, {}, signal);
    expect(stale).toMatchObject({ kind: "stale", reason: "session", effects: { state: "unchanged" } });
    expect(value.execute).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await value.application.cancel({ token: opened.session.token }, signal);
    await value.close();
  });

  it("routes preview cancellation through owned release and retries cleanup from status", async () => {
    let releases = 0;
    const release = vi.fn(async () => { releases += 1; if (releases === 1) throw new Error("first cleanup failed"); });
    const update = cancellableUpdate(release);
    const value = harness(undefined, {
      async acquire() { return { kind: "ready" as const, update }; },
      async validate() { return { kind: "ready" as const, update }; },
    });
    const opened = await value.application.preview({ operation: "update", target: request.target, candidate: request.target }, signal);
    if (opened.kind !== "opened") throw new Error("update cancellation preview failed");
    expect(await value.application.cancel({ token: opened.session.token }, signal)).toEqual({ kind: "accepted", state: "failed" });
    expect(release).toHaveBeenCalledOnce();
    const status = await value.application.status({ token: opened.session.token }, signal);
    expect(status).toMatchObject({ kind: "found", result: { kind: "failed", code: "CLEANUP_FAILED" } });
    expect(release).toHaveBeenCalledTimes(2);
    await value.close();
  });

  it("classifies typed lifecycle cleanup failures and retains their retry capability", async () => {
    const retry = vi.fn(async () => undefined);
    const recovery = { retry } as never;
    const value = harness(async () => { throw new CandidateContentCleanupError(recovery); });
    const opened = await value.application.preview(request, signal);
    if (opened.kind !== "opened") throw new Error("preview fixture failed");
    const result = await value.application.apply({
      token: opened.session.token,
      confirmation: { kind: "confirm", previewId: opened.session.preview.previewId, expectedVersion: 0, operation: "disable" },
    }, {}, signal);
    expect(result).toMatchObject({ kind: "failed", code: "CLEANUP_FAILED" });
    await value.close();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("retains unresolved configuration recovery authority for shutdown settlement", async () => {
    const settle = vi.fn(async () => ({ kind: "settled" as const }));
    const recovery = { settle } as never;
    const value = harness(async () => { throw new NativeLifecycleConfigurationRecoveryError(recovery, "CLEANUP_FAILED"); });
    const opened = await value.application.preview(request, signal);
    if (opened.kind !== "opened") throw new Error("preview fixture failed");
    const result = await value.application.apply({
      token: opened.session.token,
      confirmation: { kind: "confirm", previewId: opened.session.preview.previewId, expectedVersion: 0, operation: "disable" },
    }, {}, signal);
    expect(result).toMatchObject({ kind: "failed", code: "CLEANUP_FAILED" });
    await value.close();
    expect(settle).toHaveBeenCalledOnce();
  });

  it("reaps idle sessions and close waits for an admitted operation", async () => {
    let resolve!: (result: any) => void;
    const value = harness((context: any) => new Promise((done) => { resolve = () => done({ kind: "current-state", operation: context.operation, previewId: context.previewId, progress: [], diagnostics: [], effects: { state: "unchanged", projectFile: "unchanged", completedActionIds: [], pendingActionIds: [] }, reason: "already-disabled", target: context.target.binding }); }));
    const expired = await value.application.preview(request, signal);
    if (expired.kind !== "opened") throw new Error("preview fixture failed");
    value.advance(15 * 60_000);
    expect(await value.application.status({ token: expired.session.token }, signal)).toEqual({ kind: "expired" });

    const opened = await value.application.preview(request, signal);
    if (opened.kind !== "opened") throw new Error("preview fixture failed");
    const applying = value.application.apply({ token: opened.session.token, confirmation: { kind: "confirm", previewId: opened.session.preview.previewId, expectedVersion: 0, operation: "disable" } }, {}, signal);
    await Promise.resolve();
    value.quiesce();
    let closed = false;
    const closing = value.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolve(undefined);
    await applying;
    await closing;
    expect(closed).toBe(true);
    await value.close();
  });
});
