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
