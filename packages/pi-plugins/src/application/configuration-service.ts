import {
  createPluginConfigurationDocument,
  deriveSecretLocator,
  digestConfigurationDescriptors,
  verifyPluginConfigurationDocument,
  ConfigurationWriteIdSchema,
  type PluginConfigurationDocument,
  type SecretLocator,
} from "../domain/configured-values.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import { PluginConfigurationRefSchema, type PluginConfigurationRef } from "../domain/state/references.js";
import {
  createScopeContext,
  toScopeReference,
  type ScopeContext,
} from "../domain/state/scope.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { BoundaryError, ErrorCodeRegistry } from "../domain/errors.js";
import { isAbortRejection } from "./abort-rejection.js";
import {
  validateConfigurationSubmission,
  ConfigurationValidationError,
  type ConfigurationSubmission,
  type ValidatedConfigurationSubmission,
} from "./configuration-validation.js";
import type { ConfigurationPathContext, ConfigurationPathPort } from "./ports/configuration-path.js";
import type { ProjectRootAuthorityPort } from "./ports/project-root-authority.js";
import type { ConfigurationWriteIdPort } from "./ports/configuration-write-id.js";
import {
  PluginConfigurationReadResultSchema,
  PluginConfigurationRemoveResultSchema,
  PluginConfigurationReplaceResultSchema,
  type PluginConfigurationStore,
} from "./ports/plugin-configuration-store.js";
import {
  SecretStoreCreateResultSchema,
  SecretStoreRemoveResultSchema,
  type SecretCreationEvidence,
  type SecretStore,
} from "./ports/secret-store.js";
import type { Sha256 } from "../domain/source.js";

export type SavePluginConfigurationRequest = Omit<ConfigurationSubmission, "existing">;

/** Narrow application surface bound by composition; resolution/stores remain private. */
export type BoundPluginConfigurationService = Readonly<{
  save(request: SavePluginConfigurationRequest, signal: AbortSignal): Promise<ConfigurationSaveResult>;
  remove(request: RemovePluginConfigurationRequest, signal: AbortSignal): Promise<ConfigurationRemovalResult>;
}>;

declare const configurationRecoveryCapabilityBrand: unique symbol;

export type ConfigurationRecoverySettlement =
  | Readonly<{ kind: "settled" }>
  | Readonly<{ kind: "stored"; document: PluginConfigurationDocument }>
  | Readonly<{ kind: "stale"; actualRevision: ContentDigest | null }>
  | Readonly<{ kind: "recovery-required" }>;

/** Opaque, bounded authority that owns every locator/evidence needed to settle recovery. */
export interface ConfigurationRecoveryCapability {
  readonly [configurationRecoveryCapabilityBrand]: true;
  settle(signal: AbortSignal): Promise<ConfigurationRecoverySettlement>;
}

export type ConfigurationCleanup = Readonly<{
  code: "SECRET_CLEANUP_REQUIRED";
  recovery: ConfigurationRecoveryCapability;
}>;

/** Safe opaque authority for a replace whose durable outcome could not be reconciled. */
export type ConfigurationReconciliation = Readonly<{
  code: "CONFIGURATION_RECONCILIATION_REQUIRED";
  recovery: ConfigurationRecoveryCapability;
}>;

export type ConfigurationSaveResult =
  | Readonly<{ kind: "stored"; document: PluginConfigurationDocument }>
  | Readonly<{
      kind: "stored-with-cleanup-required";
      document: PluginConfigurationDocument;
      cleanup: ConfigurationCleanup;
    }>
  | Readonly<{
      kind: "stale";
      actualRevision: ContentDigest | null;
    }>
  | Readonly<{
      kind: "stale-with-cleanup-required";
      actualRevision: ContentDigest | null;
      cleanup: ConfigurationCleanup;
    }>
  | Readonly<{
      kind: "ambiguous-with-recovery-required";
      recovery: ConfigurationReconciliation;
    }>
  | Readonly<{
      kind: "secret-collision";
      code: "SECRET_LOCATOR_COLLISION";
      locators: readonly SecretLocator[];
    }>;

export type RemovePluginConfigurationRequest = Readonly<{
  configurationRef: PluginConfigurationRef;
  plugin: PluginKey;
  scope: ScopeContext;
  descriptors: ConfigurationSubmission["descriptors"];
  pathContext?: ConfigurationPathContext;
  confirmedSecretDeletion: true;
}>;

export type ConfigurationRemovalResult =
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "stale"; removedLocators: readonly SecretLocator[] }>
  | Readonly<{
      kind: "partial-failure";
      code: "SECRET_REMOVAL_FAILED" | "CONFIGURATION_REMOVAL_FAILED";
      /** True when the authoritative document was already retired by CAS. */
      retired: boolean;
      removedLocators: readonly SecretLocator[];
      remainingLocators: readonly SecretLocator[];
    }>;

export class ConfigurationCleanupError extends Error {
  readonly code = "CONFIGURATION_CLEANUP_REQUIRED" as const;
  readonly operation: "save" | "remove";
  readonly cleanup: ConfigurationCleanup;
  readonly aborted: boolean;

  constructor(operation: "save" | "remove", cleanup: ConfigurationCleanup, aborted: boolean) {
    super("configuration operation requires credential cleanup");
    this.name = "ConfigurationCleanupError";
    this.operation = operation;
    this.cleanup = cleanup;
    this.aborted = aborted;
  }
}

function adapterFailure(operation: string, cleanup?: readonly SecretLocator[]): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation,
    message: cleanup === undefined
      ? "configuration adapter operation failed"
      : "configuration adapter operation failed and cleanup is required",
    ...(cleanup === undefined ? {} : {
      details: { cleanupRequired: true, locators: [...cleanup] },
    }),
  });
}

function assertAbort(signal: AbortSignal, error: unknown): never {
  if (signal.aborted) throw signal.reason;
  if (isAbortRejection(error)) throw error;
  throw error;
}

async function readConfiguration(
  configurations: PluginConfigurationStore,
  ref: PluginConfigurationRef,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<PluginConfigurationStore["read"]>>> {
  try {
    return PluginConfigurationReadResultSchema.parse(await configurations.read(ref, signal));
  } catch (error) {
    if (signal.aborted || isAbortRejection(error)) return assertAbort(signal, error);
    throw adapterFailure("readPluginConfiguration");
  }
}

function sameScope(left: ScopeContext, right: PluginConfigurationDocument["scope"]): boolean {
  const reference = toScopeReference(left);
  return reference.kind === right.kind &&
    (reference.kind === "user" || (right.kind === "project" && reference.projectKey === right.projectKey));
}

function verifyCurrentDocument(
  document: PluginConfigurationDocument,
  request: Readonly<{ configurationRef: PluginConfigurationRef; plugin: PluginKey; scope: ScopeContext; descriptors: ConfigurationSubmission["descriptors"] }>,
  sha256: Sha256,
): PluginConfigurationDocument {
  const verified = verifyPluginConfigurationDocument(document, request.descriptors, sha256);
  if (verified.configurationRef !== request.configurationRef || verified.plugin !== request.plugin || !sameScope(request.scope, verified.scope)) {
    throw new Error("configuration document identity does not match request");
  }
  return verified;
}

type ReplaceReconciliation =
  | Readonly<{
      kind: "active";
      document: PluginConfigurationDocument;
      /** Fresh locators that the current authority still references. */
      liveFreshLocators: readonly SecretLocator[];
    }>
  | Readonly<{ kind: "inactive"; actualRevision: ContentDigest | null }>
  | Readonly<{ kind: "unknown" }>;

/**
 * A replace rejection is not proof that the document stayed unchanged: an
 * adapter can commit and then lose the response or observe cancellation. The
 * store's authoritative read boundary is therefore consulted with a fresh
 * recovery signal before any fresh locator is removed.
 *
 * Revision equality proves that the candidate is current, but revision
 * inequality does not prove that its credentials are dead. A later writer can
 * validly derive a document from the candidate while preserving all or some of
 * its locators. Reconcile liveness per fresh locator so cleanup never relies on
 * revision lineage that the state contract does not expose.
 */
async function reconcileReplace(
  configurations: PluginConfigurationStore,
  ref: PluginConfigurationRef,
  candidate: PluginConfigurationDocument,
  freshLocators: readonly SecretLocator[],
  request: Readonly<{ configurationRef: PluginConfigurationRef; plugin: PluginKey; scope: ScopeContext; descriptors: ConfigurationSubmission["descriptors"] }>,
  sha256: Sha256,
): Promise<ReplaceReconciliation> {
  const recoverySignal = new AbortController().signal;
  try {
    const raw = PluginConfigurationReadResultSchema.parse(await configurations.read(ref, recoverySignal));
    if (raw.kind === "missing") return { kind: "inactive", actualRevision: null };
    const current = verifyCurrentDocument(raw.document, request, sha256);
    const currentLocators = new Set(current.secrets.map((entry) => entry.locator));
    const liveFreshLocators = freshLocators.filter((locator) => currentLocators.has(locator));
    if (current.revision === candidate.revision || liveFreshLocators.length > 0) {
      return { kind: "active", document: current, liveFreshLocators };
    }
    return { kind: "inactive", actualRevision: current.revision };
  } catch {
    // Do not guess from an adapter error or malformed read. The fresh
    // locators remain in custody and the caller receives locator-only recovery
    // evidence instead of a result that could break an active reference.
    return { kind: "unknown" };
  }
}

type OwnedSecretLocator = Readonly<{
  locator: SecretLocator;
  evidence: SecretCreationEvidence;
}>;

/**
 * Cleanup of credentials created by this operation requires the adapter-issued
 * evidence object. The locator is retained only for matching authority and
 * safe recovery reporting; it is never used as proof of ownership.
 */
async function cleanupOwnedLocators(
  secrets: SecretStore,
  owned: readonly OwnedSecretLocator[],
): Promise<OwnedSecretLocator[]> {
  // Cleanup is recovery work. Reusing an already-aborted caller signal would
  // turn a guaranteed cleanup attempt into an orphaning path.
  const cleanupSignal = new AbortController().signal;
  const failed: OwnedSecretLocator[] = [];
  for (const entry of owned) {
    try {
      const result = SecretStoreRemoveResultSchema.parse(await secrets.removeOwned(entry.evidence, cleanupSignal));
      void result;
    } catch {
      failed.push(entry);
    }
  }
  return failed;
}

/** Cleanup of an old locator is authorized only after document retirement/CAS. */
async function cleanupUnownedLocators(
  secrets: SecretStore,
  locators: readonly SecretLocator[],
): Promise<SecretLocator[]> {
  const cleanupSignal = new AbortController().signal;
  const failed: SecretLocator[] = [];
  for (const locator of locators) {
    try {
      const result = SecretStoreRemoveResultSchema.parse(await secrets.remove(locator, cleanupSignal));
      void result;
    } catch {
      failed.push(locator);
    }
  }
  return failed;
}

function recoveryCapability(
  settle: (signal: AbortSignal) => Promise<ConfigurationRecoverySettlement>,
): ConfigurationRecoveryCapability {
  return Object.freeze({ settle }) as ConfigurationRecoveryCapability;
}

function credentialCleanupRecovery(
  secrets: SecretStore,
  initialOwned: readonly OwnedSecretLocator[],
  initialUnowned: readonly SecretLocator[],
): ConfigurationRecoveryCapability {
  let owned = [...initialOwned];
  let unowned = [...initialUnowned];
  return recoveryCapability(async (signal) => {
    signal.throwIfAborted();
    owned = [...await cleanupOwnedLocators(secrets, owned)];
    unowned = [...await cleanupUnownedLocators(secrets, unowned)];
    return owned.length === 0 && unowned.length === 0
      ? { kind: "settled" }
      : { kind: "recovery-required" };
  });
}

function cleanupFailure(
  operation: "save" | "remove",
  secrets: SecretStore,
  owned: readonly OwnedSecretLocator[],
  unowned: readonly SecretLocator[],
  aborted: boolean,
): ConfigurationCleanupError | undefined {
  const cleanup = cleanupResult(secrets, owned, unowned);
  return cleanup === undefined ? undefined : new ConfigurationCleanupError(operation, cleanup, aborted);
}

function cleanupResult(
  secrets: SecretStore,
  owned: readonly OwnedSecretLocator[],
  unowned: readonly SecretLocator[],
): ConfigurationCleanup | undefined {
  return owned.length === 0 && unowned.length === 0
    ? undefined
    : { code: "SECRET_CLEANUP_REQUIRED", recovery: credentialCleanupRecovery(secrets, owned, unowned) };
}

function replaceRecovery(
  configurations: PluginConfigurationStore,
  secrets: SecretStore,
  ref: PluginConfigurationRef,
  candidate: PluginConfigurationDocument,
  owned: readonly OwnedSecretLocator[],
  current: PluginConfigurationDocument | undefined,
  request: Readonly<{ configurationRef: PluginConfigurationRef; plugin: PluginKey; scope: ScopeContext; descriptors: ConfigurationSubmission["descriptors"] }>,
  sha256: Sha256,
): ConfigurationRecoveryCapability {
  let settledAuthority: Extract<ConfigurationRecoverySettlement, { kind: "stored" | "stale" }> | undefined;
  let pendingOwned: readonly OwnedSecretLocator[] = [];
  let pendingUnowned: readonly SecretLocator[] = [];
  return recoveryCapability(async (signal) => {
    signal.throwIfAborted();
    if (settledAuthority === undefined) {
      const reconciliation = await reconcileReplace(
        configurations,
        ref,
        candidate,
        owned.map((entry) => entry.locator),
        request,
        sha256,
      );
      if (reconciliation.kind === "unknown") return { kind: "recovery-required" };
      if (reconciliation.kind === "inactive") {
        settledAuthority = { kind: "stale", actualRevision: reconciliation.actualRevision };
        pendingOwned = owned;
      } else {
        settledAuthority = { kind: "stored", document: reconciliation.document };
        const live = new Set(reconciliation.liveFreshLocators);
        pendingOwned = owned.filter((entry) => !live.has(entry.locator));
        const activeLocators = new Set(reconciliation.document.secrets.map((entry) => entry.locator));
        pendingUnowned = (current?.secrets.map((entry) => entry.locator) ?? [])
          .filter((locator) => !activeLocators.has(locator));
      }
    }
    pendingOwned = await cleanupOwnedLocators(secrets, pendingOwned);
    pendingUnowned = await cleanupUnownedLocators(secrets, pendingUnowned);
    return pendingOwned.length === 0 && pendingUnowned.length === 0
      ? settledAuthority
      : { kind: "recovery-required" };
  });
}

function ensureWriteId(value: unknown): ReturnType<typeof ConfigurationWriteIdSchema.parse> {
  return ConfigurationWriteIdSchema.parse(value);
}

function ensureRequestIdentity(
  request: SavePluginConfigurationRequest,
  sha256: Sha256,
  projectRoots: ProjectRootAuthorityPort | undefined,
): ScopeContext {
  PluginConfigurationRefSchema.parse(request.configurationRef);
  PluginKeySchema.parse(request.plugin);
  const scope = createScopeContext(request.scope, sha256);
  const pathScope = createScopeContext(request.pathContext.scope, sha256);
  if (scope.kind !== pathScope.kind || (scope.kind === "project" && pathScope.kind === "project" && scope.projectKey !== pathScope.projectKey)) {
    throw new Error("configuration path scope does not match request");
  }
  if (scope.kind === "project") {
    if (projectRoots === undefined) throw new Error("project configuration requires the project-root authority port");
    projectRoots.verify(request.pathContext.trustedProjectRoot, pathScope);
  }
  return scope;
}

function candidateDocument(
  request: SavePluginConfigurationRequest,
  scope: ScopeContext,
  validated: ValidatedConfigurationSubmission,
  fresh: readonly Readonly<{ key: string; locator: SecretLocator }>[],
  sha256: Sha256,
): PluginConfigurationDocument {
  const retained = validated.preservedSecrets.map((entry) => ({ key: entry.key, locator: entry.locator }));
  const secrets = [...retained, ...fresh].sort((left, right) => left.key.localeCompare(right.key));
  const document = createPluginConfigurationDocument({
    schemaVersion: 1,
    configurationRef: request.configurationRef,
    plugin: request.plugin,
    scope: toScopeReference(scope),
    descriptorDigest: digestConfigurationDescriptors(request.descriptors, sha256),
    values: validated.values,
    secrets,
  }, sha256);
  return verifyPluginConfigurationDocument(document, request.descriptors, sha256);
}

/** Save a complete non-sensitive document and its fresh secret locators with CAS. */
export async function savePluginConfiguration(
  request: SavePluginConfigurationRequest,
  dependencies: Readonly<{
    configurations: PluginConfigurationStore;
    secrets: SecretStore;
    paths: ConfigurationPathPort;
    writeIds: ConfigurationWriteIdPort;
    projectRoots?: ProjectRootAuthorityPort;
    sha256: Sha256;
  }>,
  signal: AbortSignal,
): Promise<ConfigurationSaveResult> {
  signal.throwIfAborted();
  let verifiedScope: ScopeContext;
  try {
    verifiedScope = ensureRequestIdentity(request, dependencies.sha256, dependencies.projectRoots);
  } catch {
    throw new ConfigurationValidationError("CONFIG_TYPE");
  }
  if (verifiedScope.kind === "project" && dependencies.projectRoots?.revalidate !== undefined) {
    try {
      await dependencies.projectRoots.revalidate(request.pathContext.trustedProjectRoot, verifiedScope, signal);
    } catch {
      throw new ConfigurationValidationError("CONFIG_TYPE");
    }
  }

  const currentRaw = await readConfiguration(dependencies.configurations, request.configurationRef, signal);
  let current: PluginConfigurationDocument | undefined;
  if (currentRaw.kind === "found") {
    try {
      current = verifyCurrentDocument(currentRaw.document, request, dependencies.sha256);
    } catch {
      throw new Error("current configuration document is invalid");
    }
  }

  const validated = await validateConfigurationSubmission({
    ...request,
    scope: verifiedScope,
    pathContext: { ...request.pathContext, scope: verifiedScope },
    ...(current === undefined ? {} : { existing: current }),
  }, dependencies.paths, signal);
  signal.throwIfAborted();

  let writeId: ReturnType<typeof ConfigurationWriteIdSchema.parse>;
  try {
    writeId = ensureWriteId(await dependencies.writeIds.create(signal));
  } catch (error) {
    if (signal.aborted || isAbortRejection(error)) return assertAbort(signal, error);
    throw adapterFailure("createConfigurationWriteId");
  }

  const fresh = validated.secrets.map((entry) => ({
    key: entry.key,
    locator: deriveSecretLocator({
      scope: toScopeReference(verifiedScope),
      plugin: request.plugin,
      configurationRef: request.configurationRef,
      key: entry.key,
      writeId,
    }, dependencies.sha256),
    value: entry.value,
  }));
  const document = candidateDocument(
    request,
    verifiedScope,
    validated,
    fresh.map(({ key, locator }) => ({ key, locator })),
    dependencies.sha256,
  );
  const freshLocators = fresh.map((entry) => entry.locator);
  const currentLocators = new Set(current?.secrets.map((entry) => entry.locator) ?? []);
  if (freshLocators.some((locator) => currentLocators.has(locator))) {
    throw new Error("configuration write id reused an active secret locator");
  }
  const owned: OwnedSecretLocator[] = [];

  for (const entry of fresh) {
    let creation: Awaited<ReturnType<SecretStore["put"]>>;
    try {
      signal.throwIfAborted();
      creation = SecretStoreCreateResultSchema.parse(await dependencies.secrets.put(entry.locator, entry.value, signal));
    } catch (error) {
      // An adapter error does not prove whether the native backend committed.
      // Only already-returned evidence can be used for cleanup; the current
      // locator is deliberately not guessed from its caller-supplied string.
      const failedCleanup = await cleanupOwnedLocators(dependencies.secrets, owned);
      const cleanupError = cleanupFailure("save", dependencies.secrets, failedCleanup, [], signal.aborted || isAbortRejection(error));
      if (cleanupError !== undefined) throw cleanupError;
      if (signal.aborted || isAbortRejection(error)) return assertAbort(signal, error);
      throw adapterFailure("putConfigurationSecret");
    }
    if (creation.kind === "collision") {
      const failedCleanup = await cleanupOwnedLocators(dependencies.secrets, owned);
      const cleanupError = cleanupFailure("save", dependencies.secrets, failedCleanup, [], false);
      if (cleanupError !== undefined) throw cleanupError;
      // Collision is a pre-CAS failure. No configuration mutation is allowed,
      // and the colliding credential has no ownership evidence for this op.
      return {
        kind: "secret-collision",
        code: "SECRET_LOCATOR_COLLISION",
        locators: [entry.locator],
      };
    }
    if (creation.locator !== entry.locator) {
      // A successful adapter result must bind its evidence to the locator the
      // candidate document will reference. Otherwise CAS could publish a
      // document whose locator was never created by this operation.
      const failedCleanup = await cleanupOwnedLocators(dependencies.secrets, [{
        locator: creation.locator,
        evidence: creation.evidence,
      }]);
      const cleanupError = cleanupFailure("save", dependencies.secrets, failedCleanup, [], false);
      if (cleanupError !== undefined) throw cleanupError;
      throw adapterFailure("putConfigurationSecret");
    }
    owned.push({ locator: entry.locator, evidence: creation.evidence });
  }

  let replacement: Awaited<ReturnType<PluginConfigurationStore["replace"]>>;
  try {
    signal.throwIfAborted();
    replacement = PluginConfigurationReplaceResultSchema.parse(await dependencies.configurations.replace({
      expectedRevision: current?.revision ?? null,
      document,
    }, signal));
  } catch (error) {
    const reconciliation = await reconcileReplace(
      dependencies.configurations,
      request.configurationRef,
      document,
      owned.map((entry) => entry.locator),
      { ...request, scope: verifiedScope },
      dependencies.sha256,
    );
    if (reconciliation.kind === "unknown") {
      return {
        kind: "ambiguous-with-recovery-required",
        recovery: {
          code: "CONFIGURATION_RECONCILIATION_REQUIRED",
          recovery: replaceRecovery(
            dependencies.configurations,
            dependencies.secrets,
            request.configurationRef,
            document,
            owned,
            current,
            { ...request, scope: verifiedScope },
            dependencies.sha256,
          ),
        },
      };
    }

    // The authoritative read proved the candidate inactive, so and only so is
    // it safe to delete fresh credentials after an ambiguous replace.
    if (reconciliation.kind === "inactive") {
      const failedCleanup = await cleanupOwnedLocators(dependencies.secrets, owned);
      const cleanupError = cleanupFailure("save", dependencies.secrets, failedCleanup, [], signal.aborted || isAbortRejection(error));
      if (cleanupError !== undefined) throw cleanupError;
      if (signal.aborted || isAbortRejection(error)) return assertAbort(signal, error);
      throw adapterFailure("replacePluginConfiguration");
    }

    // The replacement did commit, or a descendant now references at least one
    // locator that only this candidate could have introduced. The descendant's
    // revision is not a reason to delete the other candidate locators: clean
    // only fresh locators absent from the validated authoritative document.
    const liveFreshLocators = new Set(reconciliation.liveFreshLocators);
    const inactiveFreshLocators = freshLocators.filter((locator) => !liveFreshLocators.has(locator));
    const activeLocators = new Set(reconciliation.document.secrets.map((entry) => entry.locator));
    const superseded = (current?.secrets.map((entry) => entry.locator) ?? [])
      .filter((locator) => !activeLocators.has(locator));
    const failedOwnedCleanup = await cleanupOwnedLocators(
      dependencies.secrets,
      owned.filter((entry) => inactiveFreshLocators.includes(entry.locator)),
    );
    const failedSupersededCleanup = await cleanupUnownedLocators(dependencies.secrets, superseded);
    const cleanup = cleanupResult(dependencies.secrets, failedOwnedCleanup, failedSupersededCleanup);
    return cleanup === undefined
      ? { kind: "stored", document: reconciliation.document }
      : { kind: "stored-with-cleanup-required", document: reconciliation.document, cleanup };
  }

  if (replacement.kind === "stale") {
    // A stale response is not ownership evidence that the fresh locators are
    // inactive. Re-read authority first, including duplicate-ID races where a
    // winner may now reference the same locator.
    const reconciliation = await reconcileReplace(
      dependencies.configurations,
      request.configurationRef,
      document,
      owned.map((entry) => entry.locator),
      { ...request, scope: verifiedScope },
      dependencies.sha256,
    );
    if (reconciliation.kind === "unknown") {
      return {
        kind: "ambiguous-with-recovery-required",
        recovery: {
          code: "CONFIGURATION_RECONCILIATION_REQUIRED",
          recovery: replaceRecovery(
            dependencies.configurations,
            dependencies.secrets,
            request.configurationRef,
            document,
            owned,
            current,
            { ...request, scope: verifiedScope },
            dependencies.sha256,
          ),
        },
      };
    }
    const live = reconciliation.kind === "active"
      ? new Set(reconciliation.liveFreshLocators)
      : new Set<SecretLocator>();
    const inactiveOwned = owned.filter((entry) => !live.has(entry.locator));
    const failedCleanup = await cleanupOwnedLocators(dependencies.secrets, inactiveOwned);
    const cleanup = cleanupResult(dependencies.secrets, failedCleanup, []);
    if (reconciliation.kind === "active") {
      return cleanup === undefined
        ? { kind: "stored", document: reconciliation.document }
        : { kind: "stored-with-cleanup-required", document: reconciliation.document, cleanup };
    }
    if (signal.aborted) {
      const cleanupError = cleanupFailure("save", dependencies.secrets, failedCleanup, [], true);
      if (cleanupError !== undefined) throw cleanupError;
      return assertAbort(signal, signal.reason);
    }
    return cleanup === undefined
      ? { kind: "stale", actualRevision: replacement.actualRevision }
      : { kind: "stale-with-cleanup-required", actualRevision: replacement.actualRevision, cleanup };
  }

  const activeLocators = new Set(document.secrets.map((entry) => entry.locator));
  const superseded = (current?.secrets.map((entry) => entry.locator) ?? [])
    .filter((locator) => !activeLocators.has(locator));
  const failedCleanup = await cleanupUnownedLocators(dependencies.secrets, superseded);
  const cleanup = cleanupResult(dependencies.secrets, [], failedCleanup);
  // Once CAS wins, the new document is authoritative. Never roll it back on
  // cancellation; return cleanup evidence for any old locators that remain.
  return cleanup === undefined
    ? { kind: "stored", document }
    : { kind: "stored-with-cleanup-required", document, cleanup };
}

/** Explicitly confirmed removal; disable has no path to this service. */
export async function removePluginConfiguration(
  request: RemovePluginConfigurationRequest,
  dependencies: Readonly<{
    configurations: PluginConfigurationStore;
    secrets: SecretStore;
    projectRoots?: ProjectRootAuthorityPort;
    sha256: Sha256;
  }>,
  signal: AbortSignal,
): Promise<ConfigurationRemovalResult> {
  if (request.confirmedSecretDeletion !== true) throw new TypeError("secret deletion requires explicit confirmation");
  signal.throwIfAborted();
  const ref = PluginConfigurationRefSchema.parse(request.configurationRef);
  const verifiedScope = createScopeContext(request.scope, dependencies.sha256);
  if (verifiedScope.kind === "project") {
    const pathContext = request.pathContext;
    if (pathContext === undefined) throw new Error("project configuration removal requires a trusted root capability");
    const pathScope = createScopeContext(pathContext.scope, dependencies.sha256);
    if (pathScope.kind !== "project" || pathScope.projectKey !== verifiedScope.projectKey) {
      throw new Error("configuration path scope does not match request");
    }
    if (dependencies.projectRoots === undefined) throw new Error("project configuration removal requires the project-root authority port");
    if (dependencies.projectRoots.revalidate !== undefined) {
      await dependencies.projectRoots.revalidate(pathContext.trustedProjectRoot, pathScope, signal);
    } else {
      dependencies.projectRoots.verify(pathContext.trustedProjectRoot, pathScope);
    }
  }
  const verifiedRequest = { ...request, scope: verifiedScope };
  const currentRaw = await readConfiguration(dependencies.configurations, ref, signal);
  if (currentRaw.kind === "missing") return { kind: "missing" };

  let current: PluginConfigurationDocument;
  try {
    current = verifyCurrentDocument(currentRaw.document, verifiedRequest, dependencies.sha256);
  } catch {
    throw new Error("current configuration document is invalid");
  }

  // Retire the authoritative document first. A stale writer or a failed CAS
  // must leave both active references and their credentials untouched.
  let result: Awaited<ReturnType<PluginConfigurationStore["remove"]>>;
  try {
    result = PluginConfigurationRemoveResultSchema.parse(await dependencies.configurations.remove({
      ref,
      expectedRevision: current.revision,
      confirmedSecretDeletion: true,
    }, signal));
  } catch (error) {
    if (signal.aborted || isAbortRejection(error)) return assertAbort(signal, error);
    // A malformed/failed CAS response is not an authoritative removal result.
    // Keep the possible locator set in safe recovery details and do not delete
    // any credential until the retirement is positively acknowledged.
    throw adapterFailure("removePluginConfiguration", current.secrets.map((entry) => entry.locator));
  }
  if (result === "stale") return { kind: "stale", removedLocators: [] };
  if (result === "missing") return { kind: "missing" };

  // The document is now retired. Finish cleanup with a non-aborted recovery
  // signal so cancellation cannot strand credentials without evidence.
  const allLocators = current.secrets.map((entry) => entry.locator);
  const failedCleanup = await cleanupUnownedLocators(dependencies.secrets, allLocators);
  if (failedCleanup.length > 0) {
    const failed = new Set(failedCleanup);
    return {
      kind: "partial-failure",
      code: "SECRET_REMOVAL_FAILED",
      retired: true,
      removedLocators: allLocators.filter((locator) => !failed.has(locator)),
      remainingLocators: failedCleanup,
    };
  }
  return { kind: "removed" };
}
