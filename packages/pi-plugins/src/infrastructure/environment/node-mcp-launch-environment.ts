import type {
  McpLaunchEnvironmentPort,
  ResolvedMcpLaunchEnvironment,
} from "../../application/ports/mcp-launch-environment.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function validateNames(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input)) throw new TypeError("requested environment names must be an array");
  const names = input.map((name) => {
    if (typeof name !== "string" || !NAME.test(name)) throw new TypeError("requested environment name is invalid");
    return name;
  });
  if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && names[index - 1]! > name)) {
    throw new TypeError("requested environment names must be unique and sorted");
  }
  return names;
}

/** Capture ambient names once at explicit startup; resolve only requested values per callback. */
export function createNodeMcpLaunchEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): McpLaunchEnvironmentPort {
  const captured = Object.freeze({ ...environment });
  return Object.freeze({
    async withResolved(
      namesInput: readonly string[],
      signal: AbortSignal,
      use: (environment: ResolvedMcpLaunchEnvironment) => Promise<void>,
    ): Promise<void> {
      signal.throwIfAborted();
      const names = validateNames(namesInput);
      const values = new Map<string, string>();
      for (const name of names) {
        const value = captured[name];
        if (typeof value === "string") values.set(name, value);
      }
      let disposed = false;
      const assertLive = (): void => {
        if (disposed) throw new Error("resolved MCP environment is disposed");
      };
      const facade: ResolvedMcpLaunchEnvironment = Object.freeze({
        has(name: string): boolean {
          assertLive();
          return values.has(name);
        },
        substitute(template: string): string {
          assertLive();
          return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
            const value = values.get(name);
            if (value === undefined) throw new Error("environment value is unavailable");
            return value;
          });
        },
        redact(text: string): string {
          assertLive();
          return [...new Set(values.values())]
            .filter((value) => value.length > 0)
            .sort((left, right) => right.length - left.length)
            .reduce((result, value) => result.replaceAll(value, "[REDACTED]"), text);
        },
        toString: () => "[REDACTED]" as const,
        toJSON: () => "[REDACTED]" as const,
      });
      try {
        await use(facade);
      } finally {
        disposed = true;
        values.clear();
      }
    },
  });
}
