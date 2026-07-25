import { describe, expect, it } from "vitest";
import {
  defineSubagentLifecycleContract,
  disposalContractViolations,
  traceContractViolations,
} from "./subagent-lifecycle.contract.js";
import { createFakeSubagentLifecycle } from "../support/fakes/subagent-lifecycle.js";

defineSubagentLifecycleContract(
  "deterministic fake",
  () => createFakeSubagentLifecycle(),
);

describe("subagent lifecycle contract negative evidence", () => {
  const identity = {
    schemaVersion: 1 as const,
    agentId: "agent",
    sessionId: "session",
    runId: "run",
    agentType: "type",
  };
  const execution = {
    phase: "resume" as const,
    origin: "service" as const,
    mode: "background" as const,
    admission: "queued" as const,
  };

  it("detects event approximation, replacement loss, identity drift, and unbounded continuation", () => {
    expect(traceContractViolations({
      identity,
      execution,
      checkpoints: [
        "prompt",
        "start-interceptor",
        "proposed-result",
        "finalize",
        "completion-interceptor",
        "completion-event",
      ],
      decisionKinds: [],
      appliedDecisions: [],
      terminal: "completed",
      continuationRounds: 4,
    }, {
      requireInterceptors: true,
      requireStartReplacement: true,
      requireCompletionReplacement: true,
      expectedIdentity: { ...identity, runId: "expected-run" },
    })).toEqual([
      "start-after-prompt",
      "completion-after-finalization-side-effect",
      "unbounded-continuation",
      "start-replacement-lost",
      "completion-replacement-lost",
      "identity-drift",
    ]);
  });

  it("detects missing resume coverage and double disposal", () => {
    expect(traceContractViolations({
      identity,
      execution,
      checkpoints: [
        "prompt",
        "proposed-result",
        "workspace-addendum",
        "status-update",
        "finalize",
        "completion-event",
        "history",
        "notification",
      ],
      decisionKinds: [],
      appliedDecisions: [],
      terminal: "completed",
      continuationRounds: 0,
    }, { requireInterceptors: true })).toEqual([
      "missing-start-interception",
      "missing-completion-interception",
    ]);
    expect(disposalContractViolations(2, [1, 2])).toEqual([
      "double-session-disposal",
      "double-registration-disposal",
    ]);
  });
});
