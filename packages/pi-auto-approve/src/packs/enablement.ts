import { createHash } from "node:crypto";

import type { ResolvedConfig } from "../config/loader.ts";
import type { ConfigPaths } from "../config/paths.ts";
import {
  normalizeConfig,
  type PackEnablementConfig,
  PolicyPackSchema,
  type RawPolicyPack,
} from "../config/schema.ts";
import type { JsonPatchOperation } from "../replay/proposal-schema.ts";
import {
  getValidatedAvailablePack,
  type PackAvailabilityValidationReport,
  type PackEnablementProposalReadiness,
  type PackValidationContext,
  type PackValidationIssue,
  packEnablementProposalReadiness,
  type ValidatedAvailablePack,
  validatePackCandidate,
} from "./validation.ts";

export type PackEnablementScope = "global" | "project";
export type PackEnablementAction = "enable" | "disable";
export type PackEnablementSubject = "package" | "config-pack";

export interface PackEnablementRequest {
  readonly action: PackEnablementAction;
  readonly scope: PackEnablementScope;
  readonly subject: PackEnablementSubject;
  readonly packId: string;
  readonly rawPack?: unknown;
}

export interface PackEnablementAcknowledgement {
  readonly confirmedPlanId: string;
  readonly acknowledgedWarningCodes: readonly string[];
}

export interface PackEnablementWarning {
  readonly code: string;
  readonly level: "info" | "warning" | "danger";
  readonly message: string;
  readonly source: "availability" | "validation" | "metadata" | "planner";
  readonly requiresAcknowledgement: boolean;
}

export interface PackEnablementState {
  readonly scope: PackEnablementScope;
  readonly packEnablement: PackEnablementConfig;
  readonly packs: readonly RawPolicyPack[];
}

export interface PackEnablementPlan {
  readonly id: string;
  readonly request: PackEnablementRequest;
  readonly targetPath: string;
  readonly patch: readonly JsonPatchOperation[];
  readonly before: PackEnablementState;
  readonly after: PackEnablementState;
  readonly warnings: readonly PackEnablementWarning[];
  readonly requiredAcknowledgementCodes: readonly string[];
}

export type PackEnablementPlanResult =
  | { readonly ok: true; readonly plan: PackEnablementPlan }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly warnings: readonly PackEnablementWarning[];
    };

export interface PlanPackEnablementInput {
  readonly request: PackEnablementRequest;
  readonly paths: Pick<ConfigPaths, "globalConfigFile" | "projectOverlayFile">;
  readonly resolvedConfig: Pick<
    ResolvedConfig,
    | "mode"
    | "trustedProject"
    | "errors"
    | "warnings"
    | "packEnablement"
    | "globalPacks"
    | "projectPacks"
  >;
  readonly availabilityReport: PackAvailabilityValidationReport;
}

type CandidateLookup =
  | { readonly ok: true; readonly entry: ValidatedAvailablePack }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly warnings: readonly PackEnablementWarning[];
    };

type RawPackValidation =
  | {
      readonly ok: true;
      readonly rawPack: RawPolicyPack;
      readonly warnings: readonly PackEnablementWarning[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly warnings: readonly PackEnablementWarning[];
    };

type ExistingPackValidation =
  | { readonly ok: true; readonly warnings: readonly PackEnablementWarning[] }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly warnings: readonly PackEnablementWarning[];
    };

interface ConfigPackInstance {
  readonly rawPack: RawPolicyPack;
  readonly source: "user-global" | "user-project";
}

export function planPackEnablementChange(
  input: PlanPackEnablementInput,
): PackEnablementPlanResult {
  const { request } = input;
  if (request.packId.trim().length === 0) {
    return refusal("packId must be a non-empty string", [
      plannerWarning(
        "pack-id-empty",
        "danger",
        "Pack enablement requires a non-empty pack id.",
      ),
    ]);
  }

  const before = stateForScope(input.resolvedConfig, request.scope);
  const targetPath = targetPathForScope(input.paths, request.scope);

  switch (request.subject) {
    case "package":
      return planPackageLikeChange(input, before, targetPath);
    case "config-pack":
      return planConfigPackChange(input, before, targetPath);
  }
}

function planPackageLikeChange(
  input: PlanPackEnablementInput,
  before: PackEnablementState,
  targetPath: string,
): PackEnablementPlanResult {
  const warnings: PackEnablementWarning[] = [];

  // Disabling is the safe/tightening direction. It should remain possible even
  // when the contributing package disappeared, became malformed, or now fails
  // validation; the writer only edits user-owned id arrays and never touches the
  // installed package or registration state.
  if (input.request.action === "enable") {
    const readiness = readinessForEnableCandidate(input);
    if (!readiness.ok) {
      return refusal(readiness.reason, readiness.warnings);
    }
    warnings.push(...readiness.warnings);
  }

  const afterEnablement = updatePackageEnablement(
    before.packEnablement,
    input.request.action,
    input.request.packId,
  );
  const after: PackEnablementState = {
    ...before,
    packEnablement: afterEnablement,
  };
  const patch = packEnablementPatch(before.packEnablement, afterEnablement, [
    "enabledPackagePacks",
    "disabledPackagePacks",
  ]);

  return planned(input.request, targetPath, before, after, patch, warnings);
}

function readinessForEnableCandidate(input: PlanPackEnablementInput):
  | { readonly ok: true; readonly warnings: readonly PackEnablementWarning[] }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly warnings: readonly PackEnablementWarning[];
    } {
  const lookup = lookupCandidate(
    input.availabilityReport,
    input.request.packId,
  );
  if (!lookup.ok) {
    return lookup;
  }

  const readiness = packEnablementProposalReadiness(lookup.entry);
  const warnings = warningsForValidatedEntry(lookup.entry, readiness);
  if (readiness.status === "refused") {
    return { ok: false, reason: readiness.reason, warnings };
  }

  if (
    readiness.validation.kind !== "data" ||
    readiness.validation.source.kind !== "package"
  ) {
    return {
      ok: false,
      reason: `pack "${input.request.packId}" is not a package-contributed data pack`,
      warnings,
    };
  }

  return { ok: true, warnings };
}

function planConfigPackChange(
  input: PlanPackEnablementInput,
  before: PackEnablementState,
  targetPath: string,
): PackEnablementPlanResult {
  const existing = configPackInstances(
    input.resolvedConfig,
    input.request.scope,
    input.request.packId,
  );
  if (existing.length > 1) {
    return refusal(
      `config pack "${input.request.packId}" is ambiguous across user-owned config`,
      [
        plannerWarning(
          "config-pack-duplicate",
          "danger",
          `Config pack id "${input.request.packId}" appears ${existing.length} times; refusing to plan an ambiguous enablement change.`,
        ),
      ],
    );
  }

  if (input.request.action === "disable") {
    if (existing.length === 0) {
      return missingConfigPack(input.request.packId);
    }

    const afterEnablement = {
      ...before.packEnablement,
      disabledConfigPacks: addUnique(
        before.packEnablement.disabledConfigPacks,
        input.request.packId,
      ),
    };
    const after: PackEnablementState = {
      ...before,
      packEnablement: afterEnablement,
    };
    const patch = packEnablementPatch(before.packEnablement, afterEnablement, [
      "disabledConfigPacks",
    ]);
    return planned(input.request, targetPath, before, after, patch, []);
  }

  if (existing.length === 1) {
    const instance = existing[0];
    if (instance === undefined) {
      return missingConfigPack(input.request.packId);
    }
    const validation = validateExistingConfigPack(input, instance);
    if (!validation.ok) {
      return refusal(validation.reason, validation.warnings);
    }

    const afterEnablement = {
      ...before.packEnablement,
      disabledConfigPacks: removeValue(
        before.packEnablement.disabledConfigPacks,
        input.request.packId,
      ),
    };
    const after: PackEnablementState = {
      ...before,
      packEnablement: afterEnablement,
    };
    const patch = packEnablementPatch(before.packEnablement, afterEnablement, [
      "disabledConfigPacks",
    ]);
    return planned(
      input.request,
      targetPath,
      before,
      after,
      patch,
      validation.warnings,
    );
  }

  if (input.request.rawPack === undefined) {
    return missingConfigPack(input.request.packId);
  }

  const duplicate = duplicateCandidateWarning(
    input.availabilityReport,
    input.request.packId,
  );
  if (duplicate !== undefined) {
    return refusal(
      `config pack "${input.request.packId}" already exists in the available pack registry`,
      [duplicate],
    );
  }

  const rawValidation = validateNewConfigPack(input);
  if (!rawValidation.ok) {
    return refusal(rawValidation.reason, rawValidation.warnings);
  }

  const afterEnablement = {
    ...before.packEnablement,
    disabledConfigPacks: removeValue(
      before.packEnablement.disabledConfigPacks,
      input.request.packId,
    ),
  };
  const after: PackEnablementState = {
    ...before,
    packEnablement: afterEnablement,
    packs: [...before.packs, rawValidation.rawPack],
  };
  const patch: JsonPatchOperation[] = [
    ...packEnablementPatch(before.packEnablement, afterEnablement, [
      "disabledConfigPacks",
    ]),
    { op: "add", path: "/packs/-", value: rawValidation.rawPack },
  ];

  return planned(
    input.request,
    targetPath,
    before,
    after,
    patch,
    rawValidation.warnings,
  );
}

function validateExistingConfigPack(
  input: PlanPackEnablementInput,
  instance: ConfigPackInstance,
): ExistingPackValidation {
  const validation = validatePackCandidate(
    {
      kind: "data",
      raw: instance.rawPack,
      source: { kind: instance.source },
      idHint: input.request.packId,
    },
    validationContextFromResolved(input),
  );
  const readiness = packEnablementProposalReadiness({
    candidateId: validation.candidateId,
    validation,
  });
  const warnings = warningsFromReadiness(readiness);

  if (readiness.status === "refused") {
    return { ok: false, reason: readiness.reason, warnings };
  }

  return { ok: true, warnings };
}

function validateNewConfigPack(
  input: PlanPackEnablementInput,
): RawPackValidation {
  const source =
    input.request.scope === "global"
      ? ({ kind: "user-global" } as const)
      : ({ kind: "user-project" } as const);
  const validation = validatePackCandidate(
    {
      kind: "data",
      raw: input.request.rawPack,
      source,
      idHint: input.request.packId,
    },
    validationContextFromResolved(input),
  );
  const readiness = packEnablementProposalReadiness({
    candidateId: validation.candidateId,
    validation,
  });
  const warnings = warningsFromReadiness(readiness);

  if (readiness.status === "refused") {
    return { ok: false, reason: readiness.reason, warnings };
  }

  const normalized = normalizeConfig(
    PolicyPackSchema,
    cloneJsonish(input.request.rawPack),
  );
  if (!normalized.ok) {
    return {
      ok: false,
      reason: "raw config pack failed schema validation",
      warnings: [
        ...warnings,
        ...normalized.errors.map((error, index) =>
          plannerWarning(
            `raw-pack-schema-${index}`,
            "danger",
            `${error.path}: ${error.message}`,
          ),
        ),
      ],
    };
  }

  if (normalized.value.id !== input.request.packId) {
    return {
      ok: false,
      reason: `raw config pack id "${normalized.value.id}" does not match requested id "${input.request.packId}"`,
      warnings: [
        ...warnings,
        plannerWarning(
          "raw-pack-id-mismatch",
          "danger",
          `Raw config pack id "${normalized.value.id}" does not match requested id "${input.request.packId}".`,
        ),
      ],
    };
  }

  return { ok: true, rawPack: normalized.value, warnings };
}

function duplicateCandidateWarning(
  report: PackAvailabilityValidationReport,
  packId: string,
): PackEnablementWarning | undefined {
  const matches = report.entries.filter(
    (entry) => entry.candidateId === packId,
  );
  if (matches.length === 0) {
    return undefined;
  }

  const sources = matches
    .map(
      (entry) =>
        entry.registryEntry?.source.kind ?? entry.validation.source.kind,
    )
    .join(", ");
  return plannerWarning(
    "config-pack-id-conflict",
    "danger",
    `Pack id "${packId}" already exists in the availability report (${sources}); refusing to create a duplicate user-authored config pack.`,
  );
}

function lookupCandidate(
  report: PackAvailabilityValidationReport,
  packId: string,
): CandidateLookup {
  const matches = report.entries.filter(
    (entry) => entry.candidateId === packId,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `pack candidate "${packId}" is not available`,
      warnings: [
        plannerWarning(
          "candidate-missing",
          "danger",
          `No validated pack candidate with id "${packId}" was found in the availability report.`,
        ),
      ],
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `pack candidate "${packId}" is ambiguous`,
      warnings: [
        plannerWarning(
          "candidate-duplicate",
          "danger",
          `Pack candidate id "${packId}" appears ${matches.length} times; refusing to plan an ambiguous enablement change.`,
        ),
        ...report.warnings
          .filter((warning) => warning.includes(packId))
          .map((warning, index) =>
            plannerWarning(
              `availability-duplicate-${index}`,
              "warning",
              warning,
            ),
          ),
      ],
    };
  }

  const entry = getValidatedAvailablePack(report, packId);
  if (entry === undefined) {
    return {
      ok: false,
      reason: `pack candidate "${packId}" is ambiguous`,
      warnings: [
        plannerWarning(
          "candidate-duplicate",
          "danger",
          `Pack candidate id "${packId}" could not be resolved uniquely from the availability report.`,
        ),
      ],
    };
  }
  return { ok: true, entry };
}

function updatePackageEnablement(
  current: PackEnablementConfig,
  action: PackEnablementAction,
  packId: string,
): PackEnablementConfig {
  if (action === "enable") {
    return {
      ...current,
      enabledPackagePacks: addUnique(current.enabledPackagePacks, packId),
      disabledPackagePacks: removeValue(current.disabledPackagePacks, packId),
    };
  }

  return {
    ...current,
    enabledPackagePacks: removeValue(current.enabledPackagePacks, packId),
    disabledPackagePacks: addUnique(current.disabledPackagePacks, packId),
  };
}

function packEnablementPatch(
  before: PackEnablementConfig,
  after: PackEnablementConfig,
  fields: readonly (keyof PackEnablementConfig)[],
): readonly JsonPatchOperation[] {
  const patch: JsonPatchOperation[] = [];
  for (const field of fields) {
    if (arrayEqual(before[field], after[field])) {
      continue;
    }
    patch.push({
      op: "replace",
      path: `/packEnablement/${field}`,
      before: before[field],
      value: after[field],
    });
  }
  return patch;
}

function planned(
  request: PackEnablementRequest,
  targetPath: string,
  before: PackEnablementState,
  after: PackEnablementState,
  patch: readonly JsonPatchOperation[],
  warnings: readonly PackEnablementWarning[],
): PackEnablementPlanResult {
  const uniqueWarnings = dedupeWarnings(warnings);
  const requiredAcknowledgementCodes = uniqueWarnings
    .filter((warning) => warning.requiresAcknowledgement)
    .map((warning) => warning.code);
  const planWithoutId = {
    request,
    targetPath,
    patch,
    before,
    after,
    warnings: uniqueWarnings,
    requiredAcknowledgementCodes,
  };
  const id = deterministicPlanId(planWithoutId);

  return { ok: true, plan: { id, ...planWithoutId } };
}

function deterministicPlanId(value: unknown): string {
  const hash = createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 24);
  return `pack-enable:${hash}`;
}

function warningsForValidatedEntry(
  entry: ValidatedAvailablePack,
  readiness: PackEnablementProposalReadiness,
): PackEnablementWarning[] {
  return [...warningsFromReadiness(readiness), ...metadataWarnings(entry)];
}

function warningsFromReadiness(
  readiness: PackEnablementProposalReadiness,
): PackEnablementWarning[] {
  return readiness.issues.map(validationIssueWarning);
}

function validationIssueWarning(
  issue: PackValidationIssue,
  index: number,
): PackEnablementWarning {
  const level = issue.severity === "error" ? "danger" : issue.severity;
  return {
    code: `validation-${issue.code}-${index}`,
    level,
    message:
      issue.path === undefined
        ? issue.message
        : `${issue.path}: ${issue.message}`,
    source: "validation",
    requiresAcknowledgement: level === "danger",
  };
}

function metadataWarnings(
  entry: ValidatedAvailablePack,
): PackEnablementWarning[] {
  const warnings =
    entry.registryEntry?.metadata.warnings ??
    entry.validation.pack?.metadata?.warnings ??
    [];
  return warnings.map((warning, index) => ({
    code: `metadata-${warning.level}-${index}`,
    level: warning.level,
    message: warning.message,
    source: "metadata" as const,
    requiresAcknowledgement: warning.level === "danger",
  }));
}

function plannerWarning(
  code: string,
  level: PackEnablementWarning["level"],
  message: string,
): PackEnablementWarning {
  return {
    code,
    level,
    message,
    source: "planner",
    requiresAcknowledgement: level === "danger",
  };
}

function dedupeWarnings(
  warnings: readonly PackEnablementWarning[],
): readonly PackEnablementWarning[] {
  const seen = new Set<string>();
  const result: PackEnablementWarning[] = [];
  for (const warning of warnings) {
    if (seen.has(warning.code)) {
      continue;
    }
    seen.add(warning.code);
    result.push(warning);
  }
  return result;
}

function stateForScope(
  resolvedConfig: Pick<
    ResolvedConfig,
    "packEnablement" | "globalPacks" | "projectPacks"
  >,
  scope: PackEnablementScope,
): PackEnablementState {
  return {
    scope,
    packEnablement:
      scope === "global"
        ? clonePackEnablement(resolvedConfig.packEnablement.global)
        : clonePackEnablement(resolvedConfig.packEnablement.project),
    packs:
      scope === "global"
        ? resolvedConfig.globalPacks.map(cloneRawPack)
        : resolvedConfig.projectPacks.map(cloneRawPack),
  };
}

function targetPathForScope(
  paths: Pick<ConfigPaths, "globalConfigFile" | "projectOverlayFile">,
  scope: PackEnablementScope,
): string {
  return scope === "global" ? paths.globalConfigFile : paths.projectOverlayFile;
}

function configPackInstances(
  resolvedConfig: Pick<ResolvedConfig, "globalPacks" | "projectPacks">,
  scope: PackEnablementScope,
  packId: string,
): readonly ConfigPackInstance[] {
  const global = resolvedConfig.globalPacks.map((rawPack) => ({
    rawPack,
    source: "user-global" as const,
  }));
  const project = resolvedConfig.projectPacks.map((rawPack) => ({
    rawPack,
    source: "user-project" as const,
  }));
  const packs = scope === "global" ? global : [...global, ...project];
  return packs.filter((entry) => entry.rawPack.id === packId);
}

function validationContextFromResolved(
  input: PlanPackEnablementInput,
): PackValidationContext {
  return {
    resolvedConfig: {
      mode: input.resolvedConfig.mode,
      errors: input.resolvedConfig.errors,
      warnings: input.resolvedConfig.warnings,
    },
  };
}

function missingConfigPack(packId: string): PackEnablementPlanResult {
  return refusal(
    `config pack "${packId}" is not present and no rawPack was supplied`,
    [
      plannerWarning(
        "config-pack-missing",
        "danger",
        `Config pack "${packId}" is not present in user-owned config and no rawPack was supplied to create it.`,
      ),
    ],
  );
}

function refusal(
  reason: string,
  warnings: readonly PackEnablementWarning[],
): PackEnablementPlanResult {
  return { ok: false, reason, warnings: dedupeWarnings(warnings) };
}

function clonePackEnablement(
  value: PackEnablementConfig,
): PackEnablementConfig {
  return {
    enabledPackagePacks: [...value.enabledPackagePacks],
    disabledPackagePacks: [...value.disabledPackagePacks],
    disabledConfigPacks: [...value.disabledConfigPacks],
  };
}

function cloneRawPack(pack: RawPolicyPack): RawPolicyPack {
  return cloneJsonish(pack) as RawPolicyPack;
}

function addUnique(
  values: readonly string[],
  value: string,
): readonly string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function removeValue(
  values: readonly string[],
  value: string,
): readonly string[] {
  return values.filter((entry) => entry !== value);
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function cloneJsonish<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonish(entry)) as T;
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonish(entry)]),
    ) as T;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForStableStringify(value[key])]),
    );
  }

  return value;
}
