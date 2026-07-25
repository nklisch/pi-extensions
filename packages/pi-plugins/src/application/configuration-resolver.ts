import type { ContentDigest } from "../domain/content-manifest.js";
import {
  CanonicalConfigurationPathSchema,
  ConfiguredValueSchema,
  PluginConfigurationDocumentSchemaV1,
  verifyPluginConfigurationDocument,
  type ConfiguredValue,
  type PluginConfigurationDocument,
} from "../domain/configured-values.js";
import {
  PluginConfigurationSchema,
  type ConfigurationOption,
  type PluginConfiguration,
  testConfigurationPattern,
} from "../domain/configuration.js";
import { PluginConfigurationRefSchema, type PluginConfigurationRef } from "../domain/state/references.js";
import {
  createScopeContext,
  ScopeReferenceSchema,
  toScopeReference,
  type ScopeContext,
} from "../domain/state/scope.js";
import type { TrustCandidate } from "../domain/trust-policy.js";
import { isAbortRejection } from "./abort-rejection.js";
import { authorizeTrustCandidate } from "./trust-service.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";
import type { ProjectRootAuthorityPort } from "./ports/project-root-authority.js";
import {
  PluginConfigurationReadResultSchema,
  type PluginConfigurationStore,
} from "./ports/plugin-configuration-store.js";
import { SecretStoreGetResultSchema, type SecretStore } from "./ports/secret-store.js";
import { ConfigurationPathResultSchema, type ConfigurationPathContext, type ConfigurationPathPort } from "./ports/configuration-path.js";
import { withSensitiveValue } from "./sensitive-value.js";
import { createResolvedConfiguration, type ResolvedConfiguration } from "./resolved-configuration.js";
import { validateConfigurationSubmission, type ValidatedConfigurationSubmission } from "./configuration-validation.js";
import { BoundaryError, ErrorCodeRegistry } from "../domain/errors.js";
import type { Sha256 } from "../domain/source.js";
import { isAutomaticUpdateAuthorizationEvidence, type AutomaticUpdateAuthorizationEvidence } from "./automatic-update-authorization.js";

export type ConfigurationResolutionCode =
  | "PROJECT_UNTRUSTED"
  | "TRUST_ABSENT"
  | "TRUST_REVOKED"
  | "TRUST_EVIDENCE_INVALID"
  | "CONFIGURATION_MISSING"
  | "CONFIGURATION_INVALID"
  | "CONFIGURATION_STALE"
  | "CONFIG_SECRET_MISSING"
  | "CONFIG_PATH_INVALID"
  | "CONFIG_PATH_MISSING"
  | "CONFIG_PATH_WRONG_KIND"
  | "CONFIG_CALLBACK_FAILED"
  | "CONFIG_DISPOSED";

export class ConfigurationResolutionError extends Error {
  readonly code: ConfigurationResolutionCode;

  constructor(code: ConfigurationResolutionCode) {
    super("plugin configuration could not be resolved");
    this.name = "ConfigurationResolutionError";
    this.code = code;
  }
}

function adapterFailure(operation: string): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation,
    message: "configuration resolution adapter operation failed",
  });
}

function scopeMatches(scope: ScopeContext, reference: ReturnType<typeof toScopeReference>): boolean {
  return reference.kind === scope.kind &&
    (reference.kind === "user" || (scope.kind === "project" && reference.projectKey === scope.projectKey));
}

function sameConfiguredValue(left: ConfiguredValue, right: ConfiguredValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function optionMap(descriptors: PluginConfiguration): Map<string, ConfigurationOption> {
  return new Map(descriptors.options.map((option) => [option.key, option]));
}

function configuredInput(document: PluginConfigurationDocument): Record<string, unknown> {
  return Object.fromEntries(document.values.map((entry) => [entry.key, entry.value.value]));
}

function mapValidationCode(error: unknown): ConfigurationResolutionError {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "CONFIG_PATH_MISSING" || code === "CONFIG_PATH_WRONG_KIND" || code === "CONFIG_PATH_INVALID") {
      return new ConfigurationResolutionError(code);
    }
  }
  return new ConfigurationResolutionError("CONFIGURATION_INVALID");
}

function parseSecret(option: ConfigurationOption, plaintext: string): unknown {
  switch (option.value.kind) {
    case "string":
      if (option.value.pattern !== undefined && !testConfigurationPattern(option.value.pattern, plaintext)) {
        throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
      }
      return plaintext;
    case "number": {
      const value = Number(plaintext);
      if (!Number.isFinite(value) || (option.value.min !== undefined && value < option.value.min) || (option.value.max !== undefined && value > option.value.max)) {
        throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
      }
      return value;
    }
    case "boolean":
      if (plaintext !== "true" && plaintext !== "false") throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
      return plaintext === "true";
    case "strings": {
      let value: unknown;
      try { value = JSON.parse(plaintext); } catch { throw new ConfigurationResolutionError("CONFIGURATION_INVALID"); }
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
      if ((option.value.minItems !== undefined && value.length < option.value.minItems) || (option.value.maxItems !== undefined && value.length > option.value.maxItems)) {
        throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
      }
      return value;
    }
    case "directory":
    case "file":
      return plaintext;
    default:
      return assertNever(option.value);
  }
}

async function resolvePath(
  option: ConfigurationOption,
  value: string,
  paths: ConfigurationPathPort,
  context: ConfigurationPathContext,
  signal: AbortSignal,
): Promise<ConfiguredValue> {
  const descriptor = option.value;
  if (descriptor.kind !== "file" && descriptor.kind !== "directory") throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
  const expected = descriptor.kind === "file" ? "file" : "directory";
  let result: Awaited<ReturnType<ConfigurationPathPort["normalizeAndInspect"]>>;
  try {
    result = ConfigurationPathResultSchema.parse(await paths.normalizeAndInspect({ value, expected, mustExist: descriptor.mustExist, context }, signal));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isAbortRejection(error)) throw error;
    throw adapterFailure("resolveConfigurationPath");
  }
  signal.throwIfAborted();
  switch (result.kind) {
    case "valid": return { kind: expected, value: CanonicalConfigurationPathSchema.parse(result.canonicalPath) };
    case "missing": throw new ConfigurationResolutionError("CONFIG_PATH_MISSING");
    case "wrong-kind": throw new ConfigurationResolutionError("CONFIG_PATH_WRONG_KIND");
    case "invalid": throw new ConfigurationResolutionError("CONFIG_PATH_INVALID");
    default: return assertNever(result);
  }
}

async function readDocument(
  configurations: PluginConfigurationStore,
  ref: PluginConfigurationRef,
  signal: AbortSignal,
): Promise<PluginConfigurationDocument | undefined> {
  try {
    const result = PluginConfigurationReadResultSchema.parse(await configurations.read(ref, signal));
    return result.kind === "found" ? result.document : undefined;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isAbortRejection(error)) throw error;
    throw adapterFailure("readPluginConfigurationForResolution");
  }
}

async function fetchSecrets(
  document: PluginConfigurationDocument,
  descriptors: PluginConfiguration,
  dependencies: Readonly<{ secrets: SecretStore; paths: ConfigurationPathPort }>,
  pathContext: ConfigurationPathContext,
  signal: AbortSignal,
): Promise<readonly Readonly<{ key: string; value: ConfiguredValue }>[]> {
  const options = optionMap(descriptors);
  const resolved: Array<{ key: string; value: ConfiguredValue }> = [];
  for (const entry of document.secrets) {
    signal.throwIfAborted();
    const option = options.get(entry.key);
    if (option === undefined || !option.sensitive) throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
    let result: Awaited<ReturnType<SecretStore["get"]>>;
    try {
      result = SecretStoreGetResultSchema.parse(await dependencies.secrets.get(entry.locator, signal));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (isAbortRejection(error)) throw error;
      throw adapterFailure("getPluginConfigurationSecret");
    }
    signal.throwIfAborted();
    if (result.kind === "missing") {
      if (option.required) throw new ConfigurationResolutionError("CONFIG_SECRET_MISSING");
      continue;
    }
    const typed = withSensitiveValue(result.value, (plaintext) => parseSecret(option, plaintext));
    if (option.value.kind === "directory" || option.value.kind === "file") {
      resolved.push({ key: entry.key, value: await resolvePath(option, typed as string, dependencies.paths, pathContext, signal) });
    } else {
      resolved.push({ key: entry.key, value: ConfiguredValueSchema.parse({ kind: option.value.kind, value: typed }) });
    }
  }
  return resolved;
}

function ensureDocumentIdentity(
  document: PluginConfigurationDocument,
  candidate: TrustCandidate,
  ref: PluginConfigurationRef,
  pathContext: ConfigurationPathContext,
): void {
  if (document.configurationRef !== ref || document.plugin !== candidate.evidence.plugin) throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
  const expectedScope = ScopeReferenceSchema.parse(candidate.evidence.scope);
  if (!scopeMatches(pathContext.scope, expectedScope) || !scopeMatches(pathContext.scope, document.scope)) throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
}

function validateDocumentValues(
  document: PluginConfigurationDocument,
  validated: ValidatedConfigurationSubmission,
): void {
  const valuesByKey = new Map(validated.values.map((entry) => [entry.key, entry.value]));
  for (const entry of document.values) {
    const value = valuesByKey.get(entry.key);
    if (value === undefined || !sameConfiguredValue(value, entry.value)) throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
  }
}

/** Resolve secrets only inside the callback immediately before execution. */
async function resolvePluginConfiguration(
  request: Readonly<{
    candidate: TrustCandidate;
    trustRecords: readonly import("../domain/state/trust-state.js").TrustStateRecord[];
    configurationRef: PluginConfigurationRef | undefined;
    expectedConfigurationRevision?: ContentDigest;
    descriptors: PluginConfiguration;
    pathContext: ConfigurationPathContext;
  }>,
  dependencies: Readonly<{
    projectTrust: ProjectTrustPort;
    configurations: PluginConfigurationStore;
    secrets: SecretStore;
    paths: ConfigurationPathPort;
    projectRoots?: ProjectRootAuthorityPort;
    sha256: Sha256;
  }>,
  signal: AbortSignal,
  use: (configuration: ResolvedConfiguration) => Promise<void>,
  authorization: AutomaticUpdateAuthorizationEvidence | undefined,
): Promise<void> {
  signal.throwIfAborted();
  let verifiedScope: ScopeContext;
  try {
    verifiedScope = createScopeContext(request.pathContext.scope, dependencies.sha256);
    if (verifiedScope.kind === "project") {
      if (dependencies.projectRoots === undefined) throw new Error("project configuration requires the project-root authority port");
      if (dependencies.projectRoots.revalidate !== undefined) {
        await dependencies.projectRoots.revalidate(request.pathContext.trustedProjectRoot, verifiedScope, signal);
      } else {
        dependencies.projectRoots.verify(request.pathContext.trustedProjectRoot, verifiedScope);
      }
    }
  } catch {
    throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
  }
  const verifiedPathContext: ConfigurationPathContext = { ...request.pathContext, scope: verifiedScope };
  const trustAuthorization = authorization === undefined
    ? await authorizeTrustCandidate({ candidate: request.candidate, records: request.trustRecords, scope: verifiedScope }, dependencies, signal)
    : (() => {
        if (!isAutomaticUpdateAuthorizationEvidence(authorization) || authorization.scope.kind !== verifiedScope.kind || authorization.plugin !== request.candidate.evidence.plugin) {
          return { kind: "denied" as const, code: "TRUST_EVIDENCE_INVALID" as const };
        }
        return { kind: "authorized" as const, subject: request.candidate.subject };
      })();
  if (trustAuthorization.kind === "denied") throw new ConfigurationResolutionError(trustAuthorization.code);
  let descriptors: PluginConfiguration;
  try {
    descriptors = PluginConfigurationSchema.parse(request.descriptors);
  } catch {
    throw new ConfigurationResolutionError("CONFIGURATION_INVALID");
  }
  const candidateScope = ScopeReferenceSchema.parse(request.candidate.evidence.scope);
  if (!scopeMatches(verifiedScope, candidateScope)) throw new ConfigurationResolutionError("CONFIGURATION_INVALID");

  let entries: Array<{ key: string; value: ConfiguredValue }> = [];
  if (request.configurationRef === undefined) {
    if (descriptors.options.length > 0) throw new ConfigurationResolutionError("CONFIGURATION_MISSING");
  } else {
    const ref = PluginConfigurationRefSchema.parse(request.configurationRef);
    const rawDocument = await readDocument(dependencies.configurations, ref, signal);
    if (rawDocument === undefined) throw new ConfigurationResolutionError("CONFIGURATION_MISSING");
    const document = PluginConfigurationDocumentSchemaV1.parse(rawDocument);
    ensureDocumentIdentity(document, request.candidate, ref, verifiedPathContext);
    let validated: ValidatedConfigurationSubmission;
    try {
      const verified = verifyPluginConfigurationDocument(document, descriptors, dependencies.sha256);
      if (request.expectedConfigurationRevision !== undefined && verified.revision !== request.expectedConfigurationRevision) {
        throw new ConfigurationResolutionError("CONFIGURATION_STALE");
      }
      const rawValues = configuredInput(verified);
      validated = await validateConfigurationSubmission({
        configurationRef: ref,
        plugin: request.candidate.evidence.plugin,
        scope: verifiedScope,
        descriptors,
        values: rawValues,
        existing: verified,
        pathContext: verifiedPathContext,
      }, dependencies.paths, signal);
      validateDocumentValues(verified, validated);
      entries = validated.values.map((entry) => ({ key: entry.key, value: entry.value }));
      const secrets = await fetchSecrets(verified, descriptors, dependencies, verifiedPathContext, signal);
      entries = [...entries, ...secrets];
    } catch (error) {
      if (error instanceof ConfigurationResolutionError || error instanceof BoundaryError) throw error;
      if (signal.aborted) throw signal.reason;
      if (isAbortRejection(error)) throw error;
      throw mapValidationCode(error);
    }
  }

  const facade = createResolvedConfiguration(entries);
  try {
    // The callback's completion value is intentionally discarded. Only the
    // callback-scoped facade can observe plaintext; no generic result crosses
    // this boundary.
    await use(facade);
    return undefined;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isAbortRejection(error)) throw error;
    throw new ConfigurationResolutionError("CONFIG_CALLBACK_FAILED");
  } finally {
    facade.dispose();
  }
}

export async function withResolvedPluginConfiguration(
  request: Readonly<{
    candidate: TrustCandidate;
    trustRecords: readonly import("../domain/state/trust-state.js").TrustStateRecord[];
    configurationRef: PluginConfigurationRef | undefined;
    expectedConfigurationRevision?: ContentDigest;
    descriptors: PluginConfiguration;
    pathContext: ConfigurationPathContext;
  }>,
  dependencies: Readonly<{
    projectTrust: ProjectTrustPort;
    configurations: PluginConfigurationStore;
    secrets: SecretStore;
    paths: ConfigurationPathPort;
    projectRoots?: ProjectRootAuthorityPort;
    sha256: Sha256;
  }>,
  signal: AbortSignal,
  use: (configuration: ResolvedConfiguration) => Promise<void>,
): Promise<void> {
  return resolvePluginConfiguration(request, dependencies, signal, use, undefined);
}

/** Package-internal automatic path; the index deliberately does not export it. */
export async function withAuthorizedPluginConfiguration(
  request: Readonly<{
    candidate: TrustCandidate;
    trustRecords: readonly import("../domain/state/trust-state.js").TrustStateRecord[];
    configurationRef: PluginConfigurationRef | undefined;
    expectedConfigurationRevision?: ContentDigest;
    descriptors: PluginConfiguration;
    pathContext: ConfigurationPathContext;
  }>,
  authorization: AutomaticUpdateAuthorizationEvidence,
  dependencies: Readonly<{
    projectTrust: ProjectTrustPort;
    configurations: PluginConfigurationStore;
    secrets: SecretStore;
    paths: ConfigurationPathPort;
    projectRoots?: ProjectRootAuthorityPort;
    sha256: Sha256;
  }>,
  signal: AbortSignal,
  use: (configuration: ResolvedConfiguration) => Promise<void>,
): Promise<void> {
  return resolvePluginConfiguration(request, dependencies, signal, use, authorization);
}

function assertNever(value: never): never {
  throw new Error(`unhandled configuration resolution result: ${String(value)}`);
}
