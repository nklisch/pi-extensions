import type { ConfiguredValue } from "../domain/configured-values.js";

export interface ResolvedConfiguration {
  has(key: string): boolean;
  substitute(template: string): string;
  environment(prefix?: "CLAUDE_PLUGIN_OPTION_"): Readonly<Record<string, string>>;
  /** Replace every resolved value without exposing the backing values. */
  redact(text: string): string;
  dispose(): void;
  toString(): "[REDACTED]";
  toJSON(): "[REDACTED]";
}

type ResolvedEntry = Readonly<{ key: string; value: ConfiguredValue }>;

function serialize(value: ConfiguredValue): string {
  switch (value.kind) {
    case "string":
    case "directory":
    case "file": return value.value;
    case "number": return String(value.value);
    case "boolean": return value.value ? "true" : "false";
    case "strings": return JSON.stringify(value.value);
    default: return assertNever(value);
  }
}

/** Create the callback-scoped facade without exposing its backing map. */
export function createResolvedConfiguration(entries: readonly ResolvedEntry[]): ResolvedConfiguration {
  const values = new Map(entries.map((entry) => [entry.key, entry.value]));
  let disposed = false;
  const assertLive = (): void => {
    if (disposed) throw new Error("resolved configuration is disposed");
  };
  const get = (key: string): string => {
    assertLive();
    const entry = values.get(key);
    if (entry === undefined) throw new Error("configuration key is unavailable");
    return serialize(entry);
  };
  const redactionValues = (): readonly string[] => [...new Set([...values.values()].map(serialize).filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  return {
    has(key: string): boolean {
      assertLive();
      return values.has(key);
    },
    substitute(template: string): string {
      assertLive();
      if (typeof template !== "string") throw new TypeError("configuration template must be a string");
      return template.replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => get(key));
    },
    environment(prefix = "CLAUDE_PLUGIN_OPTION_"): Readonly<Record<string, string>> {
      assertLive();
      const result = Object.create(null) as Record<string, string>;
      for (const key of [...values.keys()].sort()) {
        Object.defineProperty(result, `${prefix}${key}`, {
          value: get(key),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(result);
    },
    redact(text: string): string {
      assertLive();
      if (typeof text !== "string") throw new TypeError("redaction input must be a string");
      return redactionValues().reduce((result, value) => result.replaceAll(value, "[REDACTED]"), text);
    },
    dispose(): void {
      disposed = true;
      values.clear();
    },
    toString(): "[REDACTED]" {
      return "[REDACTED]";
    },
    toJSON(): "[REDACTED]" {
      return "[REDACTED]";
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`unhandled resolved configuration value: ${String(value)}`);
}
