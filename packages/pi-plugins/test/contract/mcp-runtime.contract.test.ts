import { describe, expect, it } from "vitest";
import {
  assertMcpRuntimeContract,
  type McpRuntimeContractHarness as Harness,
} from "./mcp-runtime.contract.js";
import {
  McpLaunchValueRequestSchema,
  McpSourceStatusSchema,
  type McpRuntimePort,
} from "../../src/application/ports/mcp-runtime.js";
import { FakeMcpRuntime } from "../support/fakes/mcp-runtime.js";

function delegated(
  base: FakeMcpRuntime,
  overrides: Partial<McpRuntimePort> = {},
): McpRuntimePort {
  return {
    capabilities: (signal) => base.capabilities(signal),
    validateSource: (source, signal) => base.validateSource(source, signal),
    replaceSource: (request, signal) => base.replaceSource(request, signal),
    removeSource: (identity, signal) => base.removeSource(identity, signal),
    inspectSource: (identity, signal) => base.inspectSource(identity, signal),
    inspectSources: (signal) => base.inspectSources(signal),
    ...overrides,
  };
}

function baseHarness(runtime: McpRuntimePort, fake: FakeMcpRuntime): Harness {
  return {
    runtime,
    launch: (identity, serverKey, signal, consume) => fake.launch(identity, serverKey, signal, consume),
    openExecution: (identity, serverKey, signal) => fake.openExecution(identity, serverKey, signal),
    failNextReplacement: () => fake.failNextReplacement(),
  };
}

describe("MCP runtime conformance suite negative evidence", () => {
  it("catches a replacement that deletes the current source before validation/publication", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      replaceSource: async (request, signal) => {
        const current = (await fake.inspectSources(signal))[0];
        if (current !== undefined) await fake.removeSource(current.identity, signal);
        return fake.replaceSource(request, signal);
      },
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches removal authorized by a global current name instead of exact identity", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      removeSource: async (identity, signal) => {
        const current = (await fake.inspectSources(signal))[0];
        return fake.removeSource(current?.identity ?? identity, signal);
      },
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches provider resolution before the runtime launch boundary", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      replaceSource: async (request, signal) => {
        const serverKey = Object.keys(request.registration.source.servers)[0]!;
        const server = request.registration.source.servers[serverKey]!;
        const values = await request.launchValues.resolve(
          McpLaunchValueRequestSchema.parse({
            schemaVersion: 1,
            source: request.registration.source.identity,
            serverKey,
            componentId: server.componentId,
            transport: server.transport,
          }),
          signal,
        );
        await request.launchValues.dispose(values);
        return fake.replaceSource(request, signal);
      },
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches a runtime that skips launch-value disposal", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      replaceSource: (request, signal) => fake.replaceSource({
        ...request,
        launchValues: {
          resolve: (valueRequest, valueSignal) => request.launchValues.resolve(valueRequest, valueSignal),
          dispose: () => undefined,
        },
      }, signal),
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches a runtime that caches and reuses one resolved values object", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      replaceSource: (request, signal) => {
        let retained: Awaited<ReturnType<typeof request.launchValues.resolve>> | undefined;
        return fake.replaceSource({
          ...request,
          launchValues: {
            async resolve(valueRequest, valueSignal) {
              retained ??= await request.launchValues.resolve(valueRequest, valueSignal);
              return retained;
            },
            dispose: () => undefined,
          },
        }, signal);
      },
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches a runtime that runs provider disposal effects twice", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      replaceSource: (request, signal) => fake.replaceSource({
        ...request,
        launchValues: {
          resolve: (valueRequest, valueSignal) => request.launchValues.resolve(valueRequest, valueSignal),
          async dispose(values) {
            await request.launchValues.dispose(values);
            await request.launchValues.dispose(values);
          },
        },
      }, signal),
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches a runtime that releases execution leases before the execution closes", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      replaceSource: (request, signal) => fake.replaceSource({
        ...request,
        runtimeLeases: {
          async acquire(binding, leaseSignal) {
            const lease = await request.runtimeLeases.acquire(binding, leaseSignal);
            await request.runtimeLeases.release(lease, leaseSignal);
            return lease;
          },
          release: (lease, leaseSignal) => request.runtimeLeases.release(lease, leaseSignal),
          drain: (leaseSignal) => request.runtimeLeases.drain(leaseSignal),
        },
      }, signal),
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches a runtime that skips execution-lease release", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      replaceSource: (request, signal) => fake.replaceSource({
        ...request,
        runtimeLeases: {
          acquire: (binding, leaseSignal) => request.runtimeLeases.acquire(binding, leaseSignal),
          release: async () => undefined,
          drain: (leaseSignal) => request.runtimeLeases.drain(leaseSignal),
        },
      }, signal),
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches a runtime that applies execution-lease release twice", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      replaceSource: (request, signal) => fake.replaceSource({
        ...request,
        runtimeLeases: {
          acquire: (binding, leaseSignal) => request.runtimeLeases.acquire(binding, leaseSignal),
          async release(lease, leaseSignal) {
            await request.runtimeLeases.release(lease, leaseSignal);
            await request.runtimeLeases.release(lease, leaseSignal);
          },
          drain: (leaseSignal) => request.runtimeLeases.drain(leaseSignal),
        },
      }, signal),
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });

  it("catches unsafe source-qualified inspection", async () => {
    const fake = new FakeMcpRuntime();
    const runtime = delegated(fake, {
      inspectSource: async (identity, signal) => {
        const status = await fake.inspectSource(identity, signal);
        if (status === undefined) return undefined;
        return McpSourceStatusSchema.parse({
          ...status,
          servers: status.servers.map((server) => ({
            ...server,
            provenance: [{ ...server.provenance[0]!, path: "CANARY_STATUS_VALUE" }],
          })),
        });
      },
    });
    await expect(assertMcpRuntimeContract(baseHarness(runtime, fake))).rejects.toThrow();
  });
});
