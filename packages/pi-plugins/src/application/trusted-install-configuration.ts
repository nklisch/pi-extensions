import { compareUtf8 } from "../domain/canonical-json.js";
import { verifyPluginConfigurationDocument, type PluginConfigurationDocument } from "../domain/configured-values.js";
import type { PluginConfiguration } from "../domain/configuration.js";
import type { PluginConfigurationStore } from "./ports/plugin-configuration-store.js";
import type { ConfigurationPathContext, ConfigurationPathPort } from "./ports/configuration-path.js";
import type { HostCapabilityStatus } from "./host-observation-contract.js";
import type { SavePluginConfigurationRequest } from "./configuration-service.js";
import { collectConfigurationValidation } from "./configuration-validation.js";
import type { Sha256 } from "../domain/source.js";
import type { PluginKey } from "../domain/identity.js";
import type { ScopeContext, ScopeReference } from "../domain/state/scope.js";
import {
  TrustedInstallConfigurationFieldSchema,
  TrustedInstallInputIssueSchema,
  type TrustedInstallConfigurationField,
  type TrustedInstallInputIssue,
  type TrustedInstallSubmission,
} from "./trusted-install-contract.js";
import type { PluginConfigurationRef } from "../domain/state/references.js";

export type TrustedInstallConfigurationDependencies = Readonly<{
  configurationRef: PluginConfigurationRef;
  plugin: PluginKey;
  scope: ScopeContext;
  descriptors: PluginConfiguration;
  pathContext: ConfigurationPathContext;
  paths: ConfigurationPathPort;
  secretCustody: HostCapabilityStatus;
  existing?: PluginConfigurationDocument;
}>;

export type TrustedInstallConfigurationValidationResult =
  | Readonly<{ kind: "valid"; request: SavePluginConfigurationRequest }>
  | Readonly<{ kind: "invalid"; issues: readonly TrustedInstallInputIssue[] }>;

function sortedIssues(input: readonly TrustedInstallInputIssue[]): readonly TrustedInstallInputIssue[] {
  const unique = new Map<string, TrustedInstallInputIssue>();
  for (const raw of input) {
    const issue = TrustedInstallInputIssueSchema.parse(raw);
    unique.set(`${issue.key ?? ""}\0${issue.code}`, issue);
  }
  return Object.freeze([...unique.values()].sort((left, right) => {
    const key = compareUtf8(left.key ?? "", right.key ?? "");
    return key !== 0 ? key : compareUtf8(left.code, right.code);
  }));
}

/** Partition untrusted workflow input before it reaches generic validation/custody. */
export async function validateTrustedInstallSubmission(
  fieldsInput: readonly TrustedInstallConfigurationField[],
  submission: TrustedInstallSubmission,
  dependencies: TrustedInstallConfigurationDependencies,
  signal: AbortSignal,
): Promise<TrustedInstallConfigurationValidationResult> {
  signal.throwIfAborted();
  const fields = fieldsInput.map((field) => TrustedInstallConfigurationFieldSchema.parse(field));
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const issues: TrustedInstallInputIssue[] = [];
  const values: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const entry of [...submission.nonSensitive, ...submission.sensitive]) {
    const field = byKey.get(entry.key);
    if (seen.has(entry.key)) issues.push({ code: "CONFIG_DUPLICATE_INPUT", key: entry.key });
    seen.add(entry.key);
    if (field === undefined) {
      issues.push({ code: "CONFIG_UNKNOWN_KEY", key: entry.key });
      continue;
    }
    const sensitivePartition = submission.sensitive.includes(entry as never);
    if (field.sensitive !== sensitivePartition) {
      issues.push({ code: "CONFIG_SENSITIVITY_MISMATCH", key: entry.key });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(values, entry.key)) values[entry.key] = entry.value;
  }

  if (dependencies.secretCustody.status !== "available") {
    for (const field of fields) {
      if (field.sensitive && (field.required || submission.sensitive.some((entry) => entry.key === field.key))) {
        issues.push({ code: "SECRET_CUSTODY_UNAVAILABLE", key: field.key });
      }
    }
  }

  const request: SavePluginConfigurationRequest & Readonly<{ existing?: PluginConfigurationDocument }> = {
    configurationRef: dependencies.configurationRef,
    plugin: dependencies.plugin,
    scope: dependencies.scope,
    descriptors: dependencies.descriptors,
    values,
    pathContext: dependencies.pathContext,
    ...(dependencies.existing === undefined ? {} : { existing: dependencies.existing }),
  };
  const validation = await collectConfigurationValidation(request, dependencies.paths, signal);
  if (validation.kind === "invalid") {
    issues.push(...validation.issues.map((issue) => TrustedInstallInputIssueSchema.parse(issue)));
  }
  const allIssues = sortedIssues(issues);
  if (allIssues.length > 0) return { kind: "invalid", issues: allIssues };
  const { existing: _existing, ...saveRequest } = request;
  return { kind: "valid", request: saveRequest };
}

export type TrustedInstallConfigurationAuthorityResult =
  | Readonly<{ kind: "current"; document: PluginConfigurationDocument }>
  | Readonly<{ kind: "missing" | "stale" | "unavailable" }>;

export type TrustedInstallConfigurationAuthorityRequest = Readonly<{
  configurationRef: PluginConfigurationRef;
  plugin: PluginKey;
  scope: ScopeReference;
  descriptors: PluginConfiguration;
}>;

export interface TrustedInstallConfigurationAuthority {
  readCurrent(request: TrustedInstallConfigurationAuthorityRequest, signal: AbortSignal): Promise<TrustedInstallConfigurationAuthorityResult>;
  readExact(request: TrustedInstallConfigurationAuthorityRequest & Readonly<{ expectedRevision: string }>, signal: AbortSignal): Promise<TrustedInstallConfigurationAuthorityResult>;
}

function sameScope(left: PluginConfigurationDocument["scope"], right: ScopeReference): boolean {
  return left.kind === right.kind && (left.kind === "user" || (right.kind === "project" && left.projectKey === right.projectKey));
}

/** Exact read-only authority checks used for reuse and lifecycle transfer. */
export function createTrustedInstallConfigurationAuthority(dependencies: Readonly<{
  configurations: PluginConfigurationStore;
  sha256: Sha256;
}>): TrustedInstallConfigurationAuthority {
  async function readCurrent(
    request: TrustedInstallConfigurationAuthorityRequest,
    signal: AbortSignal,
  ): Promise<TrustedInstallConfigurationAuthorityResult> {
    try {
      const result = await dependencies.configurations.read(request.configurationRef, signal);
      if (result.kind === "missing") return { kind: "missing" };
      const document = verifyPluginConfigurationDocument(result.document, request.descriptors, dependencies.sha256);
      if (document.configurationRef !== request.configurationRef || document.plugin !== request.plugin || !sameScope(document.scope, request.scope)) {
        return { kind: "stale" };
      }
      return { kind: "current", document };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return { kind: "unavailable" };
    }
  }

  const authority: TrustedInstallConfigurationAuthority = {
    readCurrent,
    async readExact(request, signal) {
      const current = await readCurrent(request, signal);
      return current.kind === "current" && current.document.revision !== request.expectedRevision
        ? { kind: "stale" }
        : current;
    },
  };
  return Object.freeze(authority);
}
