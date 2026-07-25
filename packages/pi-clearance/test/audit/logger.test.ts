import { describe, expect, it } from "vitest";

import {
  type AuditEntry,
  type AuditLogSink,
  createArrayAuditSink,
  createAuditLogger,
  createPolicyDecisionEntry,
  type PolicyDecisionEntry,
} from "../../src/audit/log.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import type { Decision } from "../../src/policy/core.ts";

const allowDecision = {
  effect: "allow",
  reason: "Authorization: Bearer reviewer-visible-token",
  provenance: {
    source: "shipped",
    packId: "pack:dev",
    ruleId: "allow-safe-command",
  },
} satisfies Decision;

const bashShape = {
  kind: "bash",
  rawCommand: "echo password=hunter2",
  blocks: [],
  stages: [],
  diagnostics: [],
} satisfies ToolShape;

function policyEntry(): PolicyDecisionEntry {
  return createPolicyDecisionEntry(
    {
      entryType: "policy.decision",
      toolName: "bash",
      toolInput: { command: "echo password=hunter2" },
      shape: bashShape,
      decision: allowDecision,
    },
    { clock: () => new Date("2026-06-25T00:00:00.000Z") },
  );
}

describe("audit logger", () => {
  it("redacts entries before appending to the sink", async () => {
    const sink = createArrayAuditSink();
    const logger = createAuditLogger({ sink });
    const entry = policyEntry();

    await expect(logger.log(entry)).resolves.toBeUndefined();

    const captured = sink.entries[0] as PolicyDecisionEntry | undefined;
    expect(captured).toBeDefined();
    expect(captured?.toolInput).toEqual({
      command: "echo password=[redacted]",
    });
    expect(captured?.decision.reason).toBe("Authorization: Bearer [redacted]");
    expect((captured?.shape as ToolShape | undefined)?.kind).toBe("bash");
    expect(entry.toolInput).toEqual({ command: "echo password=hunter2" });
  });

  it("resolves even when a sink append throws", async () => {
    const sink: AuditLogSink = {
      appendSync(): void {
        throw new Error("disk unavailable");
      },
    };
    const logger = createAuditLogger({ sink });

    await expect(logger.log(policyEntry())).resolves.toBeUndefined();
  });

  it("exposes no flush method when the sink has no close hook", () => {
    const logger = createAuditLogger({ sink: createArrayAuditSink() });

    expect(logger.flush).toBeUndefined();
  });

  it("forwards flush to close and catches close errors", async () => {
    const closedEntries: AuditEntry[] = [];
    const closingSink: AuditLogSink = {
      appendSync(entry: AuditEntry): void {
        closedEntries.push(entry);
      },
      async close(): Promise<void> {
        closedEntries.push(policyEntry());
      },
    };
    const throwingCloseSink: AuditLogSink = {
      appendSync(): void {},
      async close(): Promise<void> {
        throw new Error("close failed");
      },
    };

    const logger = createAuditLogger({ sink: closingSink });
    const throwingLogger = createAuditLogger({ sink: throwingCloseSink });

    await expect(logger.flush?.()).resolves.toBeUndefined();
    await expect(throwingLogger.flush?.()).resolves.toBeUndefined();
    expect(closedEntries).toHaveLength(1);
  });
});
