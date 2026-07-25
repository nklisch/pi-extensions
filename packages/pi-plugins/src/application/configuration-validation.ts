import { z } from "zod";
import {
  ConfigurationKeySchema,
  PluginConfigurationSchema,
  type ConfigurationOption,
  type PluginConfiguration,
  testConfigurationPattern,
} from "../domain/configuration.js";
import {
  CanonicalConfigurationPathSchema,
  ConfiguredValueSchema,
  PluginConfigurationDocumentSchemaV1,
  type ConfiguredValue,
  type PluginConfigurationDocument,
  type SecretLocator,
} from "../domain/configured-values.js";
import {
  PluginConfigurationRefSchema,
  type PluginConfigurationRef,
} from "../domain/state/references.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { isVerifiedScopeContext, ScopeContextSchema, type ScopeContext } from "../domain/state/scope.js";
import { ConfigurationPathResultSchema, type ConfigurationPathContext, type ConfigurationPathPort } from "./ports/configuration-path.js";
import { SensitiveValue, withSensitiveValue } from "./sensitive-value.js";

export type ConfigurationSubmission = Readonly<{
  configurationRef: PluginConfigurationRef;
  plugin: PluginKey;
  scope: ScopeContext;
  descriptors: PluginConfiguration;
  values?: Readonly<Record<string, unknown>>;
  unset?: readonly string[];
  existing?: PluginConfigurationDocument;
  pathContext: ConfigurationPathContext;
}>;

export type ValidatedConfigurationValue = Readonly<{
  key: string;
  value: ConfiguredValue;
}>;

export type ValidatedConfigurationSecret = Readonly<{
  key: string;
  value: SensitiveValue;
}>;

/**
 * Internal application data. It is deliberately not exported from the package
 * barrel; JSON conversion of the only sensitive field remains redacted.
 */
export type ValidatedConfigurationSubmission = Readonly<{
  configurationRef: PluginConfigurationRef;
  plugin: PluginKey;
  scope: ScopeContext;
  descriptors: PluginConfiguration;
  values: readonly ValidatedConfigurationValue[];
  secrets: readonly ValidatedConfigurationSecret[];
  preservedSecrets: readonly Readonly<{ key: string; locator: SecretLocator }>[];
  unsetSecrets: readonly string[];
}>;

export type ConfigurationValidationCode =
  | "CONFIG_UNKNOWN_KEY"
  | "CONFIG_DUPLICATE_INPUT"
  | "CONFIG_REQUIRED"
  | "CONFIG_TYPE"
  | "CONFIG_PATTERN"
  | "CONFIG_BOUNDS"
  | "CONFIG_PATH_INVALID"
  | "CONFIG_PATH_MISSING"
  | "CONFIG_PATH_WRONG_KIND"
  | "CONFIG_PATH_ADAPTER_FAILED";

export const ConfigurationValidationIssueSchema = z.object({
  code: z.enum([
    "CONFIG_UNKNOWN_KEY", "CONFIG_DUPLICATE_INPUT", "CONFIG_REQUIRED", "CONFIG_TYPE",
    "CONFIG_PATTERN", "CONFIG_BOUNDS", "CONFIG_PATH_INVALID", "CONFIG_PATH_MISSING",
    "CONFIG_PATH_WRONG_KIND", "CONFIG_PATH_ADAPTER_FAILED",
  ]),
  key: ConfigurationKeySchema.optional(),
}).strict().readonly();
export type ConfigurationValidationIssue = z.infer<typeof ConfigurationValidationIssueSchema>;
export type ConfigurationValidationResult =
  | Readonly<{ kind: "valid"; submission: ValidatedConfigurationSubmission }>
  | Readonly<{ kind: "invalid"; issues: readonly ConfigurationValidationIssue[] }>;

export class ConfigurationValidationError extends Error {
  readonly code: ConfigurationValidationCode;

  constructor(code: ConfigurationValidationCode, _untrustedKey?: string) {
    // The offending key is intentionally not retained. Error objects are
    // routinely serialized by hosts, and configuration keys can be attacker-
    // controlled secret-shaped strings.
    super("configuration submission is invalid");
    this.name = "ConfigurationValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Compare(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.byteLength - b.byteLength;
}

function parseSubmission(request: ConfigurationSubmission): ConfigurationSubmission {
  if (!isRecord(request)) throw new ConfigurationValidationError("CONFIG_TYPE");
  const configurationRef = PluginConfigurationRefSchema.parse(request.configurationRef);
  const plugin = PluginKeySchema.parse(request.plugin);
  const scope = ScopeContextSchema.parse(request.scope);
  const pathContext = request.pathContext;
  if (pathContext === null || typeof pathContext !== "object") {
    throw new ConfigurationValidationError("CONFIG_TYPE");
  }
  const pathScope = ScopeContextSchema.parse(pathContext.scope);
  if (pathScope.kind !== scope.kind || (pathScope.kind === "project" && scope.kind === "project" && pathScope.projectKey !== scope.projectKey)) {
    throw new ConfigurationValidationError("CONFIG_TYPE");
  }
  if (pathScope.kind === "project") {
    // The application service performs the cryptographic/capability check with
    // its injected hash port. This structural gate ensures a project request
    // cannot silently fall back to the legacy arbitrary base string.
    if (!isVerifiedScopeContext(request.scope) || !isVerifiedScopeContext(pathContext.scope) || pathContext.trustedProjectRoot === undefined || pathContext.trustedBaseDirectory !== undefined) {
      throw new ConfigurationValidationError("CONFIG_TYPE");
    }
  } else if (typeof pathContext.trustedBaseDirectory !== "string" || pathContext.trustedBaseDirectory.length === 0 || pathContext.trustedProjectRoot !== undefined) {
    throw new ConfigurationValidationError("CONFIG_TYPE");
  }
  const descriptors = PluginConfigurationSchema.parse(request.descriptors);
  if (!isRecord(request.values ?? {})) throw new ConfigurationValidationError("CONFIG_TYPE");
  const unset = request.unset ?? [];
  if (!Array.isArray(unset)) throw new ConfigurationValidationError("CONFIG_TYPE");
  const parsedUnset = unset.map((key) => ConfigurationKeySchema.parse(key));
  const seenUnset = new Set<string>();
  for (const key of parsedUnset) {
    if (seenUnset.has(key)) throw new ConfigurationValidationError("CONFIG_DUPLICATE_INPUT", key);
    seenUnset.add(key);
  }
  const values = request.values ?? {};
  const descriptorKeys = new Set(descriptors.options.map((option) => option.key));
  for (const key of Object.keys(values)) {
    if (!ConfigurationKeySchema.safeParse(key).success || !descriptorKeys.has(key)) throw new ConfigurationValidationError("CONFIG_UNKNOWN_KEY", key);
    if (seenUnset.has(key)) throw new ConfigurationValidationError("CONFIG_DUPLICATE_INPUT", key);
  }
  for (const key of parsedUnset) {
    if (!descriptorKeys.has(key)) throw new ConfigurationValidationError("CONFIG_UNKNOWN_KEY", key);
  }
  const existing = request.existing === undefined
    ? undefined
    : PluginConfigurationDocumentSchemaV1.parse(request.existing);
  return {
    configurationRef,
    plugin,
    scope,
    descriptors,
    values,
    unset: parsedUnset,
    ...(existing === undefined ? {} : { existing }),
    pathContext: {
      scope: pathScope,
      ...(pathContext.trustedBaseDirectory === undefined ? {} : { trustedBaseDirectory: pathContext.trustedBaseDirectory }),
      ...(pathContext.trustedProjectRoot === undefined ? {} : { trustedProjectRoot: pathContext.trustedProjectRoot }),
    },
  };
}

function descriptorMap(descriptors: PluginConfiguration): Map<string, ConfigurationOption> {
  return new Map(descriptors.options.map((option) => [option.key, option]));
}

function existingSecrets(existing: PluginConfigurationDocument | undefined): Map<string, SecretLocator> {
  return new Map(existing?.secrets.map((entry) => [entry.key, entry.locator]) ?? []);
}

function failType(key: string): never {
  throw new ConfigurationValidationError("CONFIG_TYPE", key);
}

function validateNonSensitiveValue(
  option: ConfigurationOption,
  input: unknown,
  key: string,
): unknown {
  switch (option.value.kind) {
    case "string":
      if (typeof input !== "string") failType(key);
      if (option.value.pattern !== undefined && !testConfigurationPattern(option.value.pattern, input)) {
        throw new ConfigurationValidationError("CONFIG_PATTERN", key);
      }
      return { kind: "string", value: input } satisfies ConfiguredValue;
    case "number":
      if (typeof input !== "number" || !Number.isFinite(input)) failType(key);
      if ((option.value.min !== undefined && input < option.value.min) ||
          (option.value.max !== undefined && input > option.value.max)) {
        throw new ConfigurationValidationError("CONFIG_BOUNDS", key);
      }
      return { kind: "number", value: input } satisfies ConfiguredValue;
    case "boolean":
      if (typeof input !== "boolean") failType(key);
      return { kind: "boolean", value: input } satisfies ConfiguredValue;
    case "strings":
      if (!Array.isArray(input) || !input.every((value) => typeof value === "string")) failType(key);
      if ((option.value.minItems !== undefined && input.length < option.value.minItems) ||
          (option.value.maxItems !== undefined && input.length > option.value.maxItems)) {
        throw new ConfigurationValidationError("CONFIG_BOUNDS", key);
      }
      return { kind: "strings", value: input } satisfies ConfiguredValue;
    case "directory":
    case "file":
      if (typeof input !== "string") failType(key);
      return input;
    default:
      return assertNever(option.value);
  }
}

function parseSensitiveText(option: ConfigurationOption, plaintext: string, key: string): unknown {
  switch (option.value.kind) {
    case "string":
      if (option.value.pattern !== undefined && !testConfigurationPattern(option.value.pattern, plaintext)) {
        throw new ConfigurationValidationError("CONFIG_PATTERN", key);
      }
      return plaintext;
    case "number": {
      const number = Number(plaintext);
      if (!Number.isFinite(number)) failType(key);
      if ((option.value.min !== undefined && number < option.value.min) ||
          (option.value.max !== undefined && number > option.value.max)) {
        throw new ConfigurationValidationError("CONFIG_BOUNDS", key);
      }
      return number;
    }
    case "boolean":
      if (plaintext !== "true" && plaintext !== "false") failType(key);
      return plaintext === "true";
    case "strings": {
      let parsed: unknown;
      try { parsed = JSON.parse(plaintext); } catch { failType(key); }
      if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) failType(key);
      if ((option.value.minItems !== undefined && parsed.length < option.value.minItems) ||
          (option.value.maxItems !== undefined && parsed.length > option.value.maxItems)) {
        throw new ConfigurationValidationError("CONFIG_BOUNDS", key);
      }
      return parsed;
    }
    case "directory":
    case "file":
      return plaintext;
    default:
      return assertNever(option.value);
  }
}

async function normalizePath(
  option: ConfigurationOption,
  value: string,
  pathPort: ConfigurationPathPort,
  context: ConfigurationPathContext,
  signal: AbortSignal,
  key: string,
): Promise<ConfiguredValue> {
  signal.throwIfAborted();
  const descriptor = option.value;
  if (descriptor.kind !== "file" && descriptor.kind !== "directory") {
    throw new ConfigurationValidationError("CONFIG_TYPE", key);
  }
  const expected = descriptor.kind === "file" ? "file" : "directory";
  let result: Awaited<ReturnType<ConfigurationPathPort["normalizeAndInspect"]>>;
  try {
    result = ConfigurationPathResultSchema.parse(await pathPort.normalizeAndInspect({
      value,
      expected,
      mustExist: descriptor.mustExist,
      context,
    }, signal));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && (error.name === "AbortError" || (error as { code?: unknown }).code === "ABORT_ERR")) throw error;
    throw new ConfigurationValidationError("CONFIG_PATH_ADAPTER_FAILED", key);
  }
  signal.throwIfAborted();
  switch (result.kind) {
    case "valid": return { kind: expected, value: CanonicalConfigurationPathSchema.parse(result.canonicalPath) };
    case "missing": throw new ConfigurationValidationError("CONFIG_PATH_MISSING", key);
    case "wrong-kind": throw new ConfigurationValidationError("CONFIG_PATH_WRONG_KIND", key);
    case "invalid": throw new ConfigurationValidationError("CONFIG_PATH_INVALID", key);
    default: return assertNever(result);
  }
}

/** Validate and normalize a complete submission without making any writes. */
async function validateConfigurationSubmissionFailFast(
  request: ConfigurationSubmission,
  pathPort: ConfigurationPathPort,
  signal: AbortSignal,
): Promise<ValidatedConfigurationSubmission> {
  signal.throwIfAborted();
  const parsed = parseSubmission(request);
  const options = descriptorMap(parsed.descriptors);
  const valuesInput = parsed.values ?? {};
  const unset = new Set(parsed.unset ?? []);
  const existing = existingSecrets(parsed.existing);
  // Resolve omissions before invoking the path adapter. This keeps validation
  // fail-fast and avoids observable path effects for a submission that was
  // already incomplete on pure descriptor rules.
  for (const option of parsed.descriptors.options) {
    if (Object.prototype.hasOwnProperty.call(valuesInput, option.key) || unset.has(option.key)) continue;
    if (option.sensitive) {
      if (option.required && !existing.has(option.key)) throw new ConfigurationValidationError("CONFIG_REQUIRED", option.key);
    } else if (option.required && !("default" in option.value && option.value.default !== undefined)) {
      throw new ConfigurationValidationError("CONFIG_REQUIRED", option.key);
    }
  }
  // Run all non-path checks before the first adapter call. A malformed
  // scalar/secret must not cause a filesystem observation as a side effect.
  for (const key of Object.keys(valuesInput).sort(utf8Compare)) {
    const option = options.get(key);
    if (option === undefined) throw new ConfigurationValidationError("CONFIG_UNKNOWN_KEY", key);
    if (option.value.kind === "directory" || option.value.kind === "file") continue;
    const input = valuesInput[key];
    if (option.sensitive) {
      const secret = SensitiveValue.fromUnknown(input);
      withSensitiveValue(secret, (plaintext) => parseSensitiveText(option, plaintext, key));
    } else {
      validateNonSensitiveValue(option, input, key);
    }
  }
  const values: ValidatedConfigurationValue[] = [];
  const secrets: ValidatedConfigurationSecret[] = [];
  const preservedSecrets: Array<{ key: string; locator: SecretLocator }> = [];
  const unsetSecrets: string[] = [];

  for (const key of Object.keys(valuesInput).sort(utf8Compare)) {
    const option = options.get(key);
    if (option === undefined) throw new ConfigurationValidationError("CONFIG_UNKNOWN_KEY", key);
    signal.throwIfAborted();
    const input = valuesInput[key];
    if (option.sensitive) {
      const secret = SensitiveValue.fromUnknown(input);
      const typed = withSensitiveValue(secret, (plaintext) => parseSensitiveText(option, plaintext, key));
      if (option.value.kind === "directory" || option.value.kind === "file") {
        const normalized = await normalizePath(option, typed as string, pathPort, parsed.pathContext, signal, key);
        secrets.push({ key, value: SensitiveValue.fromUnknown(normalized.value) });
      } else {
        // Parsing above verifies type/constraints without copying the value to
        // any diagnostic shape; the original wrapper remains the custody value.
        secrets.push({ key, value: secret });
      }
      continue;
    }
    const typed = validateNonSensitiveValue(option, input, key);
    if (option.value.kind === "directory" || option.value.kind === "file") {
      values.push({ key, value: await normalizePath(option, typed as string, pathPort, parsed.pathContext, signal, key) });
    } else {
      values.push({ key, value: ConfiguredValueSchema.parse(typed) });
    }
  }

  for (const option of parsed.descriptors.options) {
    const key = option.key;
    if (Object.prototype.hasOwnProperty.call(valuesInput, key)) continue;
    if (unset.has(key)) {
      if (option.sensitive && option.required) throw new ConfigurationValidationError("CONFIG_REQUIRED", key);
      if (option.sensitive) unsetSecrets.push(key);
      continue;
    }
    if (option.sensitive) {
      const locator = existing.get(key);
      if (locator !== undefined) preservedSecrets.push({ key, locator });
      else if (option.required) throw new ConfigurationValidationError("CONFIG_REQUIRED", key);
      continue;
    }
    if ("default" in option.value && option.value.default !== undefined) {
      const typed = validateNonSensitiveValue(option, option.value.default, key);
      if (option.value.kind === "directory" || option.value.kind === "file") {
        values.push({ key, value: await normalizePath(option, typed as string, pathPort, parsed.pathContext, signal, key) });
      } else {
        values.push({ key, value: ConfiguredValueSchema.parse(typed) });
      }
    } else if (option.required) {
      throw new ConfigurationValidationError("CONFIG_REQUIRED", key);
    }
  }

  values.sort((left, right) => utf8Compare(left.key, right.key));
  secrets.sort((left, right) => utf8Compare(left.key, right.key));
  preservedSecrets.sort((left, right) => utf8Compare(left.key, right.key));
  unsetSecrets.sort(utf8Compare);
  return {
    configurationRef: parsed.configurationRef,
    plugin: parsed.plugin,
    scope: parsed.scope,
    descriptors: parsed.descriptors,
    values,
    secrets,
    preservedSecrets,
    unsetSecrets,
  };
}

function sortedIssues(input: readonly ConfigurationValidationIssue[]): readonly ConfigurationValidationIssue[] {
  const unique = new Map<string, ConfigurationValidationIssue>();
  for (const raw of input) {
    const issue = ConfigurationValidationIssueSchema.parse(raw);
    unique.set(`${issue.key ?? ""}\0${issue.code}`, issue);
  }
  return Object.freeze([...unique.values()].sort((left, right) => {
    const key = utf8Compare(left.key ?? "", right.key ?? "");
    return key !== 0 ? key : utf8Compare(left.code, right.code);
  }));
}

function issueFromError(error: unknown, key?: string): ConfigurationValidationIssue {
  const code = error instanceof ConfigurationValidationError ? error.code : "CONFIG_TYPE";
  return ConfigurationValidationIssueSchema.parse({ code, ...(key === undefined || !ConfigurationKeySchema.safeParse(key).success ? {} : { key }) });
}

/** Collect every deterministic issue without retaining attempted values or native causes. */
export async function collectConfigurationValidation(
  request: ConfigurationSubmission,
  pathPort: ConfigurationPathPort,
  signal: AbortSignal,
): Promise<ConfigurationValidationResult> {
  signal.throwIfAborted();
  if (!isRecord(request) || !isRecord(request.values ?? {}) || !Array.isArray(request.unset ?? [])) {
    return { kind: "invalid", issues: [{ code: "CONFIG_TYPE" }] };
  }

  let parsedBase: ConfigurationSubmission;
  try {
    parsedBase = parseSubmission({ ...request, values: {}, unset: [] });
  } catch (error) {
    return { kind: "invalid", issues: sortedIssues([issueFromError(error)]) };
  }

  const issues: ConfigurationValidationIssue[] = [];
  const options = descriptorMap(parsedBase.descriptors);
  const valuesInput = request.values ?? {};
  const unsetInput = request.unset ?? [];
  const unset = new Set<string>();
  for (const raw of unsetInput) {
    const parsed = ConfigurationKeySchema.safeParse(raw);
    if (!parsed.success) {
      issues.push({ code: "CONFIG_UNKNOWN_KEY" });
      continue;
    }
    if (unset.has(parsed.data)) issues.push({ code: "CONFIG_DUPLICATE_INPUT", key: parsed.data });
    unset.add(parsed.data);
  }
  for (const key of Object.keys(valuesInput).sort(utf8Compare)) {
    if (!ConfigurationKeySchema.safeParse(key).success || !options.has(key)) {
      issues.push(ConfigurationKeySchema.safeParse(key).success ? { code: "CONFIG_UNKNOWN_KEY", key } : { code: "CONFIG_UNKNOWN_KEY" });
      continue;
    }
    if (unset.has(key)) issues.push({ code: "CONFIG_DUPLICATE_INPUT", key });
  }
  for (const key of unset) if (!options.has(key)) issues.push({ code: "CONFIG_UNKNOWN_KEY", key });

  const existing = existingSecrets(parsedBase.existing);
  for (const option of parsedBase.descriptors.options) {
    const present = Object.prototype.hasOwnProperty.call(valuesInput, option.key);
    if (!present || unset.has(option.key)) {
      const hasDefault = !option.sensitive && "default" in option.value && option.value.default !== undefined;
      if (option.required && !hasDefault && !(option.sensitive && !unset.has(option.key) && existing.has(option.key))) {
        issues.push({ code: "CONFIG_REQUIRED", key: option.key });
      }
    }
  }

  for (const key of Object.keys(valuesInput).sort(utf8Compare)) {
    const option = options.get(key);
    if (option === undefined) continue;
    try {
      const value = valuesInput[key];
      if (option.value.kind === "directory" || option.value.kind === "file") {
        if (option.sensitive) withSensitiveValue(SensitiveValue.fromUnknown(value), (plaintext) => {
          if (typeof plaintext !== "string") failType(key);
        });
        else validateNonSensitiveValue(option, value, key);
      } else if (option.sensitive) {
        const secret = SensitiveValue.fromUnknown(value);
        withSensitiveValue(secret, (plaintext) => parseSensitiveText(option, plaintext, key));
      } else {
        validateNonSensitiveValue(option, value, key);
      }
    } catch (error) {
      issues.push(issueFromError(error, key));
    }
  }

  const pureIssues = sortedIssues(issues);
  if (pureIssues.length > 0) return { kind: "invalid", issues: pureIssues };

  type PathResult = Awaited<ReturnType<ConfigurationPathPort["normalizeAndInspect"]>>;
  const cache = new Map<string, PathResult>();
  const cacheKey = (input: Parameters<ConfigurationPathPort["normalizeAndInspect"]>[0]) =>
    `${input.expected}\0${input.mustExist ? "1" : "0"}\0${input.value}`;
  const recordingPort: ConfigurationPathPort = {
    async normalizeAndInspect(input, pathSignal) {
      const result = ConfigurationPathResultSchema.parse(await pathPort.normalizeAndInspect(input, pathSignal));
      cache.set(cacheKey(input), result);
      return result;
    },
  };
  const pathIssues: ConfigurationValidationIssue[] = [];
  const checkPath = async (option: ConfigurationOption, value: string): Promise<void> => {
    try { await normalizePath(option, value, recordingPort, parsedBase.pathContext, signal, option.key); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      pathIssues.push(issueFromError(error, option.key));
    }
  };
  for (const option of parsedBase.descriptors.options) {
    if (option.value.kind !== "directory" && option.value.kind !== "file") continue;
    if (Object.prototype.hasOwnProperty.call(valuesInput, option.key)) {
      const raw = valuesInput[option.key];
      if (option.sensitive) {
        await withSensitiveValue(SensitiveValue.fromUnknown(raw), (plaintext) => checkPath(option, plaintext));
      } else {
        await checkPath(option, raw as string);
      }
    } else if (!unset.has(option.key) && "default" in option.value && option.value.default !== undefined) {
      await checkPath(option, option.value.default);
    }
  }
  const allPathIssues = sortedIssues(pathIssues);
  if (allPathIssues.length > 0) return { kind: "invalid", issues: allPathIssues };

  const replayPort: ConfigurationPathPort = {
    async normalizeAndInspect(input, replaySignal) {
      replaySignal.throwIfAborted();
      const result = cache.get(cacheKey(input));
      if (result === undefined) throw new Error("configuration path validation replay was not captured");
      return result;
    },
  };
  return { kind: "valid", submission: await validateConfigurationSubmissionFailFast(request, replayPort, signal) };
}

/** Existing fail-fast contract is a compatibility wrapper over the collector. */
export async function validateConfigurationSubmission(
  request: ConfigurationSubmission,
  pathPort: ConfigurationPathPort,
  signal: AbortSignal,
): Promise<ValidatedConfigurationSubmission> {
  const result = await collectConfigurationValidation(request, pathPort, signal);
  if (result.kind === "valid") return result.submission;
  throw new ConfigurationValidationError(result.issues[0]!.code);
}

function assertNever(value: never): never {
  throw new Error(`unhandled configuration value: ${String(value)}`);
}
