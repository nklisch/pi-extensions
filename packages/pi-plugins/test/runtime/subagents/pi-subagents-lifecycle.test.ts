import { createJiti } from "jiti/static";
import { describe, expect, it, vi } from "vitest";
import type {
  SubagentLifecycleInterceptor as NativeInterceptor,
  SubagentsService,
} from "@nklisch/pi-subagents";
import {
  createPiSubagentsLifecyclePort,
  createPublishedPiSubagentsLifecyclePort,
} from "../../../src/runtime/subagents/pi-subagents-lifecycle.js";
import { BoundaryError } from "../../../src/domain/errors.js";

const nativeIdentity = Object.freeze({
  agentId: "agent-1",
  sessionId: "child-1",
  runId: "run-1",
  agentType: "implementor",
  parentSessionId: "parent-1",
});
const nativeExecution = Object.freeze({
  phase: "initial" as const,
  origin: "tool" as const,
  mode: "foreground" as const,
  admission: "immediate" as const,
});

function nativeServiceFixture() {
  const interceptors: NativeInterceptor[] = [];
  const dispose = vi.fn(async () => undefined);
  const service = {
    registerLifecycleInterceptor: vi.fn((interceptor: NativeInterceptor) => {
      interceptors.push(interceptor);
      return { dispose };
    }),
  } as unknown as SubagentsService;
  return { service, interceptors, dispose };
}

function startContext(signal = new AbortController().signal) {
  return {
    identity: nativeIdentity,
    execution: nativeExecution,
    prompt: "EXACT_PROMPT_SECRET_CANARY",
    signal,
  };
}

function completionContext(signal = new AbortController().signal) {
  return {
    identity: nativeIdentity,
    execution: nativeExecution,
    proposedResult: "PROPOSED_RESULT_SECRET_CANARY",
    outcome: "completed" as const,
    continuationRound: 0,
    maxContinuationRounds: 3,
    signal,
  };
}

async function register(
  port: ReturnType<typeof createPiSubagentsLifecyclePort>,
  interceptor: Parameters<ReturnType<typeof createPiSubagentsLifecyclePort>["register"]>[0]["interceptor"],
) {
  const signal = new AbortController().signal;
  const qualification = await port.capabilities(signal);
  return port.register({
    interceptor,
    expectedQualificationDigest: qualification.qualificationDigest,
    maxContinuationRounds: 3,
  }, signal);
}

describe("published pi-subagents lifecycle adapter", () => {
  it("loads the documented root export through the packaged TypeScript loader", async () => {
    const fixture = nativeServiceFixture();
    const published = await createJiti(import.meta.url).import("@nklisch/pi-subagents") as {
      publishSubagentsService(service: SubagentsService): void;
      unpublishSubagentsService(): void;
    };
    published.publishSubagentsService(fixture.service);
    try {
      const port = await createPublishedPiSubagentsLifecyclePort();
      expect(port).toBeDefined();
      await expect(port!.capabilities(new AbortController().signal)).resolves.toMatchObject({
        provider: { packageName: "@nklisch/pi-subagents", version: "18.0.4-nklisch.0" },
      });
    } finally {
      published.unpublishSubagentsService();
    }
  });

  it("reports the pinned published-package receipt without package internals", async () => {
    const fixture = nativeServiceFixture();
    const port = createPiSubagentsLifecyclePort({ service: fixture.service });
    const capabilities = await port.capabilities(new AbortController().signal);

    expect(capabilities.provider).toMatchObject({
      kind: "published-package",
      packageName: "@nklisch/pi-subagents",
      version: "18.0.4-nklisch.0",
      integrity: "sha512-33Q8JDffXUuiT1M3XjLXCI4If9p+3AOwsUp/b5f1+B7Y5JI8Z8SVU+Dncq0umAG2IjgVYKnT9FHToFHNoZGWoQ==",
      releaseTag: "pi-subagents-v18.0.4-nklisch.0",
      commit: "43efffb459f64e2f5f9aaee50d8ae5afa564f4f3",
      license: "MIT",
      nodeEngine: ">=22",
      piPeerRange: ">=0.75.0",
    });
    expect(capabilities.semantics).toSatisfy((values) => Object.values(values).every(Boolean));
    expect(capabilities.coverage).toSatisfy((values) => Object.values(values).every(Boolean));
    expect(JSON.stringify(capabilities)).not.toContain("SECRET_CANARY");
  });

  it("translates validated exact prompt/result replacements and same-session continuation", async () => {
    const fixture = nativeServiceFixture();
    const port = createPiSubagentsLifecyclePort({ service: fixture.service });
    await register(port, {
      beforeStart: async (request) => ({ action: "continue", prompt: `${request.prompt}:host` }),
      beforeComplete: async (request) => request.continuationRound === 0
        ? { action: "continue", prompt: "Continue with validated hook feedback." }
        : { action: "complete", result: `${request.proposedResult}:host` },
    });
    const native = fixture.interceptors[0]!;

    await expect(native.beforeStart?.(startContext())).resolves.toEqual({
      action: "continue",
      prompt: "EXACT_PROMPT_SECRET_CANARY:host",
    });
    await expect(native.beforeComplete?.(completionContext())).resolves.toEqual({
      action: "continue",
      prompt: "Continue with validated hook feedback.",
    });
    await expect(native.beforeComplete?.({
      ...completionContext(),
      continuationRound: 1,
      proposedResult: "SECOND_PROPOSED_RESULT_SECRET_CANARY",
    })).resolves.toEqual({
      action: "complete",
      result: "SECOND_PROPOSED_RESULT_SECRET_CANARY:host",
    });
  });

  it("preserves immutable identity and fails closed at the continuation bound", async () => {
    const fixture = nativeServiceFixture();
    const port = createPiSubagentsLifecyclePort({ service: fixture.service });
    const received: unknown[] = [];
    await register(port, {
      beforeStart: async (request) => {
        received.push(request.identity, request.execution);
        return { action: "continue", prompt: request.prompt };
      },
      beforeComplete: async () => ({ action: "continue", prompt: "more work" }),
    });
    const native = fixture.interceptors[0]!;

    await expect(native.beforeStart?.(startContext())).resolves.toBeUndefined();
    expect(received).toEqual([
      { ...nativeIdentity, schemaVersion: 1 },
      nativeExecution,
    ]);
    await expect(native.beforeComplete?.({
      ...completionContext(),
      continuationRound: 3,
    })).resolves.toEqual({
      action: "abort",
      reason: "Subagent lifecycle continuation limit is exhausted",
    });
  });

  it("maps host aborts, no-op decisions, cancellation, and malformed callbacks without secret leakage", async () => {
    const fixture = nativeServiceFixture();
    const port = createPiSubagentsLifecyclePort({ service: fixture.service });
    await register(port, {
      beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
      beforeComplete: async () => ({ action: "abort", code: "hook-blocked", reason: "completion blocked" }),
    });
    const native = fixture.interceptors[0]!;

    await expect(native.beforeStart?.(startContext())).resolves.toBeUndefined();
    await expect(native.beforeComplete?.(completionContext())).resolves.toEqual({
      action: "abort",
      reason: "completion blocked",
    });

    const cancellation = new AbortController();
    const reason = new Error("caller cancellation");
    cancellation.abort(reason);
    await expect(native.beforeStart?.(startContext(cancellation.signal))).rejects.toBe(reason);

    let failure: unknown;
    try {
      await native.beforeStart?.({ ...startContext(), identity: { ...nativeIdentity, agentId: "" } });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BoundaryError);
    expect(JSON.stringify(failure)).not.toContain("EXACT_PROMPT_SECRET_CANARY");
  });

  it("propagates cancellation while a host callback is pending", async () => {
    const fixture = nativeServiceFixture();
    const port = createPiSubagentsLifecyclePort({ service: fixture.service });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    await register(port, {
      beforeStart: async () => {
        entered();
        return new Promise(() => undefined);
      },
      beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
    });
    const controller = new AbortController();
    const reason = new Error("caller-owned cancellation");
    const callback = fixture.interceptors[0]!.beforeStart!(startContext(controller.signal));
    await didEnter;
    controller.abort(reason);
    await expect(callback).rejects.toBe(reason);
  });

  it("fails malformed registration handoffs closed and unregisters once", async () => {
    const fixture = nativeServiceFixture();
    const port = createPiSubagentsLifecyclePort({ service: fixture.service });
    const signal = new AbortController().signal;
    const qualification = await port.capabilities(signal);

    await expect(port.register({
      interceptor: {} as never,
      expectedQualificationDigest: qualification.qualificationDigest,
      maxContinuationRounds: 3,
    }, signal)).rejects.toBeInstanceOf(BoundaryError);

    const registration = await register(port, {
      beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
      beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
    });
    await registration.dispose();
    await registration.dispose();
    expect(fixture.dispose).toHaveBeenCalledTimes(1);

    const failing = nativeServiceFixture();
    vi.mocked(failing.service.registerLifecycleInterceptor).mockImplementation(() => {
      throw new Error("NATIVE_PACKAGE_SECRET_CANARY");
    });
    const failingPort = createPiSubagentsLifecyclePort({ service: failing.service });
    let failure: unknown;
    try {
      await register(failingPort, {
        beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
        beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BoundaryError);
    expect(JSON.stringify(failure)).not.toContain("NATIVE_PACKAGE_SECRET_CANARY");
  });
});
