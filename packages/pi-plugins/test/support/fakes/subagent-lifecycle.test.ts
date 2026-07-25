import { describe, expect, it } from "vitest";
import { createFakeSubagentLifecycle } from "./subagent-lifecycle.js";
import { lifecycleIdentity, lifecyclePath } from "../../contract/subagent-lifecycle.contract.js";

describe("deterministic subagent lifecycle fake", () => {
  it("reports test-only qualification and rejects mismatched registration evidence", async () => {
    const fake = createFakeSubagentLifecycle();
    const signal = new AbortController().signal;
    const capabilities = await fake.lifecycle.capabilities(signal);
    expect(capabilities.provider.kind).toBe("test");
    await expect(fake.lifecycle.register({
      expectedQualificationDigest: `sha256:${"0".repeat(64)}` as never,
      maxContinuationRounds: 3,
      interceptor: {
        beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
        beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
      },
    }, signal)).rejects.toThrow("registration rejected");
  });

  it("shutdown aborts pending callbacks and registration/session disposal stays exactly once", async () => {
    const fake = createFakeSubagentLifecycle();
    const signal = new AbortController().signal;
    const capabilities = await fake.lifecycle.capabilities(signal);
    await fake.lifecycle.register({
      expectedQualificationDigest: capabilities.qualificationDigest,
      maxContinuationRounds: 3,
      interceptor: {
        beforeStart: async () => new Promise(() => undefined),
        beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
      },
    }, signal);
    const identity = lifecycleIdentity();
    const execution = fake.execute({
      identity,
      execution: lifecyclePath(),
      prompt: "PROMPT_SECRET_CANARY",
      proposedResults: ["RESULT_SECRET_CANARY"],
      signal,
    });
    await Promise.resolve();
    await fake.shutdown();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    await fake.shutdown();
    expect(fake.registrationDisposeCounts()).toEqual([1]);
    expect(fake.sessionDisposeCount(identity.sessionId)).toBe(1);
  });
});
