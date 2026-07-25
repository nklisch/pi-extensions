import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpConfigSource,
  McpLaunchValueProvider,
  McpRuntimeLease,
  McpRuntimeLeaseProvider,
  McpSourceIdentity,
  McpSourceRegistration,
} from "../programmatic-types.ts";

const managerMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  closeAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: class {
    setSamplingConfig() {}
    setElicitationConfig() {}
    getConnection() { return undefined; }
    connect(...args: unknown[]) { return managerMocks.connect(...args); }
    close(...args: unknown[]) { return managerMocks.close(...args); }
    closeAll(...args: unknown[]) { return managerMocks.closeAll(...args); }
  },
}));

import { ProgrammaticMcpRuntime } from "../programmatic-runtime.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

const digest = (token: string) => `sha256:${token.repeat(64).slice(0, 64)}`;
const serverKey = (token: string) => `mcp-server-v1:${token.repeat(64).slice(0, 64)}`;

function identity(token: string, plugin = `plugin-${token}@community`): McpSourceIdentity {
  return {
    schemaVersion: 1,
    scope: { kind: "user" },
    plugin,
    revision: digest(token),
    projectionDigest: digest(`${token}0`),
  };
}

function registration(sourceIdentity: McpSourceIdentity, key = serverKey("a")): McpSourceRegistration {
  const source: McpConfigSource = {
    schemaVersion: 1,
    identity: sourceIdentity,
    servers: {
      [key]: {
        componentId: `component-v1:mcp-server:${key.slice("mcp-server-v1:".length)}`,
        nativeKey: "shared",
        transport: "stdio",
        options: { schemaVersion: 1, auth: { kind: "none" }, toolTimeoutMs: 500 },
        projection: { schemaVersion: 1, componentId: `component-v1:mcp-server:${key.slice("mcp-server-v1:".length)}` },
        launchTemplate: {
          schemaVersion: 1,
          transport: "stdio",
          command: "secret-free-template",
          args: [],
          env: [],
        },
        toolAliases: [],
        provenance: [{ host: "claude", documentKind: "mcp", path: "plugin.mcp.json" }],
      },
    },
  };
  const hash = createHash("sha256")
    .update(`mcp-source-registration-v1\0${canonical(source)}`)
    .digest("hex");
  return { schemaVersion: 1, source, digest: `sha256:${hash}` };
}

function providers(options: {
  values?: Awaited<ReturnType<McpLaunchValueProvider["resolve"]>>;
  abort?: AbortController;
  failDrain?: boolean;
} = {}) {
  const counters = { resolved: 0, disposed: 0, acquired: 0, released: 0, drained: 0 };
  const active = new WeakSet<object>();
  const launchValues: McpLaunchValueProvider = {
    async resolve() {
      counters.resolved += 1;
      options.abort?.abort(new Error("cancelled at launch"));
      return options.values ?? {
        transport: "stdio",
        command: "CANARY_COMMAND",
        args: ["CANARY_ARG"],
        env: { TOKEN: "CANARY_SECRET" },
      };
    },
    async dispose() { counters.disposed += 1; },
  };
  const runtimeLeases: McpRuntimeLeaseProvider = {
    async acquire() {
      counters.acquired += 1;
      const lease = Object.freeze({}) as McpRuntimeLease;
      active.add(lease);
      return lease;
    },
    async release(lease) {
      if (!active.has(lease)) throw new Error("lease ownership mismatch");
      active.delete(lease);
      counters.released += 1;
    },
    async drain() {
      counters.drained += 1;
      if (options.failDrain) throw new Error("drain failed");
    },
  };
  return { counters, launchValues, runtimeLeases };
}

function runtime() {
  return new ProgrammaticMcpRuntime({ fileDiscovery: "disabled" });
}

beforeEach(() => {
  managerMocks.connect.mockReset();
  managerMocks.connect.mockResolvedValue({
    status: "connected",
    tools: [{ name: "echo", description: "Echo" }],
    resources: [],
    client: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      readResource: vi.fn(),
    },
  });
  managerMocks.close.mockClear();
  managerMocks.closeAll.mockClear();
});

describe("programmatic source lifecycle", () => {
  it("searches tool names and descriptions across source servers and tolerates unstartable servers", async () => {
    const subject = runtime();
    const sourceIdentity = identity("c");
    subject.installInitialSources([{ registration: registration(sourceIdentity), ...providers() }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);
    managerMocks.connect.mockResolvedValue({
      status: "connected",
      tools: [
        { name: "zai_web_search", description: "Search the web via Z.ai" },
        { name: "read_repo_file", description: "Read one file" },
      ],
      resources: [],
      client: { callTool: vi.fn(), readResource: vi.fn() },
    });
    const signal = new AbortController().signal;

    const byName = await subject.searchTools(sourceIdentity, "web_search", {}, signal);
    expect(byName.matches.map((match) => match.name)).toEqual(["zai_web_search"]);
    expect(byName.matches[0]?.server).toBe(serverKey("a"));
    expect(byName.unavailableServers).toEqual([]);

    const byDescription = await subject.searchTools(sourceIdentity, "one file", {}, signal);
    expect(byDescription.matches.map((match) => match.name)).toEqual(["read_repo_file"]);

    const byRegex = await subject.searchTools(sourceIdentity, "^zai_.*", { regex: true }, signal);
    expect(byRegex.matches.map((match) => match.name)).toEqual(["zai_web_search"]);

    const none = await subject.searchTools(sourceIdentity, "zzzz", {}, signal);
    expect(none.matches).toEqual([]);

    managerMocks.connect.mockRejectedValue(new Error("spawn failed"));
    const degraded = await subject.searchTools(sourceIdentity, "search", {}, signal);
    expect(degraded.matches).toEqual([]);
    expect(degraded.unavailableServers).toEqual([serverKey("a")]);

    managerMocks.connect.mockResolvedValue({ status: "connected", tools: [], resources: [], client: { callTool: vi.fn(), readResource: vi.fn() } });
    await expect(subject.searchTools(sourceIdentity, "", {}, signal)).rejects.toMatchObject({ code: "SEARCH_INVALID" });
    await expect(subject.searchTools(sourceIdentity, "[", { regex: true }, signal)).rejects.toMatchObject({ code: "SEARCH_INVALID" });
    await expect(subject.searchTools(sourceIdentity, "x".repeat(300), {}, signal)).rejects.toMatchObject({ code: "SEARCH_INVALID" });

    // Server keys alone are exact: no identity JSON needed to list or call.
    const tools = await subject.listTools(undefined, serverKey("a"), signal);
    expect(tools.map((tool) => tool.name)).toEqual([]);
    managerMocks.connect.mockResolvedValue({
      status: "connected",
      tools: [{ name: "echo", description: "Echo" }],
      resources: [],
      client: { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }), readResource: vi.fn() },
    });
    const called = await subject.callTool(undefined, serverKey("a"), "echo", {}, signal);
    expect(called).toMatchObject({ content: [{ type: "text", text: "ok" }] });
    await expect(subject.listTools(undefined, "mcp-server-v1:missing", signal)).rejects.toMatchObject({ code: "SOURCE_INVALID" });
  });

  it("installs initial sources synchronously and keeps colliding native keys isolated", async () => {
    const subject = runtime();
    const first = providers();
    const second = providers();
    const firstRegistration = registration(identity("1"));
    const secondRegistration = registration(identity("2"));
    subject.installInitialSources([
      { registration: firstRegistration, ...first },
      { registration: secondRegistration, ...second },
    ]);

    const statuses = await subject.inspectSources(new AbortController().signal);
    expect(statuses).toHaveLength(2);
    expect(statuses.every((status) => status.servers[0]?.nativeKey === "shared")).toBe(true);
    expect(new Set(statuses.map((status) => status.identity.plugin)).size).toBe(2);
    expect(first.counters.resolved).toBe(0);
    expect(second.counters.resolved).toBe(0);
  });

  it("uses exact compare-and-replace and preserves the old source when cleanup rejects", async () => {
    const subject = runtime();
    const oldProviders = providers({ failDrain: true });
    const oldIdentity = identity("1", "same@community");
    const oldRegistration = registration(oldIdentity);
    subject.installInitialSources([{ registration: oldRegistration, ...oldProviders }]);

    const nextIdentity = identity("2", "same@community");
    const nextProviders = providers();
    const rejected = await subject.replaceSource({
      registration: registration(nextIdentity),
      expected: { kind: "exact", identity: oldIdentity },
      ...nextProviders,
    }, new AbortController().signal);

    expect(rejected.kind).toBe("rejected");
    expect(await subject.inspectSource(oldIdentity, new AbortController().signal)).toBeDefined();
    expect(await subject.inspectSource(nextIdentity, new AbortController().signal)).toBeUndefined();
  });

  it("removes only the exact current identity", async () => {
    const subject = runtime();
    const current = identity("1", "same@community");
    const stale = identity("2", "same@community");
    subject.installInitialSources([{ registration: registration(current), ...providers() }]);

    expect(await subject.removeSource(stale, new AbortController().signal)).toEqual({
      kind: "ownership-mismatch",
      requestedIdentity: stale,
      currentIdentity: current,
    });
    expect(await subject.inspectSource(current, new AbortController().signal)).toBeDefined();
    expect(await subject.removeSource(current, new AbortController().signal)).toEqual({ kind: "removed" });
    expect(await subject.removeSource(current, new AbortController().signal)).toEqual({ kind: "absent" });
  });

  it("resolves launch values only at connect, disposes them, and never retains them in inspection", async () => {
    const subject = runtime();
    const sourceIdentity = identity("1");
    const sourceProviders = providers();
    subject.installInitialSources([{ registration: registration(sourceIdentity), ...sourceProviders }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);

    const execution = await subject.openExecution(
      sourceIdentity,
      serverKey("a"),
      new AbortController().signal,
    );
    expect(sourceProviders.counters).toMatchObject({ resolved: 1, disposed: 1, acquired: 1, released: 0 });
    expect(managerMocks.connect).toHaveBeenCalledWith(
      expect.stringMatching(/^programmatic:[0-9a-f]{64}$/),
      expect.objectContaining({ command: "CANARY_COMMAND", env: { TOKEN: "CANARY_SECRET" } }),
      expect.any(AbortSignal),
      expect.objectContaining({
        allowLegacySseFallback: false,
        values: "resolved",
        retainedDefinition: expect.not.objectContaining({ command: "CANARY_COMMAND" }),
      }),
    );
    const statusJson = JSON.stringify(await subject.inspectSources(new AbortController().signal));
    expect(statusJson).not.toMatch(/CANARY_COMMAND|CANARY_ARG|CANARY_SECRET|secret-free-template/);

    await execution.close();
    expect(sourceProviders.counters.released).toBe(1);
  });

  it("redacts provider failures from errors and status", async () => {
    const subject = runtime();
    const sourceIdentity = identity("1");
    const sourceProviders = providers();
    sourceProviders.launchValues.resolve = async () => {
      throw new Error("CANARY_NATIVE_CAUSE");
    };
    subject.installInitialSources([{ registration: registration(sourceIdentity), ...sourceProviders }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);

    await expect(subject.openExecution(sourceIdentity, serverKey("a"), new AbortController().signal))
      .rejects.toThrow("MCP programmatic runtime operation failed");
    const status = JSON.stringify(await subject.inspectSources(new AbortController().signal));
    expect(status).not.toContain("CANARY_NATIVE_CAUSE");
    expect(status).toContain("ADAPTER_FAILED");
    expect(sourceProviders.counters).toMatchObject({ acquired: 1, released: 1, disposed: 0 });
  });

  it("disposes values and releases authority when cancellation happens after resolve", async () => {
    const subject = runtime();
    const controller = new AbortController();
    const sourceIdentity = identity("1");
    const sourceProviders = providers({ abort: controller });
    subject.installInitialSources([{ registration: registration(sourceIdentity), ...sourceProviders }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);

    await expect(subject.openExecution(sourceIdentity, serverKey("a"), controller.signal))
      .rejects.toThrow("cancelled at launch");
    expect(sourceProviders.counters).toMatchObject({ resolved: 1, disposed: 1, acquired: 1, released: 1 });
    expect(managerMocks.connect).not.toHaveBeenCalled();
  });

  it("releases a cancelled queue slot without deadlocking later lifecycle work", async () => {
    const subject = runtime();
    const oldIdentity = identity("1", "same@community");
    const oldProviders = providers();
    let startDrain!: () => void;
    const drainStarted = new Promise<void>((resolve) => { startDrain = resolve; });
    let unblockDrain!: () => void;
    const drainBlocked = new Promise<void>((resolve) => { unblockDrain = resolve; });
    oldProviders.runtimeLeases.drain = async () => {
      startDrain();
      await drainBlocked;
    };
    subject.installInitialSources([{ registration: registration(oldIdentity), ...oldProviders }]);

    const nextIdentity = identity("2", "same@community");
    const nextProviders = providers();
    const first = subject.replaceSource({
      registration: registration(nextIdentity),
      expected: { kind: "exact", identity: oldIdentity },
      ...nextProviders,
    }, new AbortController().signal);
    await drainStarted;

    const queuedController = new AbortController();
    const queued = subject.removeSource(nextIdentity, queuedController.signal);
    const reason = new Error("cancelled while queued");
    queuedController.abort(reason);
    await expect(queued).rejects.toBe(reason);

    unblockDrain();
    expect((await first).kind).toBe("applied");
    await expect(subject.removeSource(nextIdentity, new AbortController().signal))
      .resolves.toEqual({ kind: "removed" });
  });

  it("reports complete explicit capabilities and honors pre-aborted operations", async () => {
    const subject = runtime();
    const signal = new AbortController().signal;
    const capabilities = await subject.capabilities(signal);
    expect(Object.values(capabilities.sourceLifecycle).every((value) => typeof value === "boolean")).toBe(true);
    expect(Object.values(capabilities.transports).every((value) => typeof value === "boolean")).toBe(true);
    expect(Object.values(capabilities.oauth).every((value) => typeof value === "boolean")).toBe(true);
    expect(Object.values(capabilities.features).every((value) => typeof value === "boolean")).toBe(true);
    expect(capabilities.transports).toEqual({
      stdio: true,
      streamableHttp: true,
      legacySse: false,
      websocket: false,
    });

    const controller = new AbortController();
    const reason = new Error("pre-aborted");
    controller.abort(reason);
    await expect(subject.inspectSources(controller.signal)).rejects.toBe(reason);
  });
});
