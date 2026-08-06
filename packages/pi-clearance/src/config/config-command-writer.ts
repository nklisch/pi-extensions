import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { TSchema } from "@sinclair/typebox";

import type { JsonPatchOperation } from "../replay/proposal-schema.ts";
import type { ResolvedConfig } from "./loader.ts";
import {
  type ConfigPersistenceKind,
  serializeSparseConfigText,
} from "./persistence.ts";
import {
  type GlobalConfig,
  GlobalConfigSchema,
  normalizeConfig,
  type ProjectOverlayConfig,
  ProjectOverlaySchema,
} from "./schema.ts";

export type ConfigCommandTargetKind = "global" | "project";

export interface ConfigCommandTarget {
  readonly kind: ConfigCommandTargetKind;
  readonly path: string;
}

export interface ConfigCommandWarning {
  readonly code: string;
  readonly message: string;
  readonly requiresAcknowledgement: boolean;
}

export interface ConfigCommandPlan {
  readonly id: string;
  readonly target: ConfigCommandTarget;
  readonly title: string;
  readonly summary: string;
  readonly patch: readonly JsonPatchOperation[];
  readonly before: GlobalConfig | ProjectOverlayConfig;
  readonly after: GlobalConfig | ProjectOverlayConfig;
  readonly requiredAcknowledgementCodes: readonly string[];
  readonly warnings: readonly ConfigCommandWarning[];
}

export interface ConfigCommandAcknowledgement {
  readonly confirmedPlanId: string;
  /**
   * Command handlers currently use one explicit UI confirmation that presents
   * every required warning, then pass the plan's required warning codes here as
   * the durable proof that the confirmed preview is the one being applied.
   */
  readonly acknowledgedWarningCodes: readonly string[];
}

export interface ConfigCommandPostWriteValidationSuccess {
  readonly ok: true;
  readonly warnings?: readonly string[];
}

export interface ConfigCommandPostWriteValidationFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type ConfigCommandPostWriteValidationResult =
  | ConfigCommandPostWriteValidationSuccess
  | ConfigCommandPostWriteValidationFailure;

export interface ConfigCommandWriterDependencies {
  /** Reload config after the atomic rename so validation sees disk state. */
  readonly reloadConfig: () => Promise<ResolvedConfig>;
  /** Compose policy / prompt validation injected by the runtime edge. */
  readonly validatePostWrite: (
    config: ResolvedConfig,
  ) => Promise<ConfigCommandPostWriteValidationResult>;
}

export type ConfigCommandApplyResult =
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

interface AtomicConfigWriteInput {
  readonly planId: string;
  readonly targetPath: string;
  readonly configKind: ConfigPersistenceKind;
  readonly value: GlobalConfig | ProjectOverlayConfig;
  readonly hadExistingFile: boolean;
  readonly reloadConfig: () => Promise<ResolvedConfig>;
  readonly validatePostWrite: (
    config: ResolvedConfig,
  ) => Promise<ConfigCommandPostWriteValidationResult>;
  readonly writeFailureReason: string;
  readonly postWriteFailureReason: string;
}

/**
 * Apply a previously previewed config command plan to user-owned config.
 *
 * The writer is deliberately generic for non-pack commands: it validates the
 * acknowledgement before touching disk, reloads the current target through the
 * owning schema, rejects stale previews, applies the exact JSON patch, writes
 * through a same-directory temp file, backs up existing files, reloads config,
 * validates the post-write policy surface, and restores the previous file if
 * validation fails.
 */
export async function applyConfigCommandPlan(
  plan: ConfigCommandPlan,
  acknowledgement: ConfigCommandAcknowledgement,
  dependencies: ConfigCommandWriterDependencies,
): Promise<ConfigCommandApplyResult> {
  const acknowledgementError = validateAcknowledgement(plan, acknowledgement);
  if (acknowledgementError !== undefined) {
    return noWriteFailure(plan, acknowledgementError);
  }

  if (plan.patch.length === 0) {
    return {
      ok: true,
      planId: plan.id,
      changed: false,
      targetPath: plan.target.path,
      warnings: [],
    };
  }

  const readResult = await readTarget(plan.target.path);
  if (!readResult.ok) {
    return noWriteFailure(plan, readResult.reason, readResult.errors);
  }

  const normalized = normalizeTargetConfig(plan.target.kind, readResult.raw);
  if (!normalized.ok) {
    return noWriteFailure(plan, "current config failed schema validation", [
      ...normalized.errors,
    ]);
  }

  if (!jsonEqual(normalized.value, plan.before)) {
    return noWriteFailure(
      plan,
      "current config no longer matches the previewed plan state",
    );
  }

  let patchedRaw: unknown;
  try {
    patchedRaw = applyJsonPatchDocument(normalized.value, plan.patch);
  } catch (error) {
    return noWriteFailure(plan, errorMessage(error));
  }

  const patched = normalizeTargetConfig(plan.target.kind, patchedRaw);
  if (!patched.ok) {
    return noWriteFailure(plan, "patched config failed schema validation", [
      ...patched.errors,
    ]);
  }

  if (!jsonEqual(patched.value, plan.after)) {
    return noWriteFailure(
      plan,
      "patched config no longer matches the previewed plan result",
    );
  }

  return await writeConfigTargetAndValidate({
    planId: plan.id,
    targetPath: plan.target.path,
    configKind: plan.target.kind,
    value: patched.value,
    hadExistingFile: readResult.exists,
    reloadConfig: dependencies.reloadConfig,
    validatePostWrite: dependencies.validatePostWrite,
    writeFailureReason: "config command write failed",
    postWriteFailureReason: "post-write validation failed",
  });
}

/** Shared atomic write + backup + post-write validation transaction. */
export async function writeConfigTargetAndValidate(
  input: AtomicConfigWriteInput,
): Promise<ConfigCommandApplyResult> {
  const backupPath = `${input.targetPath}.bak`;
  const tempPath = sameDirectoryTempPath(input.targetPath, input.planId);
  let tempPresent = false;
  let renamed = false;
  let backupCreated = false;

  try {
    await mkdir(path.dirname(input.targetPath), { recursive: true });
    await writeFile(
      tempPath,
      serializeSparseConfigText(input.configKind, input.value),
      "utf8",
    );
    tempPresent = true;

    if (input.hadExistingFile) {
      await copyFile(input.targetPath, backupPath);
      backupCreated = true;
    }

    await rename(tempPath, input.targetPath);
    tempPresent = false;
    renamed = true;

    const resolvedConfig = await input.reloadConfig();
    const policyValidation = await input.validatePostWrite(resolvedConfig);
    if (!policyValidation.ok) {
      const restored = await restoreAfterFailedValidation(
        input.targetPath,
        backupPath,
        input.hadExistingFile,
      );
      return {
        ok: false,
        planId: input.planId,
        targetPath: input.targetPath,
        reason: input.postWriteFailureReason,
        wrote: true,
        restored,
        errors: policyValidation.errors,
      };
    }

    return {
      ok: true,
      planId: input.planId,
      changed: true,
      targetPath: input.targetPath,
      ...(backupCreated ? { backupPath } : {}),
      resolvedConfig,
      warnings: policyValidation.warnings ?? [],
    };
  } catch (error) {
    const restored = renamed
      ? await restoreAfterFailedValidation(
          input.targetPath,
          backupPath,
          input.hadExistingFile,
        )
      : false;
    return {
      ok: false,
      planId: input.planId,
      targetPath: input.targetPath,
      reason: input.writeFailureReason,
      wrote: renamed,
      restored,
      errors: [errorMessage(error)],
    };
  } finally {
    if (tempPresent) {
      await unlinkIfExists(tempPath);
    }
  }
}

export function applyJsonPatchDocument(
  document: unknown,
  patch: readonly JsonPatchOperation[],
): unknown {
  const draft = cloneJsonish(document);
  for (const operation of patch) {
    applyJsonPatchOperation(draft, operation);
  }
  return draft;
}

function validateAcknowledgement(
  plan: ConfigCommandPlan,
  acknowledgement: ConfigCommandAcknowledgement,
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
  kind: ConfigCommandTargetKind,
  raw: unknown,
): NormalizedTarget {
  const schema: TSchema =
    kind === "global" ? GlobalConfigSchema : ProjectOverlaySchema;
  const result = normalizeConfig(schema, cloneJsonish(raw));

  if (result.ok) {
    return { ok: true, value: result.value as TargetConfig };
  }

  return {
    ok: false,
    errors: result.errors.map((error) => `${error.path}: ${error.message}`),
  };
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

async function restoreAfterFailedValidation(
  targetPath: string,
  backupPath: string,
  hadExistingFile: boolean,
): Promise<boolean> {
  try {
    if (hadExistingFile) {
      await copyFile(backupPath, targetPath);
    } else {
      await unlinkIfExists(targetPath);
    }
    return true;
  } catch {
    return false;
  }
}

function sameDirectoryTempPath(targetPath: string, planId: string): string {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const safePlan = planId.replace(/[^a-zA-Z0-9._-]/gu, "-");
  return path.join(directory, `.${basename}.${safePlan}.${randomUUID()}.tmp`);
}

function noWriteFailure(
  plan: ConfigCommandPlan,
  reason: string,
  errors: readonly string[] = [reason],
): ConfigCommandApplyResult {
  return {
    ok: false,
    planId: plan.id,
    targetPath: plan.target.path,
    reason,
    wrote: false,
    restored: false,
    errors,
  };
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
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
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
