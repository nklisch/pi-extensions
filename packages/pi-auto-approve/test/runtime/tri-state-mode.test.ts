import { describe, expect, it } from "vitest";
import type { ReviewerDecisionEntry } from "../../src/audit/entry.ts";
import type { AuditLogger } from "../../src/audit/logger.ts";
import type { ResolvedReviewerConfig } from "../../src/config/loader.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
} from "../../src/config/schema.ts";
import { baselinePacks } from "../../src/packs/baseline.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import type { Decision } from "../../src/policy/core.ts";
import {
  dispatchReview,
  type ReviewDispatchRequest,
  type ReviewerHumanAdapter,
  type ReviewerModelAdapter,
} from "../../src/runtime/reviewer.ts";

const originalDecision = {
  effect: "review",
  reason: "no deterministic allow matched",
  provenance: { source: "default" },
} satisfies Decision;

const shape = {
  kind: "bash",
  rawCommand: "curl https://example.com",
  blocks: [],
  stages: [],
  diagnostics: [],
} satisfies ToolShape;

function reviewerConfig(): ResolvedReviewerConfig {
  return {
    promptPosture: "reviewer.default",
    promptAppends: [],
    projectPromptAppends: [],
    promptOverride: null,
    model: null,
    tokenBudget: { window: "24h", limit: null },
    contextMode: "recentContext",
    recentContext: {
      decisionLimit: 25,
      decisionWindow: "2h",
      conversationTurns: 3,
      conversationCharLimit: 6000,
    },
    escalation: { enabled: true, denialLimit: 3, window: "10m" },
  };
}

function auditCapture(): {
  readonly audit: AuditLogger;
  readonly entries: ReviewerDecisionEntry[];
} {
  const entries: ReviewerDecisionEntry[] = [];
  return {
    entries,
    audit: {
      async log(entry) {
        if (entry.entryType === "reviewer.decision") entries.push(entry);
      },
    },
  };
}

function human(
  available: boolean,
  effect: "allow" | "deny" = "allow",
): ReviewerHumanAdapter & { calls: number } {
  const adapter = {
    kind: "human" as const,
    calls: 0,
    isAvailable: () => available,
    async approve() {
      adapter.calls += 1;
      return { decision: effect };
    },
  };
  return adapter;
}

function model(available: boolean): ReviewerModelAdapter & { calls: number } {
  const adapter = {
    kind: "model" as const,
    calls: 0,
    isAvailable: () => available,
    async review() {
      adapter.calls += 1;
      return { effect: "allow" as const, reason: "model approved" };
    },
  };
  return adapter;
}

function request(
  mode: "off" | "ask" | "auto",
  humanAdapter: ReviewerHumanAdapter,
  modelAdapter: ReviewerModelAdapter,
  audit: AuditLogger,
): ReviewDispatchRequest {
  return {
    mode,
    originalDecision,
    toolName: "bash",
    toolInput: { command: shape.rawCommand },
    shape,
    reviewerConfig: reviewerConfig(),
    humanAdapter,
    modelAdapter,
    audit,
  };
}

describe("tri-state Clearance mode", () => {
  it("defaults missing global mode to ask and rejects legacy keys", () => {
    const missing = normalizeConfig(GlobalConfigSchema, { version: 1 });
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value.mode).toBe("ask");

    const legacy = normalizeConfig(GlobalConfigSchema, {
      version: 1,
      defaultPosture: "default",
    });
    expect(legacy.ok).toBe(false);
  });

  it("passes review through in off mode and audits the distinct source", async () => {
    const capture = auditCapture();
    const humanAdapter = human(true);
    const modelAdapter = model(true);
    const result = await dispatchReview(
      request("off", humanAdapter, modelAdapter, capture.audit),
    );
    expect(result.effect).toBe("allow");
    expect(humanAdapter.calls).toBe(0);
    expect(modelAdapter.calls).toBe(0);
    expect(capture.entries[0]?.decisionSource).toBe("mode-off-passthrough");
  });

  it("uses only the human path in ask mode", async () => {
    const capture = auditCapture();
    const humanAdapter = human(true);
    const modelAdapter = model(true);
    await dispatchReview(
      request("ask", humanAdapter, modelAdapter, capture.audit),
    );
    expect(humanAdapter.calls).toBe(1);
    expect(modelAdapter.calls).toBe(0);
  });

  it("blocks and logs when Ask has no human UI", async () => {
    const capture = auditCapture();
    const humanAdapter = human(false);
    const modelAdapter = model(true);
    const result = await dispatchReview(
      request("ask", humanAdapter, modelAdapter, capture.audit),
    );
    expect(result.effect).toBe("review");
    expect(modelAdapter.calls).toBe(0);
    expect(capture.entries[0]?.decisionSource).toBe("unattended-fallback");
  });

  it("falls from unavailable model to human in Auto mode", async () => {
    const capture = auditCapture();
    const humanAdapter = human(true);
    const modelAdapter = model(false);
    const result = await dispatchReview(
      request("auto", humanAdapter, modelAdapter, capture.audit),
    );
    expect(result.effect).toBe("allow");
    expect(modelAdapter.calls).toBe(0);
    expect(humanAdapter.calls).toBe(1);
  });

  it("uses model-first review in auto mode", async () => {
    const capture = auditCapture();
    const humanAdapter = human(true);
    const modelAdapter = model(true);
    await dispatchReview(
      request("auto", humanAdapter, modelAdapter, capture.audit),
    );
    expect(modelAdapter.calls).toBe(1);
    expect(humanAdapter.calls).toBe(0);
  });

  it("includes former permissive packs in the baseline", () => {
    const ids = new Set(baselinePacks.map((pack) => pack.id));
    expect(ids.has("bash.network.read")).toBe(true);
    expect(ids.has("pi.extension.network-research")).toBe(true);
    expect(ids.has("pi.home.safe")).toBe(true);
  });
});
