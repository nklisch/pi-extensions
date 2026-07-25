import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMcpSourceRegistration } from "../../../src/application/mcp-source-registration.js";
import {
  McpConfigSourceSchemaV1,
  McpSourceIdentitySchemaV1,
  McpSourceStatusSchema,
  type McpLaunchValueProvider,
  type McpLaunchValues,
  type McpSourceIdentity,
  type McpSourcePrecondition,
} from "../../../src/application/ports/mcp-runtime.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import { ComponentIdSchema } from "../../../src/domain/components.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";
import { SourceLocationSchema } from "../../../src/domain/provenance-location.js";
import {
  FakeMcpRuntime,
  FakeMcpRuntimeLeaseProvider,
} from "./mcp-runtime.js";

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

function identity(overrides: Record<string, unknown> = {}): McpSourceIdentity {
  return McpSourceIdentitySchemaV1.parse({
    schemaVersion: 1,
    scope: { kind: "user" },
    plugin: PluginKeySchema.parse("demo@community"),
    revision: digest("1"),
    projectionDigest: digest("2"),
    ...overrides,
  });
}

function source(sourceIdentity: McpSourceIdentity, keys: readonly string[] = [sharedKey]) {
  return McpConfigSourceSchemaV1.parse({
    schemaVersion: 1,
    identity: sourceIdentity,
    servers: Object.fromEntries(keys.map((key, index) => [key, {
      componentId: ComponentIdSchema.parse(`component-v1:mcp-server:${key.slice("mcp-server-v1:".length)}`),
      nativeKey: `native-${index}`,
      transport: "stdio",
      options: { schemaVersion: 1, auth: { kind: "none" } },
      projection: {
        schemaVersion: 1,
        componentId: ComponentIdSchema.parse(`component-v1:mcp-server:${key.slice("mcp-server-v1:".length)}`),
        contentRef: `plugin-content-v1:sha256:${"c".repeat(64)}`,
        dataRef: `plugin-data-v1:sha256:${"d".repeat(64)}`,
      },
      launchTemplate: {
        schemaVersion: 1,
        transport: "stdio",
        command: "safe-template",
        args: [],
        env: [],
      },
      toolAliases: [],
      provenance: [location],
    }])),
  });
}

function provider(
  counters: { resolved: number; disposed: number },
  values: McpLaunchValues = { transport: "stdio", command: "CANARY_COMMAND", args: [] },
  resolve?: McpLaunchValueProvider["resolve"],
): McpLaunchValueProvider {
  return {
    async resolve(request, signal) {
      counters.resolved += 1;
      return resolve === undefined ? values : resolve(request, signal);
    },
    async dispose() { counters.disposed += 1; },
  };
}

function request(
  sourceValue: ReturnType<typeof source>,
  launchValues: McpLaunchValueProvider,
  runtimeLeases = new FakeMcpRuntimeLeaseProvider(),
  expected: McpSourcePrecondition = { kind: "absent" },
) {
  return {
    registration: createMcpSourceRegistration({ source: sourceValue, sha256 }),
    expected,
    launchValues,
    runtimeLeases,
  };
}

describe("FakeMcpRuntime", () => {
  it("validates canonical registrations and registers locally without launch or lease effects", async () => {
    const counters = { resolved: 0, disposed: 0 };
    const runtimeLeases = new FakeMcpRuntimeLeaseProvider();
    const runtime = new FakeMcpRuntime();
    const current = source(identity());
    const replacement = request(current, provider(counters), runtimeLeases);
    const valid = await runtime.validateSource(replacement.registration, new AbortController().signal);
    expect(valid.ok).toBe(true);
    expect(await runtime.capabilities(new AbortController().signal)).toMatchObject({
      sourceLifecycle: expect.objectContaining({
        atomicReplace: true,
        lateLaunchValues: true,
        runtimeLeases: true,
      }),
    });
    expect((await runtime.replaceSource(replacement, new AbortController().signal)).kind).toBe("applied");
    expect(counters).toEqual({ resolved: 0, disposed: 0 });
    expect(runtimeLeases.activeCount).toBe(0);
  });

  it("rejects secret-bearing public registrations before storage without reflecting plaintext", async () => {
    const runtime = new FakeMcpRuntime();
    const counters = { resolved: 0, disposed: 0 };
    const current = identity();
    const validSource = source(current);
    const unsafe = JSON.parse(JSON.stringify(validSource)) as {
      servers: Record<string, {
        options: Record<string, unknown>;
        launchTemplate: unknown;
      }>;
    };
    const server = unsafe.servers[sharedKey]!;
    server.options = { ...server.options, secret: "CANARY_DURABLE_OPTION" };
    server.launchTemplate = {
      schemaVersion: 1,
      transport: "stdio",
      command: "safe-command",
      args: [],
      env: [{ name: "SESSION_ID", value: "CANARY_DURABLE_TEMPLATE" }],
    };
    const unsafeRegistration = {
      ...createMcpSourceRegistration({ source: validSource, sha256 }),
      source: unsafe,
    };

    const validation = await runtime.validateSource(
      unsafeRegistration as never,
      new AbortController().signal,
    );
    expect(validation.ok).toBe(false);
    const replacement = await runtime.replaceSource({
      ...request(validSource, provider(counters)),
      registration: unsafeRegistration as never,
    }, new AbortController().signal);
    expect(replacement.kind).toBe("rejected");
    const statuses = await runtime.inspectSources(new AbortController().signal);
    const output = JSON.stringify({ validation, replacement, statuses });
    expect(output).not.toMatch(/CANARY_DURABLE_/u);
    expect(statuses).toEqual([]);
    expect(counters).toEqual({ resolved: 0, disposed: 0 });
  });

  it("enforces absent and exact CAS while isolating equal native keys by scope and plugin", async () => {
    const runtime = new FakeMcpRuntime();
    const first = identity();
    const project = identity({ scope: { kind: "project", projectKey: `project-v1:sha256:${"f".repeat(64)}` } });
    const otherPlugin = identity({ plugin: PluginKeySchema.parse("other@community") });
    const signal = new AbortController().signal;
    for (const current of [first, project, otherPlugin]) {
      expect((await runtime.replaceSource(request(source(current), provider({ resolved: 0, disposed: 0 })), signal)).kind).toBe("applied");
    }
    expect((await runtime.inspectSources(signal)).map((status) => status.identity)).toEqual([project, first, otherPlugin]);

    const concurrent = identity({ revision: digest("3"), projectionDigest: digest("4") });
    expect(await runtime.replaceSource(request(source(concurrent), provider({ resolved: 0, disposed: 0 })), signal))
      .toMatchObject({ kind: "stale", currentIdentity: first });
    const stale = identity({ revision: digest("5"), projectionDigest: digest("6") });
    expect(await runtime.replaceSource(request(
      source(concurrent),
      provider({ resolved: 0, disposed: 0 }),
      new FakeMcpRuntimeLeaseProvider(),
      { kind: "exact", identity: stale },
    ), signal)).toMatchObject({ kind: "stale", currentIdentity: first });

    expect(await runtime.replaceSource(request(
      source(concurrent),
      provider({ resolved: 0, disposed: 0 }),
      new FakeMcpRuntimeLeaseProvider(),
      { kind: "exact", identity: first },
    ), signal)).toMatchObject({ kind: "applied", previousIdentity: first });
    expect(await runtime.removeSource(first, signal)).toMatchObject({ kind: "ownership-mismatch", currentIdentity: concurrent });
    expect(await runtime.inspectSource(project, signal)).toBeDefined();
    expect(await runtime.inspectSource(otherPlugin, signal)).toBeDefined();
  });

  it("holds runtime leases after plaintext disposal and cleans exact executions before replace/remove success", async () => {
    const runtime = new FakeMcpRuntime();
    const first = identity();
    const launch = { resolved: 0, disposed: 0 };
    const firstLeases = new FakeMcpRuntimeLeaseProvider();
    const signal = new AbortController().signal;
    await runtime.replaceSource(request(source(first), provider(launch), firstLeases), signal);
    const execution = await runtime.openExecution(first, sharedKey, signal);
    expect(launch).toEqual({ resolved: 1, disposed: 1 });
    expect(firstLeases.activeCount).toBe(1);
    expect(runtime.executionCount(first)).toBe(1);

    const next = identity({ revision: digest("3"), projectionDigest: digest("4") });
    await runtime.replaceSource(request(
      source(next),
      provider({ resolved: 0, disposed: 0 }),
      new FakeMcpRuntimeLeaseProvider(),
      { kind: "exact", identity: first },
    ), signal);
    expect(firstLeases.activeCount).toBe(0);
    expect(runtime.executionCount(first)).toBe(0);
    await execution.close();

    const nextLeases = new FakeMcpRuntimeLeaseProvider();
    const nextLaunch = { resolved: 0, disposed: 0 };
    const third = identity({ revision: digest("5"), projectionDigest: digest("6") });
    await runtime.replaceSource(request(
      source(third),
      provider(nextLaunch),
      nextLeases,
      { kind: "exact", identity: next },
    ), signal);
    await runtime.openExecution(third, sharedKey, signal);
    expect(await runtime.removeSource(third, signal)).toEqual({ kind: "removed" });
    expect(nextLeases.activeCount).toBe(0);
    expect(await runtime.removeSource(third, signal)).toEqual({ kind: "absent" });
  });

  it("does not claim cleanup when runtime lease release fails and lets exact replay finish", async () => {
    const runtime = new FakeMcpRuntime();
    const current = identity();
    const leases = new FakeMcpRuntimeLeaseProvider();
    const signal = new AbortController().signal;
    await runtime.replaceSource(request(source(current), provider({ resolved: 0, disposed: 0 }), leases), signal);
    await runtime.openExecution(current, sharedKey, signal);
    leases.failNextRelease();
    await expect(runtime.removeSource(current, signal)).rejects.toMatchObject({ code: "MCP_LAUNCH_CLEANUP_FAILED" });
    expect(runtime.executionCount(current)).toBe(1);
    expect(await runtime.removeSource(current, signal)).toEqual({ kind: "removed" });
    expect(leases.activeCount).toBe(0);
  });

  it("disposes plaintext and releases runtime leases on launch failure and cancellation", async () => {
    const runtime = new FakeMcpRuntime();
    const signal = new AbortController().signal;
    const failedIdentity = identity();
    const failedCounters = { resolved: 0, disposed: 0 };
    const failedLeases = new FakeMcpRuntimeLeaseProvider();
    await runtime.replaceSource(request(source(failedIdentity), provider(failedCounters, undefined, async () => {
      throw new Error("CANARY_CALLBACK_FAILURE");
    }), failedLeases), signal);
    const failure = await runtime.launch(failedIdentity, sharedKey, signal).catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain("CANARY_CALLBACK_FAILURE");
    expect(failedCounters).toEqual({ resolved: 1, disposed: 0 });
    expect(failedLeases.activeCount).toBe(0);

    const controller = new AbortController();
    const cancelledIdentity = identity({ revision: digest("3"), projectionDigest: digest("4") });
    const cancelledCounters = { resolved: 0, disposed: 0 };
    const cancelledLeases = new FakeMcpRuntimeLeaseProvider();
    await runtime.replaceSource(request(
      source(cancelledIdentity),
      provider(cancelledCounters, undefined, async () => {
        controller.abort(new Error("cancelled launch"));
        return { transport: "stdio", command: "CANARY_COMMAND", args: [] };
      }),
      cancelledLeases,
      { kind: "exact", identity: failedIdentity },
    ), signal);
    await expect(runtime.launch(cancelledIdentity, sharedKey, controller.signal)).rejects.toThrow("cancelled launch");
    expect(cancelledCounters).toEqual({ resolved: 1, disposed: 1 });
    expect(cancelledLeases.activeCount).toBe(0);
  });

  it("disposes before rejecting and keeps signal classification when cleanup also fails", async () => {
    const runtime = new FakeMcpRuntime();
    const current = identity({ revision: digest("e"), projectionDigest: digest("f") });
    const controller = new AbortController();
    const reason = { name: "TimeoutError", code: "TIMEOUT", message: "CANARY_TIMEOUT_SIGNAL" };
    const events: string[] = [];
    const launchValues: McpLaunchValueProvider = {
      async resolve() {
        events.push("resolved");
        controller.abort(reason);
        return { transport: "stdio", command: "safe-command", args: [] };
      },
      async dispose() {
        events.push("disposed");
        throw new Error("CANARY_CLEANUP_FAILURE");
      },
    };
    await runtime.replaceSource(
      request(source(current), launchValues),
      new AbortController().signal,
    );
    const failure = await runtime.launch(current, sharedKey, controller.signal)
      .catch((error: unknown) => {
        events.push("rejected");
        return error;
      });
    expect(failure).toBe(reason);
    expect(events).toEqual(["resolved", "disposed", "rejected"]);
    const status = await runtime.inspectSource(current, new AbortController().signal);
    expect(status?.servers[0]?.errorCode).toBe("MCP_LAUNCH_TIMEOUT");
    expect(JSON.stringify(status)).not.toMatch(/CANARY_(?:TIMEOUT_SIGNAL|CLEANUP_FAILURE)/u);
  });

  it("keeps inspection, lease tokens, and errors redacted and deterministically ordered", async () => {
    const runtime = new FakeMcpRuntime();
    const current = identity();
    const leases = new FakeMcpRuntimeLeaseProvider();
    const registrationRequest = request(
      source(current, [runtimeKey("f"), runtimeKey("1")]),
      provider({ resolved: 0, disposed: 0 }),
      leases,
    );
    await runtime.replaceSource(registrationRequest, new AbortController().signal);
    const inspected = await runtime.inspectSources(new AbortController().signal);
    expect(inspected[0]?.registrationDigest).toBe(registrationRequest.registration.digest);
    expect(inspected[0]?.servers.map((server) => server.key)).toEqual([runtimeKey("1"), runtimeKey("f")]);
    expect(JSON.stringify(inspected)).not.toMatch(/CANARY_SOURCE_DEFINITION|CANARY_TEMPLATE|CANARY_COMMAND/);
    expect(JSON.stringify(McpSourceStatusSchema.parse(inspected[0]))).not.toContain("secret");

    const execution = await runtime.openExecution(current, runtimeKey("1"), new AbortController().signal);
    expect(String(leases.acquired[0])).toBe("[REDACTED]");
    expect(JSON.stringify(leases.acquired[0])).toBe('"[REDACTED]"');
    await execution.close();
  });
});
