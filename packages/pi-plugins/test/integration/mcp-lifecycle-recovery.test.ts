import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLifecycleTransitionReconciler } from "../../src/application/lifecycle-transition-reconciler.js";
import { createLifecycleRecoveryService } from "../../src/application/recovery-service.js";
import { createPluginMcpProjection } from "../../src/application/mcp-plugin-projection.js";
import { createMcpLifecycleParticipant, type McpLifecycleState } from "../../src/runtime/mcp/lifecycle-participant.js";
import {
  SkillHookContributionObservationSchema,
  composeActivationObservation,
  type ActivationObservation,
  type LifecycleReloadPort,
} from "../../src/application/ports/lifecycle-reload.js";
import {
  createActiveProjectionExpectation,
  createInactiveProjectionExpectation,
  createPluginRuntimeProjection,
  type ProjectionExpectation,
} from "../../src/application/ports/runtime-projection.js";
import {
  createLifecycleTransitionRecord,
  LifecycleTransitionJournalEntrySchemaV1,
  type LifecycleTransitionJournalEntry,
  type LifecycleTransitionStore,
} from "../../src/application/ports/lifecycle-transition-store.js";
import type { GenerationMutationCoordinator } from "../../src/application/generation-mutation-coordinator.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import { McpRuntimeCapabilitiesSchemaV1 } from "../../src/application/ports/mcp-runtime.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { deriveComponentId } from "../../src/domain/component-identity.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import {
  createInstalledPluginRecord,
  createInstalledRevisionRecord,
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
  InstalledPluginRecordSchema,
  type InstalledPluginRecord,
} from "../../src/domain/state/installed-state.js";
import { GenerationSchema, HostConfigDocumentSchema } from "../../src/domain/state/config-state.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import {
  CanonicalProjectRootSchema,
  deriveProjectKey,
} from "../../src/domain/state/scope.js";
import {
  capabilities,
  claimFixture,
  fixtureProvenance,
} from "../fixtures/compatibility/common.js";
import {
  FakeMcpRuntime,
  FakeMcpRuntimeLeaseProvider,
} from "../support/fakes/mcp-runtime.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const content = createContentManifest([], sha256);
const scope = { kind: "user" as const };
const projectIdentity = {
  kind: "path-only" as const,
  canonicalRoot: CanonicalProjectRootSchema.parse("file:///workspace/project/"),
  limitation: "identity-changes-with-canonical-root" as const,
};
const currentProject = {
  identity: projectIdentity,
  projectKey: deriveProjectKey(projectIdentity, sha256),
  trust: { kind: "trusted" as const },
};
const runtimeCapabilities = McpRuntimeCapabilitiesSchemaV1.parse({
  schemaVersion: 1,
  sourceLifecycle: {
    initialSourcesBeforeToolRegistration: true,
    isolatedFileDiscovery: true,
    localValidation: true,
    atomicReplace: true,
    exactRemove: true,
    inspect: true,
    cancellable: true,
    lateLaunchValues: true,
    runtimeLeases: true,
  },
  transports: { stdio: true, streamableHttp: true, legacySse: false, websocket: false },
  oauth: { authorizationCode: true, clientCredentials: true },
  features: {
    sampling: true,
    elicitationForm: true,
    elicitationUrl: true,
    toolApproval: true,
    resources: true,
    pluginToolAliases: true,
  },
});

function pluginFixture(sourceRevision: string, mcpCommand: string | null) {
  const pluginKey = "bundle@community" as never;
  const provenance = fixtureProvenance("plugin.json", "/components", "claude", "manifest");
  const mcpProvenance = fixtureProvenance("plugin.mcp.json", "/mcpServers/bundle", "claude", "mcp");
  const skill = {
    kind: "skill" as const,
    id: deriveComponentId(pluginKey, { kind: "skill", root: "skills/bundle" }, sha256),
    name: claimFixture("bundle", provenance),
    root: claimFixture("skills/bundle", provenance),
    metadata: [],
  };
  const hook = {
    kind: "hook" as const,
    id: deriveComponentId(pluginKey, {
      kind: "hook",
      event: "SessionStart",
      matcher: "",
      handler: { kind: "shell", command: "echo ready" },
    }, sha256),
    event: claimFixture("SessionStart", provenance),
    handler: claimFixture({ kind: "shell", command: "echo ready" }, provenance),
    metadata: [],
  };
  const mcp = mcpCommand === null ? [] : [{
    kind: "mcp-server" as const,
    id: deriveComponentId(pluginKey, { kind: "mcp-server", nativeKey: "bundle" }, sha256),
    nativeKey: claimFixture("bundle", mcpProvenance),
    declaration: claimFixture({ transport: "stdio", command: mcpCommand }, mcpProvenance),
    metadata: [],
  }];
  return NormalizedPluginSchema.parse({
    identity: { key: pluginKey, marketplaceName: "community", marketplaceEntryName: "bundle" },
    source: createResolvedPluginSource({
      kind: "git",
      url: "https://example.invalid/bundle.git",
      revision: sourceRevision.repeat(40),
    }, sha256),
    configuration: { options: [] },
    components: { skills: [skill], hooks: [hook], mcpServers: mcp, foreign: [] },
    metadata: [],
  });
}

function revisionFixture(sourceRevision: string, mcpCommand: string | null) {
  const plugin = pluginFixture(sourceRevision, mcpCommand);
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope }, sha256);
  const projection = createPluginRuntimeProjection({ scope, plugin, compatibility, revision, sha256 });
  const expectation = createActiveProjectionExpectation(projection, sha256);
  const mcpProjection = createPluginMcpProjection({
    projection,
    compatibility,
    runtimeCapabilities,
    sha256,
  });
  const mcpState: McpLifecycleState = mcpProjection.kind === "source"
    ? { kind: "source", expectation, projection: mcpProjection, capabilities: runtimeCapabilities }
    : { kind: "none", expectation, projection: mcpProjection };
  return { plugin, compatibility, revision, projection, expectation, mcpState };
}

function bundleFixture(mcp = true) {
  const old = revisionFixture("a", mcp ? "old-server" : null);
  const candidate = revisionFixture("b", mcp ? "new-server" : null);
  const previousRecord = createInstalledPluginRecord({
    scope,
    plugin: old.projection.plugin,
    activation: "enabled",
    selectedRevision: old.revision.revision,
    revisions: [old.revision],
  }, sha256);
  const candidateRecord = createInstalledPluginRecord({
    scope,
    plugin: old.projection.plugin,
    activation: "enabled",
    selectedRevision: candidate.revision.revision,
    revisions: [old.revision, candidate.revision],
  }, sha256);
  const inactive: McpLifecycleState = {
    kind: "inactive",
    expectation: createInactiveProjectionExpectation({ scope, plugin: old.projection.plugin, sha256 }),
  };
  const record = createLifecycleTransitionRecord({
    operationId: "00000000-0000-4000-8000-000000000001",
    operation: "update",
    origin: "manual",
    scope,
    plugin: old.projection.plugin,
    startingGeneration: GenerationSchema.parse(1),
    previous: previousRecord,
    candidate: candidateRecord,
    final: candidateRecord,
    previousProjection: old.expectation,
    candidateProjection: candidate.expectation,
    retainedData: "keep",
    sha256,
  });
  const pendingCandidate = InstalledPluginRecordSchema.parse({
    ...candidateRecord,
    pendingTransition: record.reference,
  });
  return { old, candidate, previousRecord, candidateRecord, pendingCandidate, inactive, record };
}

function snapshot(generation: number, plugins: readonly InstalledPluginRecord[]): Extract<GenerationSnapshot, { scope: { kind: "user" } }> {
  const value = GenerationSchema.parse(generation);
  const marketplace = createMarketplaceSnapshotRecord({
    marketplace: "community",
    source: createResolvedMarketplaceSource({
      declared: { kind: "github", repository: "example/community" },
      revision: "c".repeat(40),
    }, sha256),
    content,
  }, sha256);
  return {
    scope,
    generation: value,
    pointers: {} as never,
    config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: value, records: [] }),
    installed: createInstalledUserStateDocument({
      generation: value,
      marketplaces: [marketplace],
      plugins,
    }, sha256),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation: value, records: [] }),
    corruptions: [],
  };
}

class State implements LifecycleStateStore {
  constructor(public current: Extract<GenerationSnapshot, { scope: { kind: "user" } }>) {}
  async read() { return { ok: true as const, snapshot: this.current }; }
  async commit(): Promise<never> { throw new Error("coordinator owns commits"); }
}

function coordinator(state: State): GenerationMutationCoordinator {
  return {
    async runPreparedMutation(request, callback) {
      if (request.expectedGeneration !== state.current.generation) {
        return { kind: "stale-generation", expected: request.expectedGeneration, actual: state.current.generation };
      }
      const prepared = await callback({ snapshot: state.current, assertOwned: async () => undefined });
      if (prepared.mutation.scope.kind !== "user") throw new Error("unexpected project mutation");
      const generation = GenerationSchema.parse(state.current.generation + 1);
      const replacement = prepared.mutation.replace;
      const installed = "installed" in replacement && replacement.installed !== undefined
        ? { ...replacement.installed, generation }
        : { ...state.current.installed, generation };
      state.current = {
        ...state.current,
        generation,
        config: { ...state.current.config, generation },
        installed,
        trust: { ...state.current.trust, generation },
      };
      return { kind: "committed", value: prepared.value, snapshot: state.current };
    },
  };
}

class Transitions implements LifecycleTransitionStore {
  readonly outcomes: string[] = [];
  failSettle = false;
  async prepare() { return "stored" as const; }
  async settle(request: Parameters<LifecycleTransitionStore["settle"]>[0]) {
    if (this.failSettle) throw new Error("settlement failed");
    this.outcomes.push(request.outcome);
  }
}

type Plan = Readonly<{
  from: McpLifecycleState;
  to: McpLifecycleState;
  expectation: ProjectionExpectation;
}>;

class Reload implements LifecycleReloadPort {
  plan: Plan | undefined;
  readonly leaseProviders = new Map<string, FakeMcpRuntimeLeaseProvider>();
  readonly participant;

  constructor(
    runtime?: FakeMcpRuntime,
    private readonly durablePlan?: () => Plan,
  ) {
    this.participant = createMcpLifecycleParticipant({
      runtime,
      launchValues: () => ({
        async resolve() { return { transport: "stdio", command: "CANARY_PLAINTEXT", args: [] }; },
        dispose() {},
      }),
      runtimeLeases: (registration) => {
        const provider = new FakeMcpRuntimeLeaseProvider();
        this.leaseProviders.set(registration.digest, provider);
        return provider;
      },
      sha256,
    });
  }

  setPlan(from: McpLifecycleState, to: McpLifecycleState): void {
    this.plan = { from, to, expectation: to.expectation };
  }

  private currentPlan(): Plan {
    const plan = this.durablePlan?.() ?? this.plan;
    if (plan === undefined) throw new Error("reload plan missing");
    return plan;
  }

  private skillsHooks(expectation: ProjectionExpectation) {
    if (expectation.kind === "inactive") {
      return SkillHookContributionObservationSchema.parse({
        kind: "inactive",
        participant: "skills-hooks",
        scope: expectation.scope,
        plugin: expectation.plugin,
        projectionDigest: expectation.digest,
        currentProject,
        contributionDigest: expectation.digest,
        skillComponentIds: [],
        hookComponentIds: [],
      });
    }
    return SkillHookContributionObservationSchema.parse({
      kind: "active",
      participant: "skills-hooks",
      scope: expectation.projection.scope,
      plugin: expectation.projection.plugin,
      revision: expectation.projection.revision,
      projectionDigest: expectation.projection.digest,
      currentProject,
      contributionDigest: expectation.projection.digest,
      skillComponentIds: expectation.projection.components.skills.map((component) => component.id),
      hookComponentIds: expectation.projection.components.hooks.map((component) => component.id),
    });
  }

  async reconcileLocal(
    request: Parameters<NonNullable<LifecycleReloadPort["reconcileLocal"]>>[0],
    signal: AbortSignal,
  ): Promise<ActivationObservation> {
    const plan = this.currentPlan();
    const targetIsPlanned = JSON.stringify(plan.to.expectation) === JSON.stringify(request.expectation);
    const transition = targetIsPlanned ? plan : { from: plan.to, to: plan.from, expectation: request.expectation };
    const result = await this.participant.reconcile({ from: transition.from, to: transition.to, currentProject }, signal);
    if (result.kind !== "applied" && result.kind !== "unchanged") throw new Error("local reconcile failed");
    const mcp = await this.participant.observe({ from: transition.to, to: transition.to, currentProject }, signal);
    if (mcp.kind !== "ready") throw new Error("local observation failed");
    return composeActivationObservation({
      expectation: request.expectation,
      skillsHooks: this.skillsHooks(request.expectation),
      mcp: mcp.observation,
    });
  }

  async reload(_request: Parameters<LifecycleReloadPort["reload"]>[0], signal: AbortSignal) {
    const plan = this.currentPlan();
    const result = await this.participant.reconcile({
      from: plan.from,
      to: plan.to,
      currentProject,
    }, signal);
    return result.kind === "applied" || result.kind === "unchanged"
      ? { kind: "accepted" as const }
      : { kind: "failed" as const, code: "MCP_RECONCILE_FAILED" };
  }

  async observe(_request: Parameters<LifecycleReloadPort["observe"]>[0], signal: AbortSignal): Promise<ActivationObservation> {
    const plan = this.currentPlan();
    const mcp = await this.participant.observe({
      from: plan.from,
      to: plan.to,
      currentProject,
    }, signal);
    if (mcp.kind !== "ready") throw new Error("MCP observation unavailable");
    return composeActivationObservation({
      expectation: plan.expectation,
      skillsHooks: this.skillsHooks(plan.expectation),
      mcp: mcp.observation,
    });
  }

  async activate(from: McpLifecycleState, to: McpLifecycleState, signal: AbortSignal) {
    this.setPlan(from, to);
    const reload = await this.reload({ scope, transition: "pending-transition-v1:sha256:" + "0".repeat(64) as never }, signal);
    if (reload.kind === "failed") {
      return { ok: false as const, failure: { kind: "reload-rejected" as const, code: "RELOAD_REJECTED" as const } };
    }
    try {
      return { ok: true as const, observation: await this.observe({ scope, plugin: "bundle@community" as never }, signal) };
    } catch {
      return { ok: false as const, failure: { kind: "observation-mismatch" as const, code: "OBSERVATION_MISMATCH" as const } };
    }
  }
}

function reconciler(
  state: State,
  reload: Reload,
  transitions: LifecycleTransitionStore,
) {
  return createLifecycleTransitionReconciler({
    mutations: coordinator(state),
    state,
    reload,
    transitions,
    sha256,
  });
}

function disableBundleFixture() {
  const base = bundleFixture();
  const disabled = createInstalledPluginRecord({
    scope,
    plugin: base.old.projection.plugin,
    activation: "disabled",
    selectedRevision: base.old.revision.revision,
    revisions: [base.old.revision],
  }, sha256);
  const record = createLifecycleTransitionRecord({
    operationId: "00000000-0000-4000-8000-000000000010",
    operation: "disable",
    origin: "manual",
    scope,
    plugin: base.old.projection.plugin,
    startingGeneration: GenerationSchema.parse(1),
    previous: base.previousRecord,
    candidate: disabled,
    final: disabled,
    previousProjection: base.old.expectation,
    candidateProjection: base.inactive.expectation,
    retainedData: "keep",
    sha256,
  });
  return {
    ...base,
    candidateRecord: disabled,
    pendingCandidate: InstalledPluginRecordSchema.parse({
      ...disabled,
      pendingTransition: record.reference,
    }),
    record,
  };
}

function pendingRecord(
  record: InstalledPluginRecord,
  reference: ReturnType<typeof createLifecycleTransitionRecord>["reference"],
): InstalledPluginRecord {
  return InstalledPluginRecordSchema.parse({ ...record, pendingTransition: reference });
}

function withoutPending(record: InstalledPluginRecord): InstalledPluginRecord {
  const { pendingTransition: _pendingTransition, ...value } = record;
  return InstalledPluginRecordSchema.parse(value);
}

function sameRecord(left: InstalledPluginRecord | null, right: InstalledPluginRecord | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class DurableTransitions implements LifecycleTransitionStore {
  entry: LifecycleTransitionJournalEntry;
  owner: "live" | "dead" | "unknown" | "released" = "dead";
  ownerReads = 0;
  readonly outcomes: string[] = [];

  constructor(record: ReturnType<typeof createLifecycleTransitionRecord>) {
    this.entry = LifecycleTransitionJournalEntrySchemaV1.parse({
      schemaVersion: 1,
      record,
      status: { kind: "prepared" },
      preparedAt: 1_700_000_000_000,
      statusAt: 1_700_000_000_000,
    });
  }

  async prepare() { return "already-present" as const; }

  async settle(request: Parameters<LifecycleTransitionStore["settle"]>[0]) {
    this.outcomes.push(request.outcome);
    this.entry = LifecycleTransitionJournalEntrySchemaV1.parse({
      ...this.entry,
      status: {
        kind: request.outcome,
        ...(request.generation === undefined ? {} : { generation: request.generation }),
      },
      statusAt: 1_700_000_000_100 + this.outcomes.length,
    });
  }

  async list() {
    return { entries: [this.entry], complete: true, diagnostics: [] };
  }

  async ownerStatus() {
    this.ownerReads += 1;
    return this.owner;
  }

  async markRecoveryRequired(
    request: Parameters<NonNullable<LifecycleTransitionStore["markRecoveryRequired"]>>[0],
  ) {
    if (["completed", "rolled-back", "abandoned"].includes(this.entry.status.kind)) {
      return "terminal" as const;
    }
    if (this.entry.status.kind === "recovery-required") return "already-present" as const;
    this.entry = LifecycleTransitionJournalEntrySchemaV1.parse({
      ...this.entry,
      status: {
        kind: "recovery-required",
        ...(request.generation === undefined ? {} : { generation: request.generation }),
      },
      statusAt: request.at,
    });
    return "stored" as const;
  }
}

function durableReloadPlan(input: Readonly<{
  state: State;
  transitions: DurableTransitions;
  previous: McpLifecycleState;
  candidate: McpLifecycleState;
}>): Plan {
  const record = input.transitions.entry.record;
  const current = input.state.current.installed.plugins.find((plugin) => plugin.plugin === record.plugin);
  if (current === undefined || current.pendingTransition !== record.reference) {
    throw new Error("durable pending transition is unavailable");
  }
  const authoritative = withoutPending(current);
  if (record.previous !== null && sameRecord(authoritative, record.previous)) {
    return { from: input.candidate, to: input.previous, expectation: record.previousProjection };
  }
  if (sameRecord(authoritative, record.candidate)) {
    return { from: input.previous, to: input.candidate, expectation: record.candidateProjection };
  }
  throw new Error("durable pending transition does not select a reload target");
}

describe("MCP lifecycle and recovery integration", () => {
  it("finalizes an exact whole-bundle update through the existing transition reconciler", async () => {
    const fixture = bundleFixture();
    const runtime = new FakeMcpRuntime();
    const reload = new Reload(runtime);
    const signal = new AbortController().signal;
    expect((await reload.activate(fixture.inactive, fixture.old.mcpState, signal)).ok).toBe(true);
    const activation = await reload.activate(fixture.old.mcpState, fixture.candidate.mcpState, signal);
    expect(activation.ok).toBe(true);
    const state = new State(snapshot(2, [fixture.pendingCandidate]));
    const transitions = new Transitions();
    const result = await reconciler(state, reload, transitions).completeCommittedTransition({
      operation: "update",
      scope,
      plugin: fixture.old.projection.plugin,
      previous: fixture.previousRecord,
      candidate: fixture.candidateRecord,
      final: fixture.candidateRecord,
      reference: fixture.record.reference,
      committed: state.current,
      candidateProjection: fixture.candidate.expectation,
      previousProjection: fixture.old.expectation,
      activation,
    }, signal);
    expect(result.kind).toBe("completed");
    expect(state.current.installed.plugins[0]?.pendingTransition).toBeUndefined();
    expect(state.current.installed.plugins[0]?.selectedRevision).toBe(fixture.candidate.revision.revision);
    expect(transitions.outcomes).toEqual(["completed"]);
  });

  it("restores and observes the exact previous source after partial or lost candidate effects", async () => {
    for (const fault of ["partial", "lost"] as const) {
      const fixture = bundleFixture();
      const runtime = new FakeMcpRuntime();
      const reload = new Reload(runtime);
      const signal = new AbortController().signal;
      await reload.activate(fixture.inactive, fixture.old.mcpState, signal);
      if (fault === "partial") runtime.partiallyApplyNextReplacement();
      else runtime.loseNextReplacementResponse();
      const activation = await reload.activate(fixture.old.mcpState, fixture.candidate.mcpState, signal);
      expect(activation.ok).toBe(false);

      const state = new State(snapshot(2, [fixture.pendingCandidate]));
      const transitions = new Transitions();
      reload.setPlan(fixture.candidate.mcpState, fixture.old.mcpState);
      const result = await reconciler(state, reload, transitions).completeCommittedTransition({
        operation: "update",
        scope,
        plugin: fixture.old.projection.plugin,
        previous: fixture.previousRecord,
        candidate: fixture.candidateRecord,
        final: fixture.candidateRecord,
        reference: fixture.record.reference,
        committed: state.current,
        candidateProjection: fixture.candidate.expectation,
        previousProjection: fixture.old.expectation,
        activation,
      }, signal);
      expect(result.kind, fault).toBe("rolled-back");
      expect(state.current.installed.plugins[0]?.selectedRevision).toBe(fixture.old.revision.revision);
      expect(transitions.outcomes).toEqual(["rolled-back"]);
    }
  });

  it("retains pending evidence when exact restore replacement or observation cannot complete", async () => {
    const fixture = bundleFixture();
    const runtime = new FakeMcpRuntime();
    const reload = new Reload(runtime);
    const signal = new AbortController().signal;
    await reload.activate(fixture.inactive, fixture.old.mcpState, signal);
    runtime.partiallyApplyNextReplacement();
    const activation = await reload.activate(fixture.old.mcpState, fixture.candidate.mcpState, signal);
    expect(activation.ok).toBe(false);
    runtime.failNextReplacement();

    const state = new State(snapshot(2, [fixture.pendingCandidate]));
    const transitions = new Transitions();
    reload.setPlan(fixture.candidate.mcpState, fixture.old.mcpState);
    const result = await reconciler(state, reload, transitions).completeCommittedTransition({
      operation: "update",
      scope,
      plugin: fixture.old.projection.plugin,
      previous: fixture.previousRecord,
      candidate: fixture.candidateRecord,
      final: fixture.candidateRecord,
      reference: fixture.record.reference,
      committed: state.current,
      candidateProjection: fixture.candidate.expectation,
      previousProjection: fixture.old.expectation,
      activation,
    }, signal);
    expect(result.kind).toBe("recovery-required");
    expect(state.current.installed.plugins[0]?.pendingTransition).toBe(fixture.record.reference);
    expect(transitions.outcomes).toEqual(["recovery-required"]);
  });

  it("keeps a disable pending when unregister-before-cleanup and restore cleanup both fail", async () => {
    const fixture = bundleFixture();
    if (fixture.old.mcpState.kind !== "source") throw new Error("source state required");
    const runtime = new FakeMcpRuntime();
    const reload = new Reload(runtime);
    const signal = new AbortController().signal;
    await reload.activate(fixture.inactive, fixture.old.mcpState, signal);
    const registration = fixture.old.mcpState.projection.registration;
    const provider = reload.leaseProviders.get(registration.digest);
    if (provider === undefined) throw new Error("runtime lease provider missing");
    const serverKey = Object.keys(registration.source.servers)[0]!;
    await runtime.openExecution(registration.source.identity, serverKey, signal);
    provider.failNextRelease();
    runtime.failNextRemoval(true);
    const activation = await reload.activate(fixture.old.mcpState, fixture.inactive, signal);
    expect(activation.ok).toBe(false);

    const disabled = createInstalledPluginRecord({
      scope,
      plugin: fixture.old.projection.plugin,
      activation: "disabled",
      selectedRevision: fixture.old.revision.revision,
      revisions: [fixture.old.revision],
    }, sha256);
    const disableRecord = createLifecycleTransitionRecord({
      operationId: "00000000-0000-4000-8000-000000000002",
      operation: "disable",
      origin: "manual",
      scope,
      plugin: fixture.old.projection.plugin,
      startingGeneration: GenerationSchema.parse(1),
      previous: fixture.previousRecord,
      candidate: disabled,
      final: disabled,
      previousProjection: fixture.old.expectation,
      candidateProjection: fixture.inactive.expectation,
      retainedData: "keep",
      sha256,
    });
    const pendingDisabled = InstalledPluginRecordSchema.parse({
      ...disabled,
      pendingTransition: disableRecord.reference,
    });
    const state = new State(snapshot(2, [pendingDisabled]));
    const transitions = new Transitions();
    reload.setPlan(fixture.inactive, fixture.old.mcpState);
    const result = await reconciler(state, reload, transitions).completeCommittedTransition({
      operation: "disable",
      scope,
      plugin: fixture.old.projection.plugin,
      previous: fixture.previousRecord,
      candidate: disabled,
      final: disabled,
      reference: disableRecord.reference,
      committed: state.current,
      candidateProjection: fixture.inactive.expectation,
      previousProjection: fixture.old.expectation,
      activation,
    }, signal);
    expect(result.kind).toBe("recovery-required");
    expect(state.current.installed.plugins[0]?.pendingTransition).toBe(disableRecord.reference);
    expect(runtime.executionCount(registration.source.identity)).toBe(1);
    expect(transitions.outcomes).toEqual(["recovery-required"]);
  });

  it.each([
    { crashPoint: "candidate publication", transition: "update", durableTarget: "candidate", outcome: "completed" },
    { crashPoint: "partial replacement", transition: "update", durableTarget: "candidate", outcome: "rolled-back" },
    { crashPoint: "partial removal", transition: "disable", durableTarget: "candidate", outcome: "rolled-back" },
    { crashPoint: "post-removal/pre-finalization", transition: "disable", durableTarget: "candidate", outcome: "rolled-back" },
    { crashPoint: "compensation crash", transition: "update", durableTarget: "previous", outcome: "rolled-back" },
    { crashPoint: "post-restore/pre-settlement", transition: "update", durableTarget: "previous", outcome: "rolled-back" },
  ] as const)("recovers $crashPoint from durable pending authority after owner death", async ({
    crashPoint,
    transition,
    durableTarget,
    outcome,
  }) => {
    const fixture = transition === "disable" ? disableBundleFixture() : bundleFixture();
    const previousState = fixture.old.mcpState;
    const candidateState = transition === "disable"
      ? fixture.inactive
      : fixture.candidate.mcpState;
    const runtime = new FakeMcpRuntime();
    const setupReload = new Reload(runtime);
    const signal = new AbortController().signal;
    expect((await setupReload.activate(fixture.inactive, previousState, signal)).ok).toBe(true);

    if (crashPoint === "candidate publication") {
      expect((await setupReload.activate(previousState, candidateState, signal)).ok).toBe(true);
    } else if (crashPoint === "partial replacement") {
      runtime.partiallyApplyNextReplacement();
      expect((await setupReload.activate(previousState, candidateState, signal)).ok).toBe(false);
    } else if (crashPoint === "partial removal") {
      if (previousState.kind !== "source") throw new Error("source state required");
      const provider = setupReload.leaseProviders.get(previousState.projection.registration.digest);
      if (provider === undefined) throw new Error("runtime lease provider missing");
      const serverKey = Object.keys(previousState.projection.registration.source.servers)[0]!;
      await runtime.openExecution(previousState.projection.registration.source.identity, serverKey, signal);
      expect(provider.activeCount).toBe(1);
      runtime.failNextRemoval(true);
      expect((await setupReload.activate(previousState, candidateState, signal)).ok).toBe(false);
      expect(runtime.executionCount(previousState.projection.registration.source.identity)).toBe(1);
    } else if (crashPoint === "post-removal/pre-finalization") {
      expect((await setupReload.activate(previousState, candidateState, signal)).ok).toBe(true);
      expect(await runtime.inspectSources(signal)).toEqual([]);
    } else if (crashPoint === "compensation crash") {
      expect((await setupReload.activate(previousState, candidateState, signal)).ok).toBe(true);
    }

    const durableRecord = durableTarget === "candidate"
      ? fixture.pendingCandidate
      : pendingRecord(fixture.previousRecord, fixture.record.reference);
    const state = new State(snapshot(2, [durableRecord]));
    const transitions = new DurableTransitions(fixture.record);
    const reload = new Reload(runtime, () => durableReloadPlan({
      state,
      transitions,
      previous: previousState,
      candidate: candidateState,
    }));
    const recovery = () => createLifecycleRecoveryService({
      state,
      transitions: () => transitions,
      reconciler: reconciler(state, reload, transitions),
      reload,
      clock: {
        nowEpochMilliseconds: () => 1_700_000_000_500,
        monotonicMilliseconds: () => 0,
      },
    });

    transitions.owner = "live";
    const deferred = await recovery().recover({ requiredScopes: [{ kind: "user" }] }, signal);
    expect(deferred).toMatchObject({
      deferred: true,
      processed: 1,
      results: [{ kind: "deferred", code: "OWNER_LIVE" }],
    });
    expect(state.current.installed.plugins[0]?.pendingTransition).toBe(fixture.record.reference);
    expect(transitions.entry.status.kind).toBe("prepared");

    transitions.owner = "dead";
    const result = await recovery().recover({ requiredScopes: [{ kind: "user" }] }, signal);
    expect(result.deferred).toBe(false);
    expect(result.processed).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.kind).toBe(outcome === "completed" ? "finalized" : "rolled-back");
    expect(transitions.ownerReads).toBe(2);

    const authoritative = state.current.installed.plugins[0];
    const expectedState = outcome === "completed" ? fixture.candidate.mcpState : previousState;
    const expectedRevision = outcome === "completed"
      ? fixture.candidateRecord.selectedRevision
      : fixture.previousRecord.selectedRevision;
    expect(authoritative?.selectedRevision).toBe(expectedRevision);
    expect(authoritative?.pendingTransition).toBeUndefined();
    expect(transitions.entry.status.kind).toBe(outcome);
    expect(transitions.outcomes.at(-1)).toBe(outcome);

    if (expectedState.kind !== "source") throw new Error("recovery should leave an active source");
    const statuses = await runtime.inspectSources(signal);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.identity).toEqual(expectedState.projection.registration.source.identity);
    expect(statuses[0]?.registrationDigest).toBe(expectedState.projection.registration.digest);
    expect(runtime.executionCount()).toBe(0);
    for (const provider of [
      ...setupReload.leaseProviders.values(),
      ...reload.leaseProviders.values(),
    ]) {
      expect(provider.activeCount).toBe(0);
    }
  });

  it("keeps complete no-MCP bundles explicit and offline through finalization", async () => {
    const fixture = bundleFixture(false);
    const reload = new Reload();
    const signal = new AbortController().signal;
    const activation = await reload.activate(fixture.old.mcpState, fixture.candidate.mcpState, signal);
    expect(activation.ok).toBe(true);
    if (activation.ok) {
      expect(activation.observation.kind).toBe("active");
    }
    const state = new State(snapshot(2, [fixture.pendingCandidate]));
    const transitions = new Transitions();
    const result = await reconciler(state, reload, transitions).completeCommittedTransition({
      operation: "update",
      scope,
      plugin: fixture.old.projection.plugin,
      previous: fixture.previousRecord,
      candidate: fixture.candidateRecord,
      final: fixture.candidateRecord,
      reference: fixture.record.reference,
      committed: state.current,
      candidateProjection: fixture.candidate.expectation,
      previousProjection: fixture.old.expectation,
      activation,
    }, signal);
    expect(result.kind).toBe("completed");
    expect(transitions.outcomes).toEqual(["completed"]);
  });
});
