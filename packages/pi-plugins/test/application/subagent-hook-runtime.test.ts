import { describe, expect, it, vi } from "vitest";
import { registerSubagentHookRuntime } from "../../src/application/subagent-hook-runtime.js";
import {
  SUBAGENT_LIFECYCLE_CAPABILITY_ID,
  SubagentLifecycleRegistrationEvidenceSchemaV1,
  type SubagentLifecyclePort,
} from "../../src/application/ports/subagent-lifecycle.js";
import { BoundaryError } from "../../src/domain/errors.js";
import { createFakeSubagentLifecycle } from "../support/fakes/subagent-lifecycle.js";

describe("portable subagent hook runtime registration", () => {
  it("binds one aggregate interceptor to the exact qualification and disposes idempotently", async () => {
    const fake = createFakeSubagentLifecycle();
    const signal = new AbortController().signal;
    const qualification = await fake.lifecycle.capabilities(signal);
    const coordinator = {
      beforeStart: async (request: any) => ({ action: "continue" as const, prompt: request.prompt }),
      beforeComplete: async (request: any) => ({ action: "complete" as const, result: request.proposedResult }),
    };
    const runtime = await registerSubagentHookRuntime({
      lifecycle: fake.lifecycle,
      qualification,
      coordinator,
      runtimeSignal: signal,
    });

    expect(runtime.evidence).toEqual({
      schemaVersion: 1,
      contractVersion: 1,
      capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
      qualificationDigest: qualification.qualificationDigest,
      orderedAsync: true,
      maxContinuationRounds: 3,
      state: "registered",
    });
    await runtime.dispose();
    await runtime.dispose();
    expect(fake.registrationDisposeCounts()).toEqual([1]);
    await fake.shutdown();
  });

  it("rejects registration evidence mismatch and disposes the raw handle", async () => {
    const fake = createFakeSubagentLifecycle();
    const signal = new AbortController().signal;
    const qualification = await fake.lifecycle.capabilities(signal);
    const dispose = vi.fn(async () => undefined);
    const lifecycle: SubagentLifecyclePort = {
      capabilities: fake.lifecycle.capabilities,
      register: vi.fn(async () => ({
        evidence: SubagentLifecycleRegistrationEvidenceSchemaV1.parse({
          schemaVersion: 1,
          contractVersion: 1,
          capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
          qualificationDigest: `sha256:${"f".repeat(64)}`,
          orderedAsync: true,
          maxContinuationRounds: 3,
          state: "registered",
        }),
        dispose,
      })),
    };
    await expect(registerSubagentHookRuntime({
      lifecycle,
      qualification,
      coordinator: {
        beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
        beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
      },
      runtimeSignal: signal,
    })).rejects.toMatchObject({ code: "ADAPTER_FAILED" });
    expect(dispose).toHaveBeenCalledTimes(1);
    await fake.shutdown();
  });

  it("returns redacted adapter failure for malformed/failed registration", async () => {
    const fake = createFakeSubagentLifecycle();
    const signal = new AbortController().signal;
    const qualification = await fake.lifecycle.capabilities(signal);
    const canary = "NATIVE_PACKAGE_PROMPT_RESULT_CANARY";
    const lifecycle: SubagentLifecyclePort = {
      capabilities: fake.lifecycle.capabilities,
      register: async () => { throw new Error(canary); },
    };
    let failure: unknown;
    try {
      await registerSubagentHookRuntime({
        lifecycle,
        qualification,
        coordinator: {
          beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
          beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
        },
        runtimeSignal: signal,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BoundaryError);
    expect(failure).toMatchObject({ code: "ADAPTER_FAILED" });
    expect(JSON.stringify(failure)).not.toContain(canary);
    await fake.shutdown();
  });

  it("runtime cancellation disposes registration exactly once and prevents a usable handoff race", async () => {
    const fake = createFakeSubagentLifecycle();
    const runtimeAbort = new AbortController();
    const qualification = await fake.lifecycle.capabilities(runtimeAbort.signal);
    const runtime = await registerSubagentHookRuntime({
      lifecycle: fake.lifecycle,
      qualification,
      coordinator: {
        beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
        beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
      },
      runtimeSignal: runtimeAbort.signal,
    });
    runtimeAbort.abort(new Error("shutdown"));
    await Promise.resolve();
    await runtime.dispose();
    expect(fake.registrationDisposeCounts()).toEqual([1]);
    await fake.shutdown();
  });
});
