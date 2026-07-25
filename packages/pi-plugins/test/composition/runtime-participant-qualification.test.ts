import { describe, expect, it } from "vitest";
import { qualifyRuntimeParticipants } from "../../src/composition/runtime-participant-qualification.js";

const pi = { on() {}, sendMessage() {}, setSessionName() {} };
const lifecycle = {
  initialSourcesBeforeToolRegistration: true,
  isolatedFileDiscovery: true,
  localValidation: true,
  atomicReplace: true,
  exactRemove: true,
  inspect: true,
  cancellable: true,
  lateLaunchValues: true,
  runtimeLeases: true,
};

function mcp(provider: unknown) {
  return {
    async capabilities() {
      return {
        schemaVersion: 1,
        provider,
        sourceLifecycle: lifecycle,
        transports: { stdio: true, streamableHttp: true, legacySse: false, websocket: false },
        oauth: { authorizationCode: false, clientCredentials: false },
        features: { sampling: false, elicitationForm: false, elicitationUrl: false, toolApproval: true, resources: true, pluginToolAliases: true },
      };
    },
    async validateSource() { throw new Error("unused"); },
    async replaceSource() { throw new Error("unused"); },
    async removeSource() { throw new Error("unused"); },
    async inspectSource() { return undefined; },
    async inspectSources() { return []; },
  } as never;
}

async function decide(runtime: unknown, piVersion = "0.80.8") {
  return await qualifyRuntimeParticipants({
    pi: pi as never,
    nodeVersion: "24.0.0",
    piVersion,
    mcp: runtime as never,
    signal: new AbortController().signal,
  });
}

const publishedProvider = {
  kind: "published-package",
  packageName: "qualified-mcp-adapter",
  version: "2.0.0",
  integrity: "sha512-test",
  nodeEngine: ">=24 <25",
  piPeerRange: ">=0.79.1 <1",
  contractVersion: 1,
};

describe("runtime participant qualification", () => {
  it("does not qualify a mere MCP port or test-provider evidence", async () => {
    expect((await decide(mcp(undefined))).mcp.status).toBe("unavailable");
    expect((await decide(mcp({ kind: "test", name: "fake" }))).mcp.status).toBe("unavailable");
  });

  it("uses complete published-package and actual Node/Pi range evidence", async () => {
    const provider = publishedProvider;
    expect((await decide(mcp(provider))).mcp.status).toBe("available");
    expect((await decide(mcp({ ...provider, piPeerRange: ">=0.81.0" }))).mcp.status).toBe("unavailable");
    expect((await decide(mcp({ ...provider, nodeEngine: ">=25" }))).mcp.status).toBe("unavailable");
  });

  it("admits any pre-1.0 Pi at or above the API floor and rejects outside it", async () => {
    // The 0.81 regression: a minor-version cap used to fail host-API
    // qualification here and collapse every runtime capability to unavailable.
    expect((await decide(mcp(publishedProvider), "0.79.9")).hostApi.status).toBe("unavailable");
    expect((await decide(mcp(publishedProvider), "0.80.0")).hostApi.status).toBe("available");
    expect((await decide(mcp(publishedProvider), "0.81.1")).hostApi.status).toBe("available");
    expect((await decide(mcp(publishedProvider), "0.81.1")).mcp.status).toBe("available");
    expect((await decide(mcp(publishedProvider), "0.99.0")).hostApi.status).toBe("available");
    expect((await decide(mcp(publishedProvider), "0.99.0-beta.1")).hostApi.status).toBe("available");
    expect((await decide(mcp(publishedProvider), "1.0.0")).hostApi.status).toBe("unavailable");
    expect((await decide(mcp(publishedProvider), "1.0.0-beta.1")).hostApi.status).toBe("unavailable");
    expect((await decide(mcp(publishedProvider), "1.0.0-rc.1")).hostApi.status).toBe("unavailable");
  });

  it("still fails closed when the Pi API shape drifts even inside the range", async () => {
    const drifted = await qualifyRuntimeParticipants({
      pi: { on() {} } as never,
      nodeVersion: "24.0.0",
      piVersion: "0.81.1",
      mcp: mcp(publishedProvider) as never,
      signal: new AbortController().signal,
    });
    expect(drifted.hostApi.status).toBe("unavailable");
    expect(drifted.mcp.status).toBe("unavailable");
  });
});
