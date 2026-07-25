import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMcpSourceRegistration } from "../../src/application/mcp-source-registration.js";
import {
  McpConfigSourceSchemaV1,
  McpRuntimeCapabilitiesSchemaV1,
  McpSourceIdentitySchemaV1,
  McpSourceStatusSchema,
  type McpLaunchValueProvider,
  type McpLaunchValues,
  type McpRuntimeLease,
  type McpRuntimeLeaseProvider,
  type McpRuntimePort,
  type McpSourceIdentity,
  type McpSourcePrecondition,
} from "../../src/application/ports/mcp-runtime.js";
import { ContentDigestSchema } from "../../src/domain/content-manifest.js";
import { ComponentIdSchema } from "../../src/domain/components.js";
import { PluginKeySchema } from "../../src/domain/identity.js";
import { SourceLocationSchema } from "../../src/domain/provenance-location.js";

export interface McpRuntimeContractHarness {
  readonly runtime: McpRuntimePort;
  launch(
    identity: McpSourceIdentity,
    serverKey: string,
    signal: AbortSignal,
    consume?: (values: McpLaunchValues) => void | Promise<void>,
  ): Promise<void>;
  openExecution(
    identity: McpSourceIdentity,
    serverKey: string,
    signal: AbortSignal,
  ): Promise<Readonly<{ close(signal?: AbortSignal): Promise<void> }>>;
  failNextReplacement(): void | Promise<void>;
}

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const location = SourceLocationSchema.parse({
  host: "claude",
  documentKind: "mcp",
  path: "plugin.mcp.json",
  pointer: "/mcpServers/shared",
});
const digest = (hex: string) => ContentDigestSchema.parse(`sha256:${hex.repeat(64).slice(0, 64)}`);
const runtimeKey = (hex: string) => `mcp-server-v1:${hex.repeat(64).slice(0, 64)}`;
const sharedKey = runtimeKey("a");
const alphaKey = runtimeKey("1");
const zuluKey = runtimeKey("f");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function identity(token: string, overrides: Readonly<Record<string, unknown>> = {}): McpSourceIdentity {
  return McpSourceIdentitySchemaV1.parse({
    schemaVersion: 1,
    scope: { kind: "user" },
    plugin: PluginKeySchema.parse(`plugin-${token}@community`),
    revision: digest(token),
    projectionDigest: digest(`${token}0`),
    ...overrides,
  });
}

function source(
  sourceIdentity: McpSourceIdentity,
  keys: readonly string[] = [sharedKey],
  transport: "stdio" | "streamable-http" = "stdio",
) {
  return McpConfigSourceSchemaV1.parse({
    schemaVersion: 1,
    identity: sourceIdentity,
    servers: Object.fromEntries(keys.map((key, index) => [key, {
      componentId: ComponentIdSchema.parse(`component-v1:mcp-server:${key.slice("mcp-server-v1:".length)}`),
      nativeKey: `native-${index}`,
      transport,
      options: { schemaVersion: 1, toolTimeoutMs: 500, auth: { kind: "none" } },
      projection: {
        schemaVersion: 1,
        componentId: ComponentIdSchema.parse(`component-v1:mcp-server:${key.slice("mcp-server-v1:".length)}`),
        contentRef: `plugin-content-v1:sha256:${"c".repeat(64)}`,
        dataRef: `plugin-data-v1:sha256:${"d".repeat(64)}`,
      },
      launchTemplate: transport === "stdio"
        ? {
            schemaVersion: 1,
            transport: "stdio",
            command: "safe-command-template",
            args: [],
            env: [],
          }
        : {
            schemaVersion: 1,
            transport: "streamable-http",
            url: "https://safe.invalid/mcp",
            headers: [],
          },
      toolAliases: [],
      provenance: [location],
    }])),
  });
}

function launchProvider(
  counters: { resolved: number; disposed: number },
  values: McpLaunchValues = { transport: "stdio", command: "safe-command", args: [] },
  resolve?: McpLaunchValueProvider["resolve"],
): McpLaunchValueProvider {
  const issued = new WeakSet<object>();
  const disposed = new WeakSet<object>();
  return {
    async resolve(request, signal) {
      counters.resolved += 1;
      const resolved = resolve === undefined ? clone(values) : await resolve(request, signal);
      if (issued.has(resolved as object)) throw new Error("provider retained a shared values object");
      issued.add(resolved as object);
      return resolved;
    },
    async dispose(candidate) {
      if (!issued.has(candidate as object) || disposed.has(candidate as object)) {
        throw new Error("provider disposal ownership was violated");
      }
      disposed.add(candidate as object);
      counters.disposed += 1;
    },
  };
}

function runtimeLeaseProvider() {
  const active = new WeakSet<object>();
  const issued: object[] = [];
  const counters = { acquired: 0, released: 0 };
  const provider: McpRuntimeLeaseProvider = {
    async acquire(_binding, signal) {
      signal.throwIfAborted();
      const token = Object.freeze({ toJSON: () => "[REDACTED]" });
      active.add(token);
      issued.push(token);
      counters.acquired += 1;
      return token as unknown as McpRuntimeLease;
    },
    async release(lease, signal) {
      signal.throwIfAborted();
      const token = lease as object;
      if (!active.has(token)) throw new Error("runtime lease release ownership was violated");
      active.delete(token);
      counters.released += 1;
    },
    async drain(signal) {
      for (const token of issued) {
        if (active.has(token)) await provider.release(token as unknown as McpRuntimeLease, signal);
      }
    },
  };
  return { provider, counters };
}

function replacement(
  sourceValue: ReturnType<typeof source>,
  launchValues: McpLaunchValueProvider,
  runtimeLeases: McpRuntimeLeaseProvider,
  expected: McpSourcePrecondition = { kind: "absent" },
) {
  return {
    registration: createMcpSourceRegistration({ source: sourceValue, sha256 }),
    expected,
    launchValues,
    runtimeLeases,
  };
}

function expectUnavailable(error: unknown, reason: Error): void {
  expect(error).toBe(reason);
}

/** Adapter-neutral assertions reused unchanged by the fake and future package wrapper. */
export async function assertMcpRuntimeContract(harness: McpRuntimeContractHarness): Promise<void> {
  const runtime = harness.runtime;
  const signal = new AbortController().signal;
  const capabilities = McpRuntimeCapabilitiesSchemaV1.parse(await runtime.capabilities(signal));
  expect(capabilities.sourceLifecycle.runtimeLeases).toBe(true);
  expect(Object.values(capabilities.sourceLifecycle).every((value) => typeof value === "boolean")).toBe(true);

  const firstIdentity = identity("1");
  const firstSource = source(firstIdentity, [zuluKey, alphaKey]);
  const firstCounters = { resolved: 0, disposed: 0 };
  const firstRuntimeLeases = runtimeLeaseProvider();
  const firstRequest = replacement(firstSource, launchProvider(firstCounters), firstRuntimeLeases.provider);
  const validation = await runtime.validateSource(firstRequest.registration, signal);
  expect(validation.ok).toBe(true);
  if (!validation.ok) throw new Error("valid registration was rejected");
  expect(validation.value).toEqual(firstRequest.registration);
  expect(firstCounters).toEqual({ resolved: 0, disposed: 0 });

  const applied = await runtime.replaceSource(firstRequest, signal);
  expect(applied.kind).toBe("applied");
  const firstStatus = await runtime.inspectSource(firstIdentity, signal);
  expect(firstStatus).toBeDefined();
  if (firstStatus === undefined) throw new Error("applied source was not inspectable");
  McpSourceStatusSchema.parse(firstStatus);
  expect(firstStatus.registrationDigest).toBe(firstRequest.registration.digest);
  expect(firstStatus.state).toBe("registered");
  expect(firstStatus.servers.map((server) => server.key)).toEqual([alphaKey, zuluKey]);
  expect(JSON.stringify(firstStatus)).not.toMatch(/safe-command-template|safe-command|CANARY/);

  await harness.launch(firstIdentity, alphaKey, signal);
  expect(firstCounters).toEqual({ resolved: 1, disposed: 1 });
  expect(firstRuntimeLeases.counters).toEqual({ acquired: 1, released: 1 });
  const open = await harness.openExecution(firstIdentity, alphaKey, signal);
  expect(firstCounters).toEqual({ resolved: 2, disposed: 2 });
  expect(firstRuntimeLeases.counters).toEqual({ acquired: 2, released: 1 });

  const secondIdentity = identity("2", {
    plugin: firstIdentity.plugin,
    revision: digest("3"),
    projectionDigest: digest("4"),
  });
  const secondRuntimeLeases = runtimeLeaseProvider();
  const secondRequest = replacement(
    source(secondIdentity, [alphaKey]),
    launchProvider({ resolved: 0, disposed: 0 }),
    secondRuntimeLeases.provider,
    { kind: "exact", identity: firstIdentity },
  );
  const replaced = await runtime.replaceSource(secondRequest, signal);
  expect(replaced).toMatchObject({ kind: "applied", previousIdentity: firstIdentity });
  expect(firstRuntimeLeases.counters).toEqual({ acquired: 2, released: 2 });
  await open.close();
  expect(await runtime.inspectSource(firstIdentity, signal)).toBeUndefined();

  const staleIdentity = identity("5", {
    plugin: firstIdentity.plugin,
    revision: digest("6"),
    projectionDigest: digest("7"),
  });
  const stale = await runtime.replaceSource(replacement(
    source(staleIdentity),
    launchProvider({ resolved: 0, disposed: 0 }),
    runtimeLeaseProvider().provider,
    { kind: "exact", identity: firstIdentity },
  ), signal);
  expect(stale).toMatchObject({ kind: "stale", currentIdentity: secondIdentity });
  expect(await runtime.inspectSource(secondIdentity, signal)).toBeDefined();

  await harness.failNextReplacement();
  const rejected = await runtime.replaceSource(replacement(
    source(staleIdentity),
    launchProvider({ resolved: 0, disposed: 0 }),
    runtimeLeaseProvider().provider,
    { kind: "exact", identity: secondIdentity },
  ), signal);
  expect(rejected.kind).toBe("rejected");
  expect(await runtime.inspectSource(secondIdentity, signal)).toBeDefined();

  const collidingOwner = identity("e");
  await runtime.replaceSource(replacement(
    source(collidingOwner),
    launchProvider({ resolved: 0, disposed: 0 }),
    runtimeLeaseProvider().provider,
  ), signal);
  expect(await runtime.inspectSource(collidingOwner, signal)).toBeDefined();
  expect(await runtime.inspectSource(secondIdentity, signal)).toBeDefined();

  expect(await runtime.removeSource(secondIdentity, signal)).toEqual({ kind: "removed" });
  expect(await runtime.removeSource(secondIdentity, signal)).toEqual({ kind: "absent" });
  expect(await runtime.inspectSource(collidingOwner, signal)).toBeDefined();

  const mismatchCounters = { resolved: 0, disposed: 0 };
  const mismatchIdentity = identity("f", { plugin: PluginKeySchema.parse("mismatch@community") });
  const mismatchLeases = runtimeLeaseProvider();
  await runtime.replaceSource(replacement(
    source(mismatchIdentity),
    launchProvider(mismatchCounters, { transport: "streamable-http", url: "https://safe.invalid/mcp" }),
    mismatchLeases.provider,
  ), signal);
  await expect(harness.launch(mismatchIdentity, sharedKey, signal)).rejects.toThrow();
  expect(mismatchCounters).toEqual({ resolved: 1, disposed: 1 });
  expect(mismatchLeases.counters).toEqual({ acquired: 1, released: 1 });

  const cancelController = new AbortController();
  const cancelCounters = { resolved: 0, disposed: 0 };
  const cancelIdentity = identity("a", { plugin: PluginKeySchema.parse("cancel@community") });
  const cancelLeases = runtimeLeaseProvider();
  await runtime.replaceSource(replacement(
    source(cancelIdentity),
    launchProvider(cancelCounters, undefined, async () => {
      cancelController.abort(new Error("launch cancelled"));
      return { transport: "stdio", command: "safe-command", args: [] };
    }),
    cancelLeases.provider,
  ), signal);
  await expect(harness.launch(cancelIdentity, sharedKey, cancelController.signal)).rejects.toThrow("launch cancelled");
  expect(cancelCounters).toEqual({ resolved: 1, disposed: 1 });
  expect(cancelLeases.counters).toEqual({ acquired: 1, released: 1 });

  const preAbortMethods: readonly [string, (abortSignal: AbortSignal) => Promise<unknown>][] = [
    ["capabilities", (abortSignal) => runtime.capabilities(abortSignal)],
    ["validate", (abortSignal) => runtime.validateSource(firstRequest.registration, abortSignal)],
    ["replace", (abortSignal) => runtime.replaceSource(firstRequest, abortSignal)],
    ["remove", (abortSignal) => runtime.removeSource(collidingOwner, abortSignal)],
    ["inspect", (abortSignal) => runtime.inspectSource(collidingOwner, abortSignal)],
    ["inspectSources", (abortSignal) => runtime.inspectSources(abortSignal)],
    ["launch", (abortSignal) => harness.launch(collidingOwner, sharedKey, abortSignal)],
  ];
  for (const [name, operation] of preAbortMethods) {
    const controller = new AbortController();
    const reason = new Error(`${name} cancelled`);
    controller.abort(reason);
    const outcome = await Promise.resolve().then(() => operation(controller.signal)).then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    expect(outcome.kind, `${name} must reject a pre-aborted operation`).toBe("rejected");
    if (outcome.kind === "rejected") expectUnavailable(outcome.error, reason);
  }
}

export function defineMcpRuntimeContract(
  name: string,
  create: () => McpRuntimeContractHarness | Promise<McpRuntimeContractHarness>,
): void {
  describe(`${name} MCP runtime contract`, () => {
    it("satisfies exact source lifecycle, cleanup, and redaction semantics", async () => {
      await assertMcpRuntimeContract(await create());
    });
  });
}
