import { createHash } from "node:crypto";
import {
  McpLaunchBindingSchemaV1,
  type McpLaunchActiveSelection,
  type McpLaunchActiveSelectionPort,
  type McpLaunchBinding,
} from "../../../src/application/ports/mcp-launch-context.js";
import type {
  McpLaunchEnvironmentPort,
  ResolvedMcpLaunchEnvironment,
} from "../../../src/application/ports/mcp-launch-environment.js";
import type { Sha256 } from "../../../src/domain/source.js";

export const mcpLaunchSha256: Sha256 = (bytes) =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Deterministic pin-or-wait active-selection lease for portable tests. */
export class FakeMcpLaunchActiveSelection implements McpLaunchActiveSelectionPort {
  private selected: Readonly<{ binding: McpLaunchBinding; selection: McpLaunchActiveSelection }>;
  private readonly idleWaiters = new Set<() => void>();
  private inFlight = 0;
  calls = 0;

  constructor(binding: McpLaunchBinding, selection: McpLaunchActiveSelection) {
    this.selected = {
      binding: McpLaunchBindingSchemaV1.parse(binding),
      selection,
    };
  }

  async withSelection(
    bindingInput: McpLaunchBinding,
    signal: AbortSignal,
    use: (selection: McpLaunchActiveSelection) => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    const binding = McpLaunchBindingSchemaV1.parse(bindingInput);
    const selected = this.selected;
    if (!sameJson(binding, selected.binding)) throw new Error("active MCP selection is unavailable");
    this.calls += 1;
    this.inFlight += 1;
    try {
      await use(selected.selection);
      return undefined;
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        for (const wake of this.idleWaiters) wake();
        this.idleWaiters.clear();
      }
    }
  }

  /** Replacement waits rather than invalidating a live callback snapshot. */
  async replace(binding: McpLaunchBinding, selection: McpLaunchActiveSelection): Promise<void> {
    if (this.inFlight > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
    this.selected = { binding: McpLaunchBindingSchemaV1.parse(binding), selection };
  }
}

function validateNames(names: readonly string[]): readonly string[] {
  const parsed = names.map((name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("invalid requested environment name");
    return name;
  });
  if (new Set(parsed).size !== parsed.length ||
      parsed.some((name, index) => index > 0 && parsed[index - 1]! > name)) {
    throw new Error("requested environment names must be unique and sorted");
  }
  return parsed;
}

export class FakeMcpLaunchEnvironment implements McpLaunchEnvironmentPort {
  private values: Readonly<Record<string, string>>;
  readonly requests: string[][] = [];
  disposed = 0;

  constructor(values: Readonly<Record<string, string>> = {}) {
    this.values = { ...values };
  }

  replace(values: Readonly<Record<string, string>>): void {
    this.values = { ...values };
  }

  async withResolved(
    namesInput: readonly string[],
    signal: AbortSignal,
    use: (environment: ResolvedMcpLaunchEnvironment) => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    const names = validateNames(namesInput);
    this.requests.push([...names]);
    const values = new Map(names.filter((name) => Object.prototype.hasOwnProperty.call(this.values, name))
      .map((name) => [name, this.values[name]!]));
    let disposed = false;
    const assertLive = () => {
      if (disposed) throw new Error("resolved MCP environment is disposed");
    };
    const facade: ResolvedMcpLaunchEnvironment = Object.freeze({
      has(name: string): boolean {
        assertLive();
        return values.has(name);
      },
      substitute(template: string): string {
        assertLive();
        return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
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
      return undefined;
    } finally {
      disposed = true;
      values.clear();
      this.disposed += 1;
    }
  }
}
