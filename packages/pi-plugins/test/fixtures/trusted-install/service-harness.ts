import { createHash } from "node:crypto";
import { createComposedTrustedInstallationService } from "../../../src/composition/create-trusted-installation-service.js";
import { createCandidateContentLeasePort } from "../../../src/composition/candidate-content-lease.js";
import { createHostConfigurationServices } from "../../../src/composition/create-host-configuration.js";
import { createPluginLifecycleComposition } from "../../../src/application/plugin-lifecycle-service.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../../../src/application/native-inspection-identifiers.js";
import { SensitiveValue } from "../../../src/application/sensitive-value.js";
import { createContentManifest, createMaterializationBinding } from "../../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../../src/domain/plugin.js";
import { claim } from "../../../src/domain/provenance.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../../src/domain/source.js";
import { readClaudeMarketplace } from "../../../src/formats/claude/marketplace-reader.js";
import { capabilities, componentId, fixtureProvenance } from "../compatibility/common.js";
import { evaluateCompatibility } from "../../../src/domain/compatibility-evaluator.js";
import {
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
} from "../../../src/domain/state/installed-state.js";
import { HostConfigDocumentSchema, GenerationSchema } from "../../../src/domain/state/config-state.js";
import { StatePointersDocumentSchema } from "../../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../../src/domain/state/trust-state.js";
import { deriveStateBlobRef } from "../../../src/domain/state/references.js";
import { CurrentProjectRuntimeContextSchema } from "../../../src/application/ports/project-trust.js";
import { createPluginConfigurationDocument, digestConfigurationDescriptors } from "../../../src/domain/configured-values.js";

export const trustedInstallHarnessSha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

const provenance = fixtureProvenance();
const entry = readClaudeMarketplace({
  name: "compatibility",
  plugins: [{ name: "fixture", source: "./plugin", strict: false }],
}).marketplace.entries[0]!;
const marketplaceSource = createResolvedMarketplaceSource({
  declared: { kind: "github", repository: "example/compatibility" },
  revision: "a".repeat(40),
}, trustedInstallHarnessSha256);

export const trustedInstallHarnessPlugin = NormalizedPluginSchema.parse({
  identity: {
    key: "fixture@compatibility",
    marketplaceName: "compatibility",
    marketplaceEntryName: "fixture",
  },
  source: createResolvedPluginSource({
    kind: "marketplace-path",
    marketplaceRevision: "a".repeat(40),
    path: "plugin",
  }, trustedInstallHarnessSha256),
  configuration: {
    options: [
      {
        key: "NAME",
        label: claim("Name", provenance),
        value: { kind: "string" },
        required: true,
        sensitive: false,
        provenance: [provenance],
      },
      {
        key: "TOKEN",
        label: claim("Token", provenance),
        value: { kind: "string" },
        required: true,
        sensitive: true,
        provenance: [provenance],
      },
    ],
  },
  components: {
    skills: [{
      kind: "skill",
      id: componentId("skill", "1"),
      name: claim("trusted-skill", provenance),
      root: claim("skills/trusted", provenance),
      metadata: [],
    }],
    hooks: [{
      kind: "hook",
      id: componentId("hook", "2"),
      event: claim("SessionStart", provenance),
      handler: claim({ kind: "shell", command: "printf ready" }, provenance),
      metadata: [],
    }],
    mcpServers: [{
      kind: "mcp-server",
      id: componentId("mcp-server", "3"),
      nativeKey: claim("trusted", provenance),
      declaration: claim({
        transport: "stdio",
        command: "trusted-mcp",
        env: { MCP_TOKEN: "${CLAUDE_PLUGIN_OPTION_TOKEN}" },
      }, provenance),
      metadata: [],
    }],
    foreign: [],
  },
  metadata: [],
});

const compatibility = evaluateCompatibility({
  plugin: trustedInstallHarnessPlugin,
  capabilities: capabilities(),
});
const content = createContentManifest([], trustedInstallHarnessSha256);
const materialized = {
  root: "/private/staging/content",
  source: trustedInstallHarnessPlugin.source,
  content,
  binding: createMaterializationBinding(
    trustedInstallHarnessPlugin.source.hash,
    content.rootDigest,
    trustedInstallHarnessSha256,
  ),
};
const marketplace = createMarketplaceSnapshotRecord({
  marketplace: "compatibility",
  source: marketplaceSource,
  content,
}, trustedInstallHarnessSha256);
const registrationId = `marketplace-registration-v1:sha256:${"1".repeat(64)}` as never;
const candidateId = `marketplace-candidate-v1:sha256:${"2".repeat(64)}` as never;
const catalogSnapshot = `marketplace-snapshot-v1:sha256:${"3".repeat(64)}` as never;
const projectKey = `project-v1:sha256:${"4".repeat(64)}` as never;
const capabilityDigest = `sha256:${"5".repeat(64)}` as never;
const candidate = {
  id: candidateId,
  scope: { kind: "user" as const },
  registrationId,
  snapshot: catalogSnapshot,
  marketplace: {
    root: "/private/marketplace",
    source: marketplaceSource,
    content,
    binding: createMaterializationBinding(marketplaceSource.hash, content.rootDigest, trustedInstallHarnessSha256),
  },
  entry,
} as never;
const subject = {
  version: 1 as const,
  subject: "marketplace-candidate" as const,
  scope: { kind: "user" as const },
  plugin: trustedInstallHarnessPlugin.identity.key,
  registrationId,
  candidateId,
  catalogSnapshot,
};

function pointers(generationInput: number) {
  const generation = GenerationSchema.parse(generationInput);
  return StatePointersDocumentSchema.parse({
    schemaVersion: 1,
    scope: { kind: "user" },
    generation,
    documents: ["hostConfig", "installedUser", "trust"].map((kind) => ({
      kind,
      generation,
      blob: deriveStateBlobRef({ document: kind, scope: "user", generation }, trustedInstallHarnessSha256),
      digest: content.rootDigest,
    })),
  });
}

function initialSnapshot() {
  const generation = GenerationSchema.parse(0);
  return {
    scope: { kind: "user" as const },
    generation,
    pointers: pointers(generation),
    config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation, records: [] }),
    installed: createInstalledUserStateDocument({ generation, marketplaces: [marketplace], plugins: [] }, trustedInstallHarnessSha256),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records: [] }),
    corruptions: [],
  } as any;
}

class HarnessConfigurationStore {
  document: any;
  commitThenThrow = false;
  ambiguousCommitObserved = false;
  reconciliationReadFailures = 0;
  mutateAfterNextAuthoritativeRead = false;

  mutate(): void {
    const current = this.document;
    if (current === undefined) return;
    this.document = createPluginConfigurationDocument({
      schemaVersion: 1,
      configurationRef: current.configurationRef,
      plugin: current.plugin,
      scope: current.scope,
      descriptorDigest: digestConfigurationDescriptors(trustedInstallHarnessPlugin.configuration, trustedInstallHarnessSha256),
      values: current.values.map((value: any) => value.key === "NAME"
        ? { key: value.key, value: { kind: "string", value: "concurrent" } }
        : value),
      secrets: current.secrets,
    }, trustedInstallHarnessSha256);
  }

  async read() {
    if (this.ambiguousCommitObserved && this.reconciliationReadFailures > 0) {
      this.reconciliationReadFailures -= 1;
      throw new Error("CANARY_CONFIGURATION_READ_FAILURE");
    }
    if (this.document === undefined) return { kind: "missing" as const };
    const current = this.document;
    if (this.mutateAfterNextAuthoritativeRead) {
      this.mutateAfterNextAuthoritativeRead = false;
      this.mutate();
    }
    return { kind: "found" as const, document: current };
  }

  async replace(request: any) {
    if ((this.document?.revision ?? null) !== request.expectedRevision) {
      return { kind: "stale" as const, actualRevision: this.document?.revision ?? null };
    }
    this.document = request.document;
    if (this.commitThenThrow) {
      this.ambiguousCommitObserved = true;
      throw new Error("CANARY_CONFIGURATION_COMMIT_AMBIGUOUS");
    }
    return { kind: "stored" as const };
  }

  async remove() {
    this.document = undefined;
    return "removed" as const;
  }
}

class HarnessSecretStore {
  readonly values = new Map<string, SensitiveValue>();
  private readonly owned = new WeakMap<object, string>();
  cleanupFailures = 0;

  async put(locator: string, value: SensitiveValue) {
    if (this.values.has(locator)) return { kind: "collision" as const };
    const evidence = Object.freeze({});
    this.owned.set(evidence, locator);
    this.values.set(locator, value);
    return { kind: "created" as const, locator, evidence };
  }

  async get(locator: string) {
    return this.values.has(locator)
      ? { kind: "found" as const, value: this.values.get(locator)! }
      : { kind: "missing" as const };
  }

  async remove(locator: string) {
    if (this.cleanupFailures > 0) {
      this.cleanupFailures -= 1;
      throw new Error("CANARY_SECRET_CLEANUP_FAILURE");
    }
    return this.values.delete(locator) ? "removed" as const : "missing" as const;
  }

  async removeOwned(evidence: object) {
    const locator = this.owned.get(evidence);
    if (locator === undefined) throw new Error("credential ownership missing");
    if (this.cleanupFailures > 0) {
      this.cleanupFailures -= 1;
      throw new Error("CANARY_SECRET_CLEANUP_FAILURE");
    }
    this.owned.delete(evidence);
    return this.values.delete(locator) ? "removed" as const : "missing" as const;
  }
}

export type TrustedInstallHarnessOptions = Readonly<{
  rejectReload?: boolean;
  lifecycleRecovery?: boolean;
  holdReload?: boolean;
  project?: boolean;
  projectRootStale?: boolean;
}>;

export function createTrustedInstallServiceHarness(options: TrustedInstallHarnessOptions = {}) {
  const state = { current: initialSnapshot() };
  const configurationStore = new HarnessConfigurationStore();
  const secretStore = new HarnessSecretStore();
  const counters = {
    materializations: 0,
    reloads: 0,
    observations: 0,
    promotions: 0,
    discards: 0,
    lifecycleTransitions: 0,
  };
  let catalogStale = false;
  let catalogStaleAfterAcquisition = false;
  let catalogResolveCount = 0;
  let evidenceStale = false;
  let discardFailures = 0;
  let lifecycleRecovery = options.lifecycleRecovery ?? false;
  let mutateConfigurationOnReload = false;
  let sessionCounter = 0;
  let operationCounter = 0;
  let writeCounter = 0;
  let reloadRelease: (() => void) | undefined;
  let notifyReloadStarted!: () => void;
  const reloadStarted = new Promise<void>((resolve) => { notifyReloadStarted = resolve; });
  const reloadGate = options.holdReload
    ? new Promise<void>((resolve) => { reloadRelease = resolve; })
    : undefined;

  const lifecycleState = {
    async read(_scope: unknown, signal: AbortSignal) {
      signal.throwIfAborted();
      return { ok: true as const, snapshot: state.current };
    },
    async commit() { throw new Error("harness coordinator owns commits"); },
  } as any;
  const mutations = {
    async runPreparedMutation(request: any, callback: any) {
      const current = state.current;
      if (request.expectedGeneration !== current.generation) {
        return { kind: "stale-generation" as const, expected: request.expectedGeneration, actual: current.generation };
      }
      const prepared = await callback({ snapshot: current, assertOwned: async () => undefined });
      const replacesInstalled = prepared.mutation.replace.installed !== undefined;
      if (replacesInstalled && lifecycleRecovery) {
        lifecycleRecovery = false;
        return { kind: "commit-ambiguous" as const, value: prepared.value, expected: current.generation };
      }
      const generation = GenerationSchema.parse(current.generation + 1);
      state.current = {
        ...current,
        generation,
        pointers: pointers(generation),
        config: { ...(prepared.mutation.replace.config ?? current.config), generation },
        installed: { ...(prepared.mutation.replace.installed ?? current.installed), generation },
        trust: { ...(prepared.mutation.replace.trust ?? current.trust), generation },
      };
      return { kind: "committed" as const, value: prepared.value, snapshot: state.current };
    },
  } as any;

  const contentPort = {
    async allocateStaging() {
      return { slot: { root: "/private/staging", contentRoot: "/private/staging/content", workRoot: "/private/staging/.work" }, allocationId: `stage-${counters.materializations + 1}` };
    },
    async discardStaging() {
      counters.discards += 1;
      if (discardFailures > 0) {
        discardFailures -= 1;
        throw new Error("CANARY_PRIVATE_STAGING_PATH");
      }
    },
    async promote(plan: any) {
      counters.promotions += 1;
      return { kind: "promoted" as const, identity: plan.identity, root: "/private/store", manifest: plan.manifest };
    },
  } as any;
  const candidateContent = createCandidateContentLeasePort({
    content: contentPort,
    materializer: {
      async materialize() {
        counters.materializations += 1;
        return materialized;
      },
    },
  } as never);

  const expectations: any[] = [];
  const projections = {
    async prepare(expectation: any) {
      expectations.push(expectation);
      return expectation;
    },
  };
  const currentProject = CurrentProjectRuntimeContextSchema.parse({
    identity: { kind: "path-only", canonicalRoot: "file:///private/project/", limitation: "identity-changes-with-canonical-root" },
    projectKey,
    trust: { kind: "trusted" },
  });
  const reload = {
    async reload() {
      counters.reloads += 1;
      notifyReloadStarted();
      if (reloadGate !== undefined && counters.reloads === 1) await reloadGate;
      if (mutateConfigurationOnReload && counters.reloads === 1) configurationStore.mutate();
      if (options.rejectReload && counters.reloads === 1) return { kind: "failed" as const, code: "RELOAD_REJECTED" };
      return { kind: "accepted" as const };
    },
    async observe() {
      counters.observations += 1;
      const record = state.current.installed.plugins.find((value: any) => value.plugin === trustedInstallHarnessPlugin.identity.key);
      const expectation = record?.activation === "enabled"
        ? [...expectations].reverse().find((value) => value.kind === "active")
        : [...expectations].reverse().find((value) => value.kind === "inactive");
      if (expectation?.kind === "active") {
        return {
          kind: "active" as const,
          scope: expectation.projection.scope,
          plugin: expectation.projection.plugin,
          revision: expectation.projection.revision,
          projectionDigest: expectation.projection.digest,
          currentProject,
        };
      }
      return {
        kind: "inactive" as const,
        scope: expectation?.scope ?? { kind: "user" as const },
        plugin: trustedInstallHarnessPlugin.identity.key,
        projectionDigest: expectation?.digest ?? content.rootDigest,
        currentProject,
      };
    },
  };
  const lifecycle = createPluginLifecycleComposition({
    state: lifecycleState,
    mutations,
    content: contentPort,
    materializer: { async materialize() { throw new Error("prepared install must not rematerialize"); } },
    inspector: { async inspect() { return { ok: true as const, value: trustedInstallHarnessPlugin, diagnostics: [] }; } },
    compatibility: { async assess() { return compatibility; } },
    installed: { async load({ revision }: any) { return { plugin: trustedInstallHarnessPlugin, compatibility, marketplaceSource, content, binding: revision.revision }; } },
    projections,
    reload,
    transitions: {
      async prepare() { counters.lifecycleTransitions += 1; return "stored" as const; },
      async settle() { return undefined; },
    },
    operationIds: { async create() { operationCounter += 1; return `00000000-0000-4000-8000-${operationCounter.toString().padStart(12, "0")}`; } },
    projectTrust: { async assess() { return { kind: "trusted" as const }; } },
    projectRoots: { async acquire() { throw new Error("user scope has no project root"); }, verify() { throw new Error("user scope has no project root"); } },
    configurations: configurationStore as any,
    secrets: secretStore as any,
    paths: { async normalizeAndInspect() { return { kind: "valid" as const, canonicalPath: "file:///private/valid" }; } },
    sha256: trustedInstallHarnessSha256,
  } as any);

  const projectTrust = { async assess() { return { kind: "trusted" as const }; } };
  const trustedProjectRoot = Object.freeze({ projectKey }) as never;
  const projectRoots = options.project
    ? {
        async acquire() { return trustedProjectRoot; },
        verify() { return currentProject; },
        async revalidate() {
          if (options.projectRootStale) throw new Error("project root changed");
          return currentProject;
        },
      }
    : {
        async acquire() { throw new Error("user scope has no project root"); },
        verify() { throw new Error("user scope has no project root"); },
      };
  const hostConfiguration = createHostConfigurationServices({
    configurations: configurationStore as any,
    secrets: secretStore as any,
    paths: { async normalizeAndInspect() { return { kind: "valid" as const, canonicalPath: "file:///private/valid" }; } },
    projectRoots: projectRoots as any,
    projectTrust,
    writeIds: { async create() { writeCounter += 1; return `config-write-v1:${"x".repeat(21)}${writeCounter.toString(36)}` as never; } },
    sha256: trustedInstallHarnessSha256,
  });

  const selectedScope = options.project
    ? { kind: "project" as const, identity: currentProject.identity, projectKey }
    : { kind: "user" as const };
  const selectedScopeReference = options.project
    ? { kind: "project" as const, projectKey }
    : { kind: "user" as const };
  const selectedCandidate = { ...candidate, scope: selectedScope } as never;
  const selectedSubject = { ...subject, scope: selectedScopeReference };
  const snapshotBinding = {
    capturedAt: 1,
    scopes: [{ scope: selectedScopeReference, generation: 0, status: "ready" as const, corruptionCodes: [] }],
    currentProject: {
      projectKey,
      trust: { kind: "trusted" as const },
      epoch: `sha256:${"a".repeat(64)}` as never,
    },
    catalogs: [{
      scope: selectedScopeReference,
      registrationId,
      snapshot: catalogSnapshot,
      cache: { kind: "ready" as const, validator: { kind: "git-commit" as const, revision: "a".repeat(40) }, etag: { kind: "not-applicable" as const } },
    }],
    capability: { status: "ready" as const, digest: capabilityDigest, capturedBy: "trusted-install-harness" },
    runtimeEpoch: `sha256:${"6".repeat(64)}` as never,
    recoveryDigest: `sha256:${"7".repeat(64)}` as never,
    updateDigest: `sha256:${"8".repeat(64)}` as never,
  };
  const inspectionSnapshot = {
    binding: snapshotBinding,
    states: [],
    currentProject,
    capabilities: capabilities(),
    runtime: [],
    recovery: { results: [], deferred: false, processed: 0 },
    startup: {
      status: "ready",
      blocked: [],
      capabilities: {
        mcp: { status: "available", explanation: "ready" },
        subagents: { status: "available", explanation: "ready" },
        piReload: { status: "available", explanation: "ready" },
        secrets: { status: "available", explanation: "ready" },
      },
    },
  } as any;
  const catalog = {
    async resolve() {
      catalogResolveCount += 1;
      return catalogStale || (catalogStaleAfterAcquisition && catalogResolveCount > 1)
        ? { kind: "candidate-stale" as const }
        : { kind: "resolved" as const, candidate: selectedCandidate };
    },
  };
  const evidence = {
    async capture() { return inspectionSnapshot; },
    async validate() { return evidenceStale ? "stale" as const : "current" as const; },
  };
  const readiness = {
    async trust() { return "required" as const; },
    async configuration() {
      const configured = configurationStore.document !== undefined;
      return trustedInstallHarnessPlugin.configuration.options.map((option) => ({
        key: option.key,
        label: { text: option.label.value, escaped: false, truncated: false },
        valueKind: option.value.kind,
        required: option.required,
        sensitive: option.sensitive,
        defaultPresent: "default" in option.value && option.value.default !== undefined,
        state: configured ? "configured" as const : "missing" as const,
      }));
    },
    secretCustody() { return { status: "available" as const, explanation: "ready" }; },
  };

  const composition = createComposedTrustedInstallationService({
    catalog,
    candidateContent,
    inspector: { async inspect() { return { ok: true as const, value: trustedInstallHarnessPlugin, diagnostics: [] }; } },
    readiness,
    evidence,
    configuration: hostConfiguration.application,
    configurations: configurationStore as any,
    configurationPaths: { async normalizeAndInspect() { return { kind: "valid" as const, canonicalPath: "file:///private/valid" }; } },
    secretCustody: { status: "available", explanation: "ready" },
    userBaseDirectory: "/private/session",
    state: lifecycleState,
    mutations,
    projectTrust,
    projectRoots: projectRoots as any,
    lifecycle,
    clock: { nowEpochMilliseconds: () => 1_000 as never, monotonicMilliseconds: () => 0 },
    sessionIds: { async create() { sessionCounter += 1; return `20000000-0000-4000-8000-${sessionCounter.toString().padStart(12, "0")}` as never; } },
    hostEpoch: `sha256:${"9".repeat(64)}` as never,
    sha256: trustedInstallHarnessSha256,
  } as any);

  const request = {
    inspectionSnapshotId: deriveInspectionEvidenceSnapshotId(snapshotBinding as any, trustedInstallHarnessSha256),
    detailId: deriveInspectionDetailId(selectedSubject, trustedInstallHarnessSha256),
  };

  return {
    service: composition.application,
    close: composition.close,
    request,
    counters,
    state,
    configurationStore,
    secretStore,
    submission(session: any, values: Readonly<{ name?: string; token?: string }> = {}) {
      return {
        expectedVersion: session.version,
        nonSensitive: [{ key: "NAME", value: values.name ?? "trusted-name" }],
        sensitive: [{ key: "TOKEN", value: SensitiveValue.fromUnknown(values.token ?? "trusted-token") }],
        consent: { kind: "grant" as const, consentId: session.consent.consentId },
      };
    },
    controls: {
      setCatalogStale(value = true) { catalogStale = value; },
      setCatalogStaleAfterAcquisition(value = true) { catalogStaleAfterAcquisition = value; },
      setEvidenceStale(value = true) { evidenceStale = value; },
      failDiscards(count: number) { discardFailures = count; },
      commitConfigurationThenThrow(reconciliationFailures: number) {
        configurationStore.commitThenThrow = true;
        configurationStore.reconciliationReadFailures = reconciliationFailures;
      },
      stopAmbiguousConfigurationWrites() { configurationStore.commitThenThrow = false; },
      mutateConfigurationAfterNextAuthoritativeRead() { configurationStore.mutateAfterNextAuthoritativeRead = true; },
      mutateConfigurationDuringReload() { mutateConfigurationOnReload = true; },
      failSecretCleanup(count: number) { secretStore.cleanupFailures = count; },
      waitForReload() { return reloadStarted; },
      releaseReload() { reloadRelease?.(); },
      requireLifecycleRecovery() { lifecycleRecovery = true; },
    },
  };
}
