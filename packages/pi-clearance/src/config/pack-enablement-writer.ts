import { readFile } from "node:fs/promises";
import type {
  PackEnablementAcknowledgement,
  PackEnablementPlan,
} from "../packs/enablement.ts";
import type { JsonPatchOperation } from "../replay/proposal-schema.ts";
import {
  type ConfigCommandPostWriteValidationResult,
  writeConfigTargetAndValidate,
} from "./config-command-writer.ts";
import type { ResolvedConfig } from "./loader.ts";
import {
  type GlobalConfig,
  GlobalConfigSchema,
  normalizeConfig,
  type PackEnablementConfig,
  type ProjectOverlayConfig,
  ProjectOverlaySchema,
} from "./schema.ts";

export type PackEnablementPostWriteValidationResult =
  ConfigCommandPostWriteValidationResult;

export interface PackEnablementWriterDependencies {
  /** Reload config after the atomic rename so policy validation sees disk state. */
  readonly reloadConfig: () => Promise<ResolvedConfig>;
  /** Compose/replay/policy validation injected by the caller; this adapter owns only filesystem I/O. */
  readonly validatePostWrite: (
    resolvedConfig: ResolvedConfig,
  ) => Promise<PackEnablementPostWriteValidationResult>;
}

export type PackEnablementApplyResult =
  | {
      readonly ok: true;
      readonly planId: string;
      readonly changed: boolean;
      readonly targetPath: string;
      readonly backupPath?: string;
      readonly resolvedConfig?: ResolvedConfig;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly planId: string;
      readonly targetPath: string;
      readonly reason: string;
      readonly wrote: boolean;
      readonly restored: boolean;
      readonly errors: readonly string[];
    };

/**
 * Apply a previously previewed pack-enable plan to user-owned config.
 *
 * The writer refuses unconfirmed plans before touching disk, normalizes the
 * current JSON document through the owning schema, applies the exact previewed
 * JSON patch, validates the patched document, writes through a same-directory
 * temp file, backs up existing files, atomically renames, reloads config, and
 * only reports success after the injected post-write policy validation passes.
 */
export async function applyPackEnablementPlan(
  plan: PackEnablementPlan,
  acknowledgement: PackEnablementAcknowledgement,
  dependencies: PackEnablementWriterDependencies,
): Promise<PackEnablementApplyResult> {
  const acknowledgementError = validateAcknowledgement(plan, acknowledgement);
  if (acknowledgementError !== undefined) {
    return noWriteFailure(plan, acknowledgementError);
  }

  if (plan.patch.length === 0) {
    return {
      ok: true,
      planId: plan.id,
      changed: false,
      targetPath: plan.targetPath,
      warnings: [],
    };
  }

  const readResult = await readTarget(plan.targetPath);
  if (!readResult.ok) {
    return noWriteFailure(plan, readResult.reason, readResult.errors);
  }

  const normalized = normalizeTargetConfig(plan, readResult.raw);
  if (!normalized.ok) {
    return noWriteFailure(plan, "current config failed schema validation", [
      ...normalized.errors,
    ]);
  }

  const staleReason = validatePlanStillCurrent(plan, normalized.value);
  if (staleReason !== undefined) {
    return noWriteFailure(plan, staleReason);
  }

  let patchedRaw: unknown;
  try {
    patchedRaw = applyJsonPatch(normalized.value, plan.patch);
  } catch (error) {
    return noWriteFailure(plan, errorMessage(error));
  }

  const patched = normalizeTargetConfig(plan, patchedRaw);
  if (!patched.ok) {
    return noWriteFailure(plan, "patched config failed schema validation", [
      ...patched.errors,
    ]);
  }

  return await writeConfigTargetAndValidate({
    planId: plan.id,
    targetPath: plan.targetPath,
    configKind: plan.request.scope,
    value: patched.value,
    hadExistingFile: readResult.exists,
    reloadConfig: dependencies.reloadConfig,
    validatePostWrite: dependencies.validatePostWrite,
    writeFailureReason: "pack enablement write failed",
    postWriteFailureReason: "post-write policy validation failed",
  });
}

function validateAcknowledgement(
  plan: PackEnablementPlan,
  acknowledgement: PackEnablementAcknowledgement,
): string | undefined {
  if (acknowledgement.confirmedPlanId !== plan.id) {
    return `confirmed plan id "${acknowledgement.confirmedPlanId}" does not match plan id "${plan.id}"`;
  }

  const acknowledged = new Set(acknowledgement.acknowledgedWarningCodes);
  const missing = plan.requiredAcknowledgementCodes.filter(
    (code) => !acknowledged.has(code),
  );
  if (missing.length > 0) {
    return `missing required warning acknowledgement(s): ${missing.join(", ")}`;
  }

  return undefined;
}

async function readTarget(targetPath: string): Promise<
  | { readonly ok: true; readonly exists: boolean; readonly raw: unknown }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly errors: readonly string[];
    }
> {
  let text: string;
  try {
    text = await readFile(targetPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { ok: true, exists: false, raw: { version: 1 } };
    }
    return {
      ok: false,
      reason: "current config could not be read",
      errors: [errorMessage(error)],
    };
  }

  try {
    return { ok: true, exists: true, raw: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      reason: "current config contains invalid JSON",
      errors: [errorMessage(error)],
    };
  }
}

type TargetConfig = GlobalConfig | ProjectOverlayConfig;

type NormalizedTarget =
  | { readonly ok: true; readonly value: TargetConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

function normalizeTargetConfig(
  plan: PackEnablementPlan,
  raw: unknown,
): NormalizedTarget {
  const result =
    plan.request.scope === "global"
      ? normalizeConfig(GlobalConfigSchema, cloneJsonish(raw))
      : normalizeConfig(ProjectOverlaySchema, cloneJsonish(raw));

  if (result.ok) {
    return { ok: true, value: result.value };
  }

  return {
    ok: false,
    errors: result.errors.map((error) => `${error.path}: ${error.message}`),
  };
}

function validatePlanStillCurrent(
  plan: PackEnablementPlan,
  current: TargetConfig,
): string | undefined {
  if (
    !packEnablementEqual(
      dedupePackEnablement(current.packEnablement),
      plan.before.packEnablement,
    )
  ) {
    return "current config packEnablement no longer matches the previewed plan state";
  }

  if (!jsonEqual(sourceNormalizedPacks(current, plan), plan.before.packs)) {
    return "current config pack definitions no longer match the previewed plan state";
  }

  return undefined;
}

function sourceNormalizedPacks(
  current: TargetConfig,
  plan: PackEnablementPlan,
): TargetConfig["packs"] {
  const source =
    plan.request.scope === "global" ? "user-global" : "user-project";
  return current.packs.map((pack) => ({
    ...pack,
    rules: pack.rules.map((rule) => ({
      ...rule,
      provenance: { source },
    })),
  }));
}

function dedupePackEnablement(
  config: PackEnablementConfig,
): PackEnablementConfig {
  return {
    enabledPackagePacks: dedupeStrings(config.enabledPackagePacks),
    disabledPackagePacks: dedupeStrings(config.disabledPackagePacks),
    disabledConfigPacks: dedupeStrings(config.disabledConfigPacks),
  };
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function packEnablementEqual(
  a: PackEnablementConfig,
  b: PackEnablementConfig,
): boolean {
  return (
    stringArrayEqual(a.enabledPackagePacks, b.enabledPackagePacks) &&
    stringArrayEqual(a.disabledPackagePacks, b.disabledPackagePacks) &&
    stringArrayEqual(a.disabledConfigPacks, b.disabledConfigPacks)
  );
}

function stringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
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

function applyJsonPatch(
  document: unknown,
  patch: readonly JsonPatchOperation[],
): unknown {
  const draft = cloneJsonish(document);
  for (const operation of patch) {
    applyJsonPatchOperation(draft, operation);
  }
  return draft;
}

function applyJsonPatchOperation(
  document: unknown,
  operation: JsonPatchOperation,
): void {
  const tokens = parseJsonPointer(operation.path);
  if (tokens.length === 0) {
    throw new Error("root-level JSON patch operations are not supported");
  }

  const parent = resolvePatchParent(document, tokens.slice(0, -1));
  const key = tokens[tokens.length - 1];
  if (key === undefined) {
    throw new Error(`invalid JSON patch path "${operation.path}"`);
  }

  switch (operation.op) {
    case "add":
      addPatchValue(parent, key, operation.value);
      return;
    case "replace":
      replacePatchValue(parent, key, operation.value);
      return;
    case "remove":
      removePatchValue(parent, key);
      return;
  }
}

function parseJsonPointer(pointer: string): readonly string[] {
  if (!pointer.startsWith("/")) {
    throw new Error(`JSON patch path must start with "/": ${pointer}`);
  }
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function resolvePatchParent(
  document: unknown,
  tokens: readonly string[],
): unknown {
  let current = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = arrayIndex(token, current.length - 1);
      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      throw new Error(`cannot traverse JSON patch token "${token}"`);
    }
    if (!(token in current)) {
      throw new Error(`JSON patch path token "${token}" does not exist`);
    }
    current = current[token];
  }
  return current;
}

function addPatchValue(parent: unknown, key: string, value: unknown): void {
  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(cloneJsonish(value));
      return;
    }
    const index = arrayIndex(key, parent.length);
    parent.splice(index, 0, cloneJsonish(value));
    return;
  }

  if (!isRecord(parent)) {
    throw new Error(`cannot add JSON patch value at token "${key}"`);
  }
  parent[key] = cloneJsonish(value);
}

function replacePatchValue(parent: unknown, key: string, value: unknown): void {
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length - 1);
    parent[index] = cloneJsonish(value);
    return;
  }

  if (!isRecord(parent) || !(key in parent)) {
    throw new Error(`cannot replace missing JSON patch token "${key}"`);
  }
  parent[key] = cloneJsonish(value);
}

function removePatchValue(parent: unknown, key: string): void {
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length - 1);
    parent.splice(index, 1);
    return;
  }

  if (!isRecord(parent) || !(key in parent)) {
    throw new Error(`cannot remove missing JSON patch token "${key}"`);
  }
  delete parent[key];
}

function arrayIndex(token: string, maxInclusive: number): number {
  if (!/^\d+$/u.test(token)) {
    throw new Error(
      `JSON patch array token "${token}" is not a non-negative index`,
    );
  }
  const index = Number.parseInt(token, 10);
  if (index < 0 || index > maxInclusive) {
    throw new Error(`JSON patch array index ${index} is out of bounds`);
  }
  return index;
}

function noWriteFailure(
  plan: PackEnablementPlan,
  reason: string,
  errors: readonly string[] = [reason],
): PackEnablementApplyResult {
  return {
    ok: false,
    planId: plan.id,
    targetPath: plan.targetPath,
    reason,
    wrote: false,
    restored: false,
    errors,
  };
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
