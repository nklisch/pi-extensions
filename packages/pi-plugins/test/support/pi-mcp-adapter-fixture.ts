import { createHash } from "node:crypto";
import { createMcpSourceRegistration } from "../../src/application/mcp-source-registration.js";
import {
  McpConfigSourceSchemaV1,
  McpSourceIdentitySchemaV1,
  type McpLaunchValueProvider,
  type McpLaunchValues,
  type McpRuntimeLease,
  type McpRuntimeLeaseProvider,
  type McpSourceIdentity,
  type McpSourcePrecondition,
  type McpSourceRegistration,
  type McpSourceReplaceRequest,
} from "../../src/application/ports/mcp-runtime.js";
import { ComponentIdSchema } from "../../src/domain/components.js";
import { ContentDigestSchema } from "../../src/domain/content-manifest.js";
import { PluginKeySchema } from "../../src/domain/identity.js";
import { SourceLocationSchema } from "../../src/domain/provenance-location.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const location = SourceLocationSchema.parse({
  host: "claude",
  documentKind: "mcp",
  path: "plugin.mcp.json",
  pointer: "/mcpServers/shared",
});

export const fixtureMcpServerKey = `mcp-server-v1:${"a".repeat(64)}` as const;

function digest(token: string) {
  return ContentDigestSchema.parse(`sha256:${token.repeat(64).slice(0, 64)}`);
}

export function fixtureMcpIdentity(
  token: string,
  overrides: Readonly<Partial<McpSourceIdentity>> = {},
): McpSourceIdentity {
  return McpSourceIdentitySchemaV1.parse({
    schemaVersion: 1,
    scope: { kind: "user" },
    plugin: PluginKeySchema.parse(`plugin-${token}@community`),
    revision: digest(token),
    projectionDigest: digest(`${token}0`),
    ...overrides,
  });
}

export function fixtureMcpRegistration(input: Readonly<{
  identity?: McpSourceIdentity;
  token?: string;
  transport?: "stdio" | "streamable-http";
  nativeKey?: string;
}> = {}): McpSourceRegistration {
  const identity = input.identity ?? fixtureMcpIdentity(input.token ?? "1");
  const transport = input.transport ?? "stdio";
  const componentId = ComponentIdSchema.parse(
    `component-v1:mcp-server:${fixtureMcpServerKey.slice("mcp-server-v1:".length)}`,
  );
  const source = McpConfigSourceSchemaV1.parse({
    schemaVersion: 1,
    identity,
    servers: {
      [fixtureMcpServerKey]: {
        componentId,
        nativeKey: input.nativeKey ?? "shared",
        transport,
        options: {
          schemaVersion: 1,
          toolTimeoutMs: 2_000,
          auth: { kind: "none" },
        },
        projection: {
          schemaVersion: 1,
          componentId,
          contentRef: `plugin-content-v1:sha256:${"c".repeat(64)}`,
          dataRef: `plugin-data-v1:sha256:${"d".repeat(64)}`,
        },
        launchTemplate: transport === "stdio"
          ? {
              schemaVersion: 1,
              transport: "stdio",
              command: "late-command-template",
              args: [],
              env: [],
            }
          : {
              schemaVersion: 1,
              transport: "streamable-http",
              endpointSecurity: "tls",
              url: "https://template.invalid/mcp",
              headers: [],
            },
        toolAliases: [],
        provenance: [location],
      },
    },
  });
  return createMcpSourceRegistration({ source, sha256 });
}

export type FixtureProviderCounters = {
  resolved: number;
  disposed: number;
  acquired: number;
  released: number;
  drained: number;
};

export function fixtureMcpProviders(input: Readonly<{
  values?: McpLaunchValues;
  resolve?: McpLaunchValueProvider["resolve"];
  drain?: McpRuntimeLeaseProvider["drain"];
}> = {}): Readonly<{
  launchValues: McpLaunchValueProvider;
  runtimeLeases: McpRuntimeLeaseProvider;
  counters: FixtureProviderCounters;
}> {
  const counters: FixtureProviderCounters = {
    resolved: 0,
    disposed: 0,
    acquired: 0,
    released: 0,
    drained: 0,
  };
  const issuedValues = new WeakSet<object>();
  const disposedValues = new WeakSet<object>();
  const activeLeases = new WeakSet<object>();
  const leases: object[] = [];
  const launchValues: McpLaunchValueProvider = {
    async resolve(request, signal) {
      counters.resolved += 1;
      const values = input.resolve === undefined
        ? structuredClone(input.values ?? { transport: "stdio" as const, command: process.execPath, args: [] })
        : await input.resolve(request, signal);
      if (issuedValues.has(values as object)) throw new Error("launch values were reused");
      issuedValues.add(values as object);
      return values;
    },
    async dispose(values) {
      if (!issuedValues.has(values as object) || disposedValues.has(values as object)) {
        throw new Error("launch value disposal ownership mismatch");
      }
      disposedValues.add(values as object);
      counters.disposed += 1;
    },
  };
  const runtimeLeases: McpRuntimeLeaseProvider = {
    async acquire(_binding, signal) {
      signal.throwIfAborted();
      const lease = Object.freeze({ toJSON: () => "[REDACTED]" });
      activeLeases.add(lease);
      leases.push(lease);
      counters.acquired += 1;
      return lease as unknown as McpRuntimeLease;
    },
    async release(lease, signal) {
      signal.throwIfAborted();
      if (!activeLeases.has(lease as object)) throw new Error("runtime lease ownership mismatch");
      activeLeases.delete(lease as object);
      counters.released += 1;
    },
    async drain(signal) {
      counters.drained += 1;
      if (input.drain !== undefined) return input.drain(signal);
      for (const lease of leases) {
        if (activeLeases.has(lease)) await runtimeLeases.release(lease as unknown as McpRuntimeLease, signal);
      }
    },
  };
  return Object.freeze({ launchValues, runtimeLeases, counters });
}

export function fixtureMcpReplacement(
  registration: McpSourceRegistration,
  providers: ReturnType<typeof fixtureMcpProviders>,
  expected: McpSourcePrecondition = { kind: "absent" },
): McpSourceReplaceRequest {
  return {
    registration,
    expected,
    launchValues: providers.launchValues,
    runtimeLeases: providers.runtimeLeases,
  };
}
