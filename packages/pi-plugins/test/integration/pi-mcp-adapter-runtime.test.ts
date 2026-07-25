import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION as PI_VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "@nklisch/pi-mcp-adapter/programmatic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qualifyRuntimeParticipants } from "../../src/composition/runtime-participant-qualification.js";
import { BoundaryError } from "../../src/domain/errors.js";
import { createPiMcpRuntime } from "../../src/runtime/mcp/pi-mcp-adapter-runtime.js";
import {
  fixtureMcpIdentity,
  fixtureMcpProviders,
  fixtureMcpRegistration,
  fixtureMcpReplacement,
  fixtureMcpServerKey,
} from "../support/pi-mcp-adapter-fixture.js";

const EXPECTED_PACKAGE = "@nklisch/pi-mcp-adapter";
const EXPECTED_VERSION = "2.11.0-nklisch.3";
const EXPECTED_INTEGRITY = "sha512-keVNCjw0ZldLr5p6TwB3UvM9dHc9SwhCHbSQQOvdR+nhMFRua2lHdAG3nMqmr9CK1torEd8e5PX3ZyptXXhmbQ==";
const EXPECTED_LICENSE_SHA256 = "2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c";
const fixtureServer = fileURLToPath(new URL("../fixtures/mcp/stdio-server.mjs", import.meta.url));
const roots: string[] = [];
let priorCwd: string | undefined;

afterEach(async () => {
  if (priorCwd !== undefined) {
    process.chdir(priorCwd);
    priorCwd = undefined;
  }
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Handler = (event: unknown, context: ExtensionContext) => unknown;
type RegisteredTool = Readonly<{
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Readonly<{
    content: readonly unknown[];
    details: unknown;
  }>>;
}>;

function fakePi(onRegister?: (tool: RegisteredTool) => void) {
  const handlers = new Map<string, Handler[]>();
  const tools: RegisteredTool[] = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
      onRegister?.(tool);
    },
    sendMessage() {},
    setSessionName() {},
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools };
}

async function dispatch(
  handlers: Map<string, Handler[]>,
  event: "session_start" | "session_shutdown",
  context: ExtensionContext,
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) {
    await handler({ type: event, reason: event === "session_start" ? "startup" : "quit" }, context);
  }
}

function context(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, mode: "print" } as ExtensionContext;
}

function stdioProviders(label: string, canary = "SECRET_CALLBACK_CANARY") {
  return fixtureMcpProviders({
    values: {
      transport: "stdio",
      command: process.execPath,
      args: [fixtureServer, label],
      env: { SOURCE_SECRET: canary },
    },
  });
}

async function call(
  tool: RegisteredTool,
  identity: ReturnType<typeof fixtureMcpIdentity>,
  signal = new AbortController().signal,
) {
  return tool.execute("call-1", {
    action: "call",
    source: JSON.stringify(identity),
    server: fixtureMcpServerKey,
    tool: "identity",
    args: "{}",
  }, signal);
}

function calledText(result: Awaited<ReturnType<typeof call>>): string | undefined {
  const details = result.details as { content?: Array<{ type?: string; text?: string }> };
  return details.content?.find((entry) => entry.type === "text")?.text;
}

async function inventory(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      entries.push(child.slice(root.length));
      if (entry.isDirectory()) await visit(child);
    }
  }
  await visit(root);
  return entries.sort();
}

describe("published Pi MCP adapter boundary", () => {
  it("pins registry identity/exports/license and stays side-effect-free before explicit extension registration", async () => {
    expect(PI_VERSION).toBe("0.80.8");
    const programmatic = fileURLToPath(import.meta.resolve(`${EXPECTED_PACKAGE}/programmatic`));
    const packageRoot = resolve(dirname(programmatic), "..");
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
    const locked = lock.packages[`node_modules/${EXPECTED_PACKAGE}`];
    const license = await readFile(join(packageRoot, "LICENSE"));

    expect(manifest).toMatchObject({
      name: EXPECTED_PACKAGE,
      version: EXPECTED_VERSION,
      license: "MIT",
      engines: { node: ">=22.19.0" },
      peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.79.1 <1" },
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./programmatic": { types: "./dist/programmatic.d.ts", import: "./dist/programmatic.js" },
      },
    });
    expect(locked).toMatchObject({ version: EXPECTED_VERSION, integrity: EXPECTED_INTEGRITY, license: "MIT" });
    expect(createHash("sha256").update(license).digest("hex")).toBe(EXPECTED_LICENSE_SHA256);
    expect(() => import.meta.resolve(`${EXPECTED_PACKAGE}/server-manager`)).toThrow(/not defined by "exports"/i);

    const root = await mkdtemp(join(tmpdir(), "pi-mcp-boundary-order-"));
    roots.push(root);
    const project = join(root, "project");
    const agent = join(root, "agent");
    const home = join(root, "home");
    const xdg = join(root, "xdg");
    await Promise.all([
      mkdir(join(project, ".pi"), { recursive: true }),
      mkdir(agent, { recursive: true }),
      mkdir(join(home, ".config", "mcp"), { recursive: true }),
      mkdir(join(xdg, "mcp"), { recursive: true }),
    ]);
    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { fileCanary: { command: "FILE_DISCOVERY_CANARY" } } }));
    await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ imports: ["IMPORT_DISCOVERY_CANARY"] }));
    await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { globalCanary: { command: "GLOBAL_DISCOVERY_CANARY" } } }));
    await writeFile(join(home, ".config", "mcp", "mcp.json"), JSON.stringify({ mcpServers: { homeCanary: { command: "HOME_DISCOVERY_CANARY" } } }));
    await writeFile(join(xdg, "mcp", "mcp.json"), JSON.stringify({ mcpServers: { xdgCanary: { command: "XDG_DISCOVERY_CANARY" } } }));
    priorCwd = process.cwd();
    process.chdir(project);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    const before = await inventory(root);
    const argvBefore = [...process.argv];
    const environmentBefore = {
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    const providers = stdioProviders("initial");
    const registration = fixtureMcpRegistration();
    const candidate = createPiMcpRuntime({
      packageFactory: createMcpAdapter,
      initialSources: [{ registration, ...providers }],
      fileDiscovery: "disabled",
    });
    expect(providers.counters).toEqual({ resolved: 0, disposed: 0, acquired: 0, released: 0, drained: 0 });
    expect((await candidate.runtime.validateSource(registration, new AbortController().signal)).ok).toBe(true);
    expect(await inventory(root)).toEqual(before);

    let registrationObservation: Promise<unknown> | undefined;
    const pi = fakePi(() => {
      registrationObservation = candidate.runtime.inspectSources(new AbortController().signal);
    });
    candidate.extension(pi.pi);
    expect(await registrationObservation).toEqual([expect.objectContaining({ identity: registration.source.identity })]);
    expect(pi.tools.map((tool) => tool.name)).toEqual(["mcp"]);
    expect(await inventory(root)).toEqual(before);
    expect(process.argv).toEqual(argvBefore);
    expect({
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    }).toEqual(environmentBefore);
    expect(providers.counters).toEqual({ resolved: 0, disposed: 0, acquired: 0, released: 0, drained: 0 });

    const capabilities = await candidate.runtime.capabilities(new AbortController().signal);
    expect(capabilities.provider).toEqual({
      kind: "published-package",
      packageName: EXPECTED_PACKAGE,
      version: EXPECTED_VERSION,
      integrity: EXPECTED_INTEGRITY,
      nodeEngine: ">=22.19.0",
      piPeerRange: ">=0.79.1 <1",
      contractVersion: 1,
    });
    expect(Object.values(capabilities.sourceLifecycle).every(Boolean)).toBe(true);
    const qualified = await qualifyRuntimeParticipants({
      pi: pi.pi,
      nodeVersion: process.versions.node,
      piVersion: PI_VERSION,
      mcp: candidate.runtime,
      signal: new AbortController().signal,
    });
    expect(qualified.mcp).toMatchObject({ status: "available", runtime: expect.any(Object) });
    const drifted = await qualifyRuntimeParticipants({
      pi: pi.pi,
      nodeVersion: process.versions.node,
      piVersion: PI_VERSION,
      mcp: {
        ...candidate.runtime,
        capabilities: async (signal) => ({
          ...await candidate.runtime.capabilities(signal),
          sourceLifecycle: { ...capabilities.sourceLifecycle, atomicReplace: false },
        }),
      },
      signal: new AbortController().signal,
    });
    expect(drifted.mcp.status).toBe("unavailable");

    const canary = "INVALID_INITIAL_SOURCE_CANARY";
    let failure: unknown;
    try {
      createPiMcpRuntime({
        packageFactory: createMcpAdapter,
        initialSources: [{
          registration: { schemaVersion: 1, source: { schemaVersion: 1, identity: { plugin: canary }, servers: {} }, digest: canary },
          ...providers,
        } as never],
        fileDiscovery: "disabled",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BoundaryError);
    expect(failure).toMatchObject({ code: "ADAPTER_FAILED", operation: "createPiMcpRuntime" });
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  it("isolates colliding sources through real Pi 0.80.8 tool/process/status replacement and removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-concrete-lifecycle-"));
    roots.push(root);
    const alphaIdentity = fixtureMcpIdentity("1");
    const betaIdentity = fixtureMcpIdentity("2");
    const alpha = fixtureMcpRegistration({ identity: alphaIdentity, nativeKey: "shared" });
    const beta = fixtureMcpRegistration({ identity: betaIdentity, nativeKey: "shared" });
    const alphaProviders = stdioProviders("alpha");
    const betaProviders = stdioProviders("beta");
    const candidate = createPiMcpRuntime({
      packageFactory: createMcpAdapter,
      initialSources: [
        { registration: alpha, ...alphaProviders },
        { registration: beta, ...betaProviders },
      ],
      fileDiscovery: "disabled",
    });
    const pi = fakePi();
    candidate.extension(pi.pi);
    const session = context(root);
    await dispatch(pi.handlers, "session_start", session);
    const tool = pi.tools[0]!;

    expect(calledText(await call(tool, alphaIdentity))).toBe("alpha");
    expect(calledText(await call(tool, betaIdentity))).toBe("beta");
    expect(alphaProviders.counters).toMatchObject({ resolved: 1, disposed: 1, acquired: 1, released: 1 });
    expect(betaProviders.counters).toMatchObject({ resolved: 1, disposed: 1, acquired: 1, released: 1 });
    const firstStatus = await candidate.runtime.inspectSources(new AbortController().signal);
    expect(firstStatus).toHaveLength(2);
    expect(JSON.stringify(firstStatus)).not.toMatch(/SECRET_CALLBACK_CANARY|late-command-template|SOURCE_SECRET/);
    expect(firstStatus.every((status) => status.servers[0]?.state === "connected")).toBe(true);

    const alphaNextIdentity = fixtureMcpIdentity("3", {
      plugin: alphaIdentity.plugin,
      scope: alphaIdentity.scope,
    });
    const alphaNext = fixtureMcpRegistration({ identity: alphaNextIdentity, nativeKey: "shared" });
    const alphaNextProviders = stdioProviders("alpha-next", "REPLACEMENT_SECRET_CANARY");
    const replaced = await candidate.runtime.replaceSource(
      fixtureMcpReplacement(alphaNext, alphaNextProviders, { kind: "exact", identity: alphaIdentity }),
      new AbortController().signal,
    );
    expect(replaced).toMatchObject({ kind: "applied", previousIdentity: alphaIdentity });
    expect(await candidate.runtime.inspectSource(alphaIdentity, new AbortController().signal)).toBeUndefined();
    expect(calledText(await call(tool, alphaNextIdentity))).toBe("alpha-next");
    expect(alphaProviders.counters.drained).toBeGreaterThan(0);

    expect(await candidate.runtime.removeSource(betaIdentity, new AbortController().signal)).toEqual({ kind: "removed" });
    expect(await candidate.runtime.removeSource(betaIdentity, new AbortController().signal)).toEqual({ kind: "absent" });
    expect(calledText(await call(tool, alphaNextIdentity))).toBe("alpha-next");
    const removedCall = await call(tool, betaIdentity);
    expect(removedCall.details).toEqual({ error: "SOURCE_INVALID" });
    const remaining = await candidate.runtime.inspectSources(new AbortController().signal);
    expect(remaining.map((status) => status.identity)).toEqual([alphaNextIdentity]);
    expect(JSON.stringify(remaining)).not.toMatch(/REPLACEMENT_SECRET_CANARY|alpha-next|SOURCE_SECRET/);

    await dispatch(pi.handlers, "session_shutdown", session);
    expect(alphaNextProviders.counters.drained).toBeGreaterThan(0);
  });

  it("keeps local registration offline, rolls failed cleanup back, propagates cancellation, and never retains late values", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-concrete-failure-"));
    roots.push(root);
    const identity = fixtureMcpIdentity("4");
    const registration = fixtureMcpRegistration({ identity });
    let rejectFirstDrain = true;
    const previousProviders = fixtureMcpProviders({
      values: { transport: "stdio", command: process.execPath, args: [fixtureServer, "previous"] },
      drain: async () => {
        if (rejectFirstDrain) {
          rejectFirstDrain = false;
          throw new Error("DRAIN_NATIVE_SECRET_CANARY");
        }
      },
    });
    const candidate = createPiMcpRuntime({
      packageFactory: createMcpAdapter,
      initialSources: [{ registration, ...previousProviders }],
      fileDiscovery: "disabled",
    });

    const nextIdentity = fixtureMcpIdentity("5", { plugin: identity.plugin, scope: identity.scope });
    const next = fixtureMcpRegistration({ identity: nextIdentity });
    const rejected = await candidate.runtime.replaceSource(
      fixtureMcpReplacement(next, stdioProviders("next"), { kind: "exact", identity }),
      new AbortController().signal,
    );
    expect(rejected).toMatchObject({ kind: "rejected" });
    expect(await candidate.runtime.inspectSource(identity, new AbortController().signal)).toBeDefined();
    expect(await candidate.runtime.inspectSource(nextIdentity, new AbortController().signal)).toBeUndefined();
    expect(JSON.stringify(rejected)).not.toContain("DRAIN_NATIVE_SECRET_CANARY");

    const offlineIdentity = fixtureMcpIdentity("6");
    const offline = fixtureMcpRegistration({ identity: offlineIdentity, transport: "streamable-http" });
    const offlineProviders = fixtureMcpProviders({
      values: { transport: "streamable-http", url: "http://127.0.0.1:1/unreachable", bearerToken: "OFFLINE_SECRET_CANARY" },
    });
    expect(await candidate.runtime.replaceSource(
      fixtureMcpReplacement(offline, offlineProviders),
      new AbortController().signal,
    )).toMatchObject({ kind: "applied" });
    expect(offlineProviders.counters).toEqual({ resolved: 0, disposed: 0, acquired: 0, released: 0, drained: 0 });

    const cancelController = new AbortController();
    const cancelReason = new Error("caller cancellation reason");
    const cancelIdentity = fixtureMcpIdentity("7");
    const cancelRegistration = fixtureMcpRegistration({ identity: cancelIdentity });
    const cancelProviders = fixtureMcpProviders({
      async resolve() {
        cancelController.abort(cancelReason);
        return {
          transport: "stdio",
          command: process.execPath,
          args: [fixtureServer, "CANCEL_VALUE_CANARY"],
          env: { TOKEN: "CANCEL_SECRET_CANARY" },
        };
      },
    });
    expect(await candidate.runtime.replaceSource(
      fixtureMcpReplacement(cancelRegistration, cancelProviders),
      new AbortController().signal,
    )).toMatchObject({ kind: "applied" });
    const pi = fakePi();
    candidate.extension(pi.pi);
    const session = context(root);
    await dispatch(pi.handlers, "session_start", session);
    const cancelled = await call(pi.tools[0]!, cancelIdentity, cancelController.signal);
    expect(cancelled.details).toEqual({ error: "MCP_LAUNCH_CANCELLED" });
    expect(cancelProviders.counters).toMatchObject({ resolved: 1, disposed: 1, acquired: 1, released: 1 });
    const status = await candidate.runtime.inspectSource(cancelIdentity, new AbortController().signal);
    expect(JSON.stringify({ cancelled, status })).not.toMatch(/CANCEL_VALUE_CANARY|CANCEL_SECRET_CANARY|caller cancellation reason/);

    const preAborted = new AbortController();
    preAborted.abort(cancelReason);
    await expect(candidate.runtime.inspectSources(preAborted.signal)).rejects.toBe(cancelReason);
    await dispatch(pi.handlers, "session_shutdown", session);
  });
});
