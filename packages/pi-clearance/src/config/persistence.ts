import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  copyFile,
  lstat,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { resolveUserConfigRoot } from "./paths.ts";
import {
  CONFIG_SCHEMA_VERSION,
  type GlobalConfig,
  GlobalConfigSchema,
  normalizeConfig,
  type ProjectOverlayConfig,
  ProjectOverlaySchema,
} from "./schema.ts";

export type ConfigPersistenceKind = "global" | "project";
export type NormalizedConfig = GlobalConfig | ProjectOverlayConfig;

/** The only JSON shape emitted for user-owned Clearance config files. */
export type SparseConfigDocument = Readonly<Record<string, unknown>> & {
  readonly version: typeof CONFIG_SCHEMA_VERSION;
};

const OMIT = Symbol("omit-default");

/**
 * Serialize a schema-normalized runtime config without materializing defaults.
 *
 * Defaults are obtained by normalizing the schema's version-only seed rather
 * than copied here. Objects are compacted recursively; arrays are semantic
 * values and are retained as a whole whenever they differ from their default.
 */
export function serializeSparseConfig(
  kind: ConfigPersistenceKind,
  config: NormalizedConfig,
): SparseConfigDocument {
  const defaults = normalizedDefaults(kind);
  const compacted = compactValue(config, defaults);
  const document: Record<string, unknown> = {
    version: config.version,
  };

  if (isRecord(compacted)) {
    for (const [key, value] of Object.entries(compacted)) {
      if (key !== "version") {
        document[key] = value;
      }
    }
  }

  return canonicalize(document) as SparseConfigDocument;
}

/** Return the canonical on-disk representation for a normalized config. */
export function serializeSparseConfigText(
  kind: ConfigPersistenceKind,
  config: NormalizedConfig,
): string {
  return `${JSON.stringify(serializeSparseConfig(kind, config), null, 2)}\n`;
}

/** Return the canonical clean-cutover replacement for an invalid config file. */
export function emptyConfigText(): string {
  return `${JSON.stringify({ version: CONFIG_SCHEMA_VERSION }, null, 2)}\n`;
}

export type ConfigRepairCopyFile = (
  sourcePath: string,
  destinationPath: string,
) => Promise<void>;
export type ConfigRepairWriteFile = (
  filePath: string,
  contents: string,
) => Promise<void>;
export type ConfigRepairRename = (
  sourcePath: string,
  destinationPath: string,
) => Promise<void>;
export type ConfigRepairUnlink = (filePath: string) => Promise<void>;

/**
 * Narrow mutation seam used by tests to make repair failures deterministic.
 * Discovery and reads remain on the real filesystem; production uses the
 * default implementations below.
 */
export interface ConfigRepairFileSystem {
  readonly copyFile: ConfigRepairCopyFile;
  readonly writeFile: ConfigRepairWriteFile;
  readonly rename: ConfigRepairRename;
  readonly unlink: ConfigRepairUnlink;
}

const defaultConfigRepairFileSystem: ConfigRepairFileSystem = {
  copyFile: async (sourcePath, destinationPath) => {
    await copyFile(sourcePath, destinationPath);
  },
  writeFile: async (filePath, contents) => {
    await writeFile(filePath, contents, "utf8");
  },
  rename: async (sourcePath, destinationPath) => {
    await rename(sourcePath, destinationPath);
  },
  unlink: async (filePath) => {
    await unlink(filePath);
  },
};

export interface ConfigRepairOptions {
  readonly userConfigRoot?: string;
  readonly fileSystem?: Partial<ConfigRepairFileSystem>;
}

export type ConfigRepairAction =
  | "unchanged"
  | "compacted"
  | "reset"
  | "skipped-symlink";

export interface ConfigRepairResult {
  readonly path: string;
  readonly kind: ConfigPersistenceKind;
  readonly action: ConfigRepairAction;
  readonly backupPath?: string;
}

export interface ConfigRepairError {
  readonly path: string;
  readonly kind: ConfigPersistenceKind;
  readonly message: string;
}

export interface ConfigRepairReport {
  readonly userConfigRoot: string;
  readonly results: readonly ConfigRepairResult[];
  readonly errors: readonly ConfigRepairError[];
}

/**
 * Repair only existing user-owned config files after npm installation.
 *
 * This deliberately discovers files instead of creating the config root or
 * project directories. Install can therefore clean up materialized defaults
 * without turning an absent config into a user-owned settings file.
 */
export async function repairExistingConfigFiles(
  options: ConfigRepairOptions = {},
): Promise<ConfigRepairReport> {
  const userConfigRoot = options.userConfigRoot ?? resolveUserConfigRoot();
  const fileSystem = {
    ...defaultConfigRepairFileSystem,
    ...options.fileSystem,
  };
  const discovered = await existingConfigTargets(userConfigRoot);
  const results: ConfigRepairResult[] = [...discovered.skipped];
  const errors: ConfigRepairError[] = [];

  for (const target of discovered.targets) {
    try {
      results.push(await repairConfigFile(target, fileSystem));
    } catch (error) {
      errors.push({
        path: target.path,
        kind: target.kind,
        message: errorMessage(error),
      });
    }
  }

  return { userConfigRoot, results, errors };
}

interface ConfigRepairTarget {
  readonly path: string;
  readonly kind: ConfigPersistenceKind;
}

interface ExistingConfigTargets {
  readonly targets: readonly ConfigRepairTarget[];
  readonly skipped: readonly ConfigRepairResult[];
}

async function existingConfigTargets(
  userConfigRoot: string,
): Promise<ExistingConfigTargets> {
  const targets: ConfigRepairTarget[] = [];
  const skipped: ConfigRepairResult[] = [];
  const globalPath = path.join(userConfigRoot, "global.json");
  const globalKind = await existingPathKind(globalPath);
  if (globalKind === "symlink") {
    skipped.push(skippedSymlinkResult(globalPath, "global"));
  } else if (globalKind === "file") {
    targets.push({ path: globalPath, kind: "global" });
  }

  const projectsRoot = path.join(userConfigRoot, "projects");
  const projectsRootKind = await existingPathKind(projectsRoot);
  if (projectsRootKind === "symlink") {
    skipped.push(skippedSymlinkResult(projectsRoot, "project"));
    return { targets, skipped };
  }

  let entries: readonly Dirent[];
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return { targets, skipped };
    }
    throw error;
  }

  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const projectPath = path.join(projectsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      skipped.push(skippedSymlinkResult(projectPath, "project"));
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    const overlayPath = path.join(projectPath, "overlay.json");
    const overlayKind = await existingPathKind(overlayPath);
    if (overlayKind === "symlink") {
      skipped.push(skippedSymlinkResult(overlayPath, "project"));
    } else if (overlayKind === "file") {
      targets.push({ path: overlayPath, kind: "project" });
    }
  }

  return { targets, skipped };
}

async function repairConfigFile(
  target: ConfigRepairTarget,
  fileSystem: ConfigRepairFileSystem,
): Promise<ConfigRepairResult> {
  if ((await existingPathKind(target.path)) === "symlink") {
    return skippedSymlinkResult(target.path, target.kind);
  }
  const original = await readFile(target.path, "utf8");
  let desired: string;
  let action: Exclude<ConfigRepairAction, "unchanged">;

  try {
    const raw = JSON.parse(original) as unknown;
    const normalized = normalizeTargetConfig(target.kind, raw);
    if (!normalized.ok) {
      desired = emptyConfigText();
      action = "reset";
    } else {
      desired = serializeSparseConfigText(target.kind, normalized.value);
      action = "compacted";
    }
  } catch {
    desired = emptyConfigText();
    action = "reset";
  }

  if (original === desired) {
    return { path: target.path, kind: target.kind, action: "unchanged" };
  }

  const backupPath = `${target.path}.bak`;
  await backupAndReplace(target.path, backupPath, desired, fileSystem);
  return { path: target.path, kind: target.kind, action, backupPath };
}

function normalizeTargetConfig(
  kind: ConfigPersistenceKind,
  raw: unknown,
):
  | { readonly ok: true; readonly value: NormalizedConfig }
  | { readonly ok: false } {
  const result = normalizeConfig(
    kind === "global" ? GlobalConfigSchema : ProjectOverlaySchema,
    raw,
  );
  return result.ok ? { ok: true, value: result.value } : { ok: false };
}

async function backupAndReplace(
  targetPath: string,
  backupPath: string,
  contents: string,
  fileSystem: ConfigRepairFileSystem,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.postinstall.${randomUUID()}.tmp`,
  );
  let tempPresent = false;
  let renamed = false;

  try {
    // The backup is made before the target is replaced, including for a
    // formatting-only canonicalization. The next repair can replace this .bak
    // with the immediately preceding source document.
    await fileSystem.copyFile(targetPath, backupPath);
    await fileSystem.writeFile(tempPath, contents);
    tempPresent = true;
    await fileSystem.rename(tempPath, targetPath);
    tempPresent = false;
    renamed = true;
  } catch (error) {
    if (renamed) {
      try {
        await fileSystem.copyFile(backupPath, targetPath);
      } catch {
        // Preserve the original failure while reporting that restoration was
        // not possible through the postinstall error boundary.
      }
    }
    throw error;
  } finally {
    if (tempPresent) {
      await unlinkIfExists(tempPath, fileSystem);
    }
  }
}

function normalizedDefaults(kind: ConfigPersistenceKind): NormalizedConfig {
  const schema = kind === "global" ? GlobalConfigSchema : ProjectOverlaySchema;
  const result = normalizeConfig(schema, { version: CONFIG_SCHEMA_VERSION });
  if (!result.ok) {
    throw new Error(`failed to normalize ${kind} config defaults`);
  }
  return result.value;
}

function compactValue(value: unknown, defaults: unknown): unknown {
  if (jsonEqual(value, defaults)) {
    return OMIT;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonish(entry));
  }

  if (isRecord(value)) {
    const defaultRecord = isRecord(defaults) ? defaults : undefined;
    const compacted: Record<string, unknown> = {};
    for (const key of orderedKeys(Object.keys(value))) {
      const child = compactValue(value[key], defaultRecord?.[key]);
      if (child !== OMIT) {
        compacted[key] = child;
      }
    }
    return Object.keys(compacted).length === 0 ? OMIT : compacted;
  }

  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of orderedKeys(Object.keys(value))) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }

  return value;
}

function orderedKeys(keys: readonly string[]): readonly string[] {
  return [...keys].sort((left, right) => {
    if (left === "version") return -1;
    if (right === "version") return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
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

type ExistingPathKind = "missing" | "file" | "symlink" | "other";

async function existingPathKind(filePath: string): Promise<ExistingPathKind> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (isMissingFileError(error)) return "missing";
    throw error;
  }
}

function skippedSymlinkResult(
  filePath: string,
  kind: ConfigPersistenceKind,
): ConfigRepairResult {
  return { path: filePath, kind, action: "skipped-symlink" };
}

async function unlinkIfExists(
  filePath: string,
  fileSystem: ConfigRepairFileSystem,
): Promise<void> {
  try {
    await fileSystem.unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
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
