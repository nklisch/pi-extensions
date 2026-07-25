import { describe, expect, it } from "vitest";

import type {
  ResolvedProjectScope,
  ResolvedReviewerConfig,
} from "../../src/config/loader.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import type { SourceSpan, ToolShape } from "../../src/parse/shape.ts";
import type { Decision } from "../../src/policy/core.ts";
import type { AutoReviewerStatusView } from "../../src/runtime/auto-reviewer-read-models.ts";
import {
  buildCompactReviewSummary,
  formatDenyBlockReason,
  formatHumanReviewMessage,
  formatModelOutcomeNotice,
  formatReviewDecisionNote,
  formatStatusLine,
  styleStatusLineMode,
} from "../../src/runtime/review-visibility.ts";
import { COMPOUND_COMMANDS } from "../fixtures/compound-clearance-corpus.ts";

const reviewDecision = {
  effect: "review",
  reason: "no deterministic allow matched",
  provenance: { source: "default" },
} satisfies Decision;

const bashShape = {
  kind: "bash",
  rawCommand: "pnpm test -- --runInBand",
  blocks: [],
  stages: [],
  diagnostics: [
    {
      code: "bash:unsupported-construct",
      message: "unsupported shell construct requires review",
      severity: "warning",
      source: span(0, 4),
    },
  ],
} satisfies ToolShape;

describe("review visibility summary", () => {
  it("builds a prose human review card with no JSON dumps", () => {
    const summary = buildCompactReviewSummary({
      toolName: "bash",
      toolInput: { command: "pnpm test -- --runInBand" },
      shape: bashShape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    const message = formatHumanReviewMessage(summary);

    expect(message).toContain("`pnpm test -- --runInBand`");
    expect(message).toContain("**What it does**");
    expect(message).toContain("**Why you're being asked**");
    expect(message).toContain("no deterministic allow matched");
    expect(message).not.toContain("## Diagnostics");
    expect(message).not.toContain("### Raw tool input");
    expect(message).not.toContain("### Parsed shape");
    expect(message).not.toContain("```json");
  });

  it("never leaks raw tool input JSON into the human message", () => {
    const summary = buildCompactReviewSummary({
      toolName: "bash",
      toolInput: { command: "pnpm test", extra: { keep: true } },
      shape: bashShape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    const message = formatHumanReviewMessage(summary);
    expect(message).not.toContain('"extra"');
    expect(message).not.toContain('"rawCommand"');
    expect(summary.card.whatItDoes.length).toBeGreaterThan(0);
  });

  it("truncates long single-line previews", () => {
    const rawCommand = `node -e "${"x".repeat(300)}"`;
    const shape = { ...bashShape, rawCommand } satisfies ToolShape;
    const summary = buildCompactReviewSummary({
      toolName: "bash",
      toolInput: {},
      shape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    expect(summary.commandPreview.length).toBeLessThanOrEqual(180);
    expect(summary.commandPreview).toMatch(/\.\.\.$/);
    expect(formatHumanReviewMessage(summary)).toContain(summary.commandPreview);
  });

  it("formats non-bash tools with generic JSON previews and unanalyzed labels", () => {
    const shape = {
      kind: "unknown",
      toolName: "custom_tool",
      rawInput: { path: "src/index.ts", action: "read" },
      diagnostics: [],
    } satisfies ToolShape;

    const summary = buildCompactReviewSummary({
      toolName: "custom_tool",
      toolInput: { path: "src/index.ts", action: "read" },
      shape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    expect(summary.toolLabel).toBe("custom_tool (unanalyzed)");
    // Prose preview: tool name + primary path, never raw JSON input.
    expect(summary.commandPreview).toBe("custom_tool src/index.ts");
    expect(summary.commandPreview).not.toContain("{");
    const message = formatHumanReviewMessage(summary);
    expect(message).toContain("could not analyze");
    expect(message).not.toContain("Reviewer mode:");
  });

  it("names typed file-mutation review reasons instead of unsupported-tool wording", () => {
    const trustBoundaryShape = {
      kind: "pi-tool",
      toolName: "write",
      operation: "mutation",
      rawInput: { path: "package.json", content: "{}" },
      pathInputs: [{ key: "path", raw: "package.json", required: true }],
      diagnostics: [],
      mutationFacts: {
        kind: "write",
        targetPath: "package.json",
        contentLength: 2,
        overwrites: "unknown",
      },
      trustBoundary: { kind: "package-script", matchedPattern: "package.json" },
      pathFacts: {
        baseCwd: "/repo",
        effectiveCwd: "/repo",
        facts: [
          {
            id: "pi-tool:write:path",
            toolName: "write",
            usage: "argument",
            access: "create",
            raw: "package.json",
            literal: "package.json",
            absolutePath: "/repo/package.json",
            scope: "writable-project",
            matchedScopes: ["writable-project", "project"],
            normalization: "lexical",
            isAbsolute: false,
            isRelative: true,
            hasParentTraversal: false,
            dynamic: false,
          },
        ],
        hasUnknown: false,
        hasDenied: false,
        hasOutsideProject: false,
        hasSystemPath: false,
      },
    } satisfies ToolShape;

    const summary = buildCompactReviewSummary({
      toolName: "write",
      toolInput: { path: "package.json", content: "{}" },
      shape: trustBoundaryShape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    expect(summary.toolLabel).toBe("write");
    expect(summary.policyReason).toContain(
      'trust-boundary target: package-script; overwrites: "unknown"',
    );
    expect(summary.policyReason).not.toMatch(/unsupported|unanalyzed/i);
  });

  it("adds compound recovery copy and safe alternatives for proven read-only work-item loops", async () => {
    const shape = await analyzedBashShape(
      COMPOUND_COMMANDS.motivatingBacklogLoop,
    );

    const summary = buildCompactReviewSummary({
      toolName: "bash",
      toolInput: { command: shape.rawCommand },
      shape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    expect(summary.policyReason).toContain("compound for loop");
    expect(summary.policyReason).toContain(
      "modeled read-only loop still needs reviewer judgment",
    );
    expect(summary.policyReason).toContain("Safe equivalent:");
    expect(summary.policyReason).toContain("Pi typed read/search tools");
    expect(summary.policyReason).toContain(".work/bin/work-view --cat");
  });

  it("names unsupported iterators without suggesting unsafe rewrites", async () => {
    const shape = await analyzedBashShape(COMPOUND_COMMANDS.dynamicIterator);

    const summary = buildCompactReviewSummary({
      toolName: "bash",
      toolInput: { command: shape.rawCommand },
      shape,
      originalDecision: compoundReviewDecision(
        "bash.review.compound:review-unsupported-iterator",
        "compound loop iterator contains opaque expansion or unsupported iterator syntax",
      ),
      reviewerConfig: reviewerConfig(),
    });

    expect(summary.policyReason).toContain("compound for construct");
    expect(summary.policyReason).toContain(
      "iterator uses dynamic, opaque, or unsupported syntax",
    );
    expect(summary.policyReason).not.toContain("Safe equivalent:");
  });

  it("names unsafe body evidence and timeout caveats without safe alternatives", async () => {
    const baseShape = await analyzedBashShape(
      COMPOUND_COMMANDS.outputRedirectBody,
    );
    const shape = {
      ...baseShape,
      rawCommand: `timeout 5s ${baseShape.rawCommand}`,
    } satisfies ToolShape;

    const summary = buildCompactReviewSummary({
      toolName: "bash",
      toolInput: { command: shape.rawCommand },
      shape,
      originalDecision: compoundReviewDecision(
        "bash.review.compound:review-for-non-read-only-body",
        "compound for-loop body is not proven read-only for every modeled command",
      ),
      reviewerConfig: reviewerConfig(),
    });

    expect(summary.policyReason).toContain("compound for loop");
    expect(summary.policyReason).toContain("output-file redirect");
    expect(summary.policyReason).toContain(
      "timeout/resource limits are not permission proof",
    );
    expect(summary.policyReason).not.toContain("Safe equivalent:");
  });

  it("keeps compound recovery copy away from typed file-mutation reasons", () => {
    const trustBoundaryShape = {
      kind: "pi-tool",
      toolName: "write",
      operation: "mutation",
      rawInput: { path: "package.json", content: "{}" },
      pathInputs: [{ key: "path", raw: "package.json", required: true }],
      diagnostics: [],
      mutationFacts: {
        kind: "write",
        targetPath: "package.json",
        contentLength: 2,
        overwrites: "unknown",
      },
      trustBoundary: { kind: "package-script", matchedPattern: "package.json" },
      pathFacts: {
        baseCwd: "/repo",
        effectiveCwd: "/repo",
        facts: [
          {
            id: "pi-tool:write:path",
            toolName: "write",
            usage: "argument",
            access: "create",
            raw: "package.json",
            literal: "package.json",
            absolutePath: "/repo/package.json",
            scope: "writable-project",
            matchedScopes: ["writable-project", "project"],
            normalization: "lexical",
            isAbsolute: false,
            isRelative: true,
            hasParentTraversal: false,
            dynamic: false,
          },
        ],
        hasUnknown: false,
        hasDenied: false,
        hasOutsideProject: false,
        hasSystemPath: false,
      },
    } satisfies ToolShape;

    const summary = buildCompactReviewSummary({
      toolName: "write",
      toolInput: { path: "package.json", content: "{}" },
      shape: trustBoundaryShape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    expect(summary.policyReason).toContain(
      "trust-boundary target: package-script",
    );
    expect(summary.policyReason).not.toContain("compound");
  });

  it("surfaces missing and dynamic mutation facts in review summaries", () => {
    const missingFactsShape = {
      kind: "pi-tool",
      toolName: "edit",
      operation: "mutation",
      rawInput: { path: "src/a.ts" },
      pathInputs: [{ key: "path", raw: "src/a.ts", required: true }],
      diagnostics: [],
    } satisfies ToolShape;
    const dynamicShape = {
      kind: "pi-tool",
      toolName: "edit",
      operation: "mutation",
      rawInput: { path: "$TARGET", oldText: "old", newText: "new" },
      pathInputs: [{ key: "path", raw: "$TARGET", required: true }],
      diagnostics: [],
      mutationFacts: {
        kind: "edit",
        targetPath: "$TARGET",
        oldTextLength: 3,
        newTextLength: 3,
        createsContent: false,
      },
      trustBoundary: { kind: "unknown" },
      pathFacts: {
        baseCwd: "/repo",
        effectiveCwd: "/repo",
        facts: [
          {
            id: "pi-tool:edit:path",
            toolName: "edit",
            usage: "argument",
            access: "write",
            raw: "$TARGET",
            scope: "unknown",
            matchedScopes: ["unknown"],
            normalization: "lexical",
            isAbsolute: false,
            isRelative: true,
            hasParentTraversal: false,
            dynamic: true,
            unknownReason: "dynamic-expansion",
          },
        ],
        hasUnknown: true,
        hasDenied: false,
        hasOutsideProject: false,
        hasSystemPath: false,
      },
    } satisfies ToolShape;

    expect(
      buildCompactReviewSummary({
        toolName: "edit",
        toolInput: { path: "src/a.ts" },
        shape: missingFactsShape,
        originalDecision: reviewDecision,
        reviewerConfig: reviewerConfig(),
      }).policyReason,
    ).toContain("missing mutation facts for typed edit/write");
    expect(
      buildCompactReviewSummary({
        toolName: "edit",
        toolInput: { path: "$TARGET", oldText: "old", newText: "new" },
        shape: dynamicShape,
        originalDecision: reviewDecision,
        reviewerConfig: reviewerConfig(),
      }).policyReason,
    ).toContain(
      "dynamic or missing path facts for typed edit/write ($TARGET: dynamic-expansion)",
    );
  });

  it("never leaks write-tool file contents into the preview", () => {
    const writeShape = {
      kind: "pi-tool",
      toolName: "write",
      operation: "mutation",
      rawInput: { path: "src/secret.ts", content: "const token = 'abc123';" },
      pathInputs: [{ key: "path", raw: "src/secret.ts", required: true }],
      diagnostics: [],
    } satisfies ToolShape;

    const summary = buildCompactReviewSummary({
      toolName: "write",
      toolInput: { path: "src/secret.ts", content: "const token = 'abc123';" },
      shape: writeShape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    const message = formatHumanReviewMessage(summary);
    expect(summary.commandPreview).toBe("write src/secret.ts");
    expect(message).not.toContain("abc123");
    expect(message).not.toContain("const token");
  });

  it("keeps unserializable tool input display-safe in previews", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const summary = buildCompactReviewSummary({
      toolName: "bash",
      toolInput: circular,
      shape: bashShape,
      originalDecision: reviewDecision,
      reviewerConfig: reviewerConfig(),
    });

    // The shape's rawCommand is the preferred preview source; the circular
    // input must never throw or leak into the message.
    expect(summary.commandPreview).toBe("pnpm test -- --runInBand");
    expect(() => formatHumanReviewMessage(summary)).not.toThrow();
  });
});

describe("formatDenyBlockReason", () => {
  it("passes allow decisions through unchanged", () => {
    const allow: Decision = {
      effect: "allow",
      reason: "rule allowed it",
      provenance: { source: "shipped" },
    };
    expect(formatDenyBlockReason(allow)).toBe(allow.reason);
  });

  it("adds the debrief hint to blocked-pending-review outcomes", () => {
    expect(formatDenyBlockReason(reviewDecision)).toBe(
      "no deterministic allow matched — /clearance why for details",
    );
  });

  it("appends only the debrief hint to deterministic pack denies", () => {
    const decision: Decision = {
      effect: "deny",
      reason: "bash.vcs.write: force push requires confirmation",
      provenance: { source: "shipped" },
    };
    expect(formatDenyBlockReason(decision)).toBe(
      "bash.vcs.write: force push requires confirmation — /clearance why for details",
    );
  });

  it("appends the family-allow hint to model reviewer denies", () => {
    const decision: Decision = {
      effect: "deny",
      reason: "Model auto-reviewer deny (gpt-test): unsafe command",
      provenance: { source: "generated" },
    };
    expect(formatDenyBlockReason(decision)).toBe(
      "Model auto-reviewer deny (gpt-test): unsafe command — /clearance why for details; /clearance allow <plain language> to permit this family",
    );
  });

  it("appends the family-allow hint to human reviewer denies", () => {
    const decision: Decision = {
      effect: "deny",
      reason: "Human reviewer denied the tool call",
      provenance: { source: "user-global" },
    };
    expect(formatDenyBlockReason(decision)).toContain(
      "/clearance allow <plain language>",
    );
  });

  it("never offers the allow hint for a pack deny quoting reviewer wording", () => {
    // A user/pack-authored deny reason may start with the reviewer prefix;
    // without generated provenance it must not promise the family-allow path.
    const decision: Decision = {
      effect: "deny",
      reason: "Model auto-reviewer deny wording quoted by a pack rule",
      provenance: { source: "user-global", packId: "user.pack", ruleId: "r1" },
    };
    expect(formatDenyBlockReason(decision)).toBe(
      "Model auto-reviewer deny wording quoted by a pack rule — /clearance why for details",
    );
  });
});

describe("review visibility status line", () => {
  it("compresses ask mode to mode plus tune/warning suffixes", () => {
    const statusLine = formatStatusLine(statusView());

    expect(statusLine).toBe("clearance: ask · tune on · warnings 2");
  });

  it("names the reviewer model in auto mode", () => {
    const statusLine = formatStatusLine(statusView({ mode: "auto" }));

    expect(statusLine).toBe(
      "clearance: auto · reviewer model openai-codex/gpt-5.5 · tune on · warnings 2",
    );
  });

  it("omits inactive ratchet/warning suffixes", () => {
    const statusLine = formatStatusLine(
      statusView({
        ratchet: {
          active: false,
          previousActiveTools: [],
          ratchetToolNames: [],
        },
        mode: "ask",
        reviewer: {
          ...statusView().reviewer,
          path: "unattended-fallback",
          resolvedModel: null,
        },
        warnings: [],
      }),
    );

    expect(statusLine).toBe("clearance: ask");
  });

  describe("styleStatusLineMode", () => {
    const fakeFg = (color: string, text: string) => `<${color}>${text}</>`;

    it.each([
      ["off", "muted"],
      ["ask", "warning"],
      ["auto", "success"],
    ] as const)("colors %s mode as %s", (mode, color) => {
      const styled = styleStatusLineMode(
        `clearance: ${mode} · warnings 2`,
        mode,
        fakeFg,
      );

      expect(styled).toBe(`clearance: <${color}>${mode}</> · warnings 2`);
    });

    it("leaves labels without the mode prefix untouched", () => {
      expect(styleStatusLineMode("something else", "ask", fakeFg)).toBe(
        "something else",
      );
    });
  });
});

describe("review decision notes", () => {
  it.each([
    [
      "reason+accent",
      { text: "project-local command is safe", accent: "clearance-gold" },
    ],
    ["accent-only", { accent: "clearance-gold" }],
    [
      "reason+model",
      {
        text: "project-local command is safe",
        detail: "openai-codex/gpt-test",
        accent: "clearance-gold",
      },
    ],
    ["off", { accent: false }],
  ] as const)("formats model allow note mode %s", (mode, expected) => {
    expect(
      formatReviewDecisionNote({
        mode,
        showModelLabel: false,
        accent: true,
        reviewerMode: "model",
        finalDecision: modelDecision(
          "allow",
          "Model auto-reviewer allow (gpt-test): project-local command is safe",
        ),
        reviewerModelLabel: "openai-codex/gpt-test",
      }),
    ).toEqual(expected);
  });

  it.each([
    [
      "reason+accent",
      { text: "command could delete generated artifacts", accent: false },
    ],
    ["accent-only", { accent: false }],
    [
      "reason+model",
      {
        text: "command could delete generated artifacts",
        detail: "openai-codex/gpt-test",
        accent: false,
      },
    ],
    ["off", { accent: false }],
  ] as const)("formats model deny note mode %s without gold", (mode, expected) => {
    expect(
      formatReviewDecisionNote({
        mode,
        showModelLabel: false,
        accent: true,
        reviewerMode: "model",
        finalDecision: modelDecision(
          "deny",
          "Model auto-reviewer deny (gpt-test): command could delete generated artifacts",
        ),
        reviewerModelLabel: "openai-codex/gpt-test",
      }),
    ).toEqual(expected);
  });

  it.each([
    "human",
    "block-and-log",
  ] as const)("returns undefined for %s review paths", (reviewerMode) => {
    expect(
      formatReviewDecisionNote({
        mode: "reason+accent",
        showModelLabel: true,
        accent: true,
        reviewerMode,
        finalDecision: modelDecision("allow", "safe"),
        reviewerModelLabel: "openai-codex/gpt-test",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for model paths that did not finally allow or deny", () => {
    expect(
      formatReviewDecisionNote({
        mode: "reason+accent",
        showModelLabel: true,
        accent: true,
        reviewerMode: "model",
        finalDecision: reviewDecision,
        reviewerModelLabel: "openai-codex/gpt-test",
      }),
    ).toBeUndefined();
  });

  it.each([
    "reason+accent",
    "accent-only",
  ] as const)("lifts model label into detail for %s when override is enabled", (mode) => {
    const note = formatReviewDecisionNote({
      mode,
      showModelLabel: true,
      accent: true,
      reviewerMode: "model",
      finalDecision: modelDecision(
        "allow",
        "Model auto-reviewer allow (gpt-test): project-local command is safe",
      ),
      reviewerModelLabel: "openai-codex/gpt-test",
    });

    expect(note).toMatchObject({ detail: "openai-codex/gpt-test" });
    expect(note?.text ?? "").not.toContain("openai-codex/gpt-test");
  });

  it("keeps off mode invisible even when model-label override is enabled", () => {
    expect(
      formatReviewDecisionNote({
        mode: "off",
        showModelLabel: true,
        accent: true,
        reviewerMode: "model",
        finalDecision: modelDecision(
          "allow",
          "Model auto-reviewer allow (gpt-test): project-local command is safe",
        ),
        reviewerModelLabel: "openai-codex/gpt-test",
      }),
    ).toEqual({ accent: false });
  });

  it("does not include the model label in default reason text", () => {
    const note = formatReviewDecisionNote({
      mode: "reason+accent",
      showModelLabel: false,
      accent: true,
      reviewerMode: "model",
      finalDecision: modelDecision(
        "allow",
        "Model auto-reviewer allow (gpt-test): project-local command is safe",
      ),
      reviewerModelLabel: "openai-codex/gpt-test",
    });

    expect(note).toEqual({
      text: "project-local command is safe",
      accent: "clearance-gold",
    });
    expect(note?.text).not.toContain("gpt-test");
    expect(note).not.toHaveProperty("detail");
  });

  it("honors the accent override for model allow outcomes", () => {
    expect(
      formatReviewDecisionNote({
        mode: "reason+accent",
        showModelLabel: false,
        accent: false,
        reviewerMode: "model",
        finalDecision: modelDecision("allow", "safe"),
      }),
    ).toEqual({ text: "safe", accent: false });
  });

  it("truncates reason text and model-label detail independently", () => {
    const longReason = `Model auto-reviewer allow (gpt-test): ${"safe ".repeat(80)}`;
    const longModelLabel = `provider/${"model-".repeat(20)}variant`;

    const note = formatReviewDecisionNote({
      mode: "reason+model",
      showModelLabel: false,
      accent: true,
      reviewerMode: "model",
      finalDecision: modelDecision("allow", longReason),
      reviewerModelLabel: longModelLabel,
    });

    expect(note?.text).toHaveLength(220);
    expect(note?.text).toMatch(/\.\.\.$/);
    expect(note?.text).not.toContain("provider/");
    expect(note?.detail).toHaveLength(80);
    expect(note?.detail).toMatch(/\.\.\.$/);
  });
});

describe("model outcome notices", () => {
  it.each([
    ["allow", "allowed"],
    ["deny", "denied"],
  ] as const)("formats model %s outcomes", (effect, verb) => {
    const notice = formatModelOutcomeNotice({
      reviewerMode: "model",
      finalDecision: {
        effect,
        reason: `Model auto-reviewer ${effect} (gpt-test): project-local command is safe`,
        provenance: { source: "generated" },
      },
      reviewerModelLabel: "openai-codex/gpt-test",
    });

    expect(notice).toBe(
      `Auto-reviewer: model ${verb} by openai-codex/gpt-test — project-local command is safe`,
    );
  });

  it.each([
    "human",
    "block-and-log",
  ] as const)("returns undefined for %s reviewer paths", (reviewerMode) => {
    expect(
      formatModelOutcomeNotice({
        reviewerMode,
        finalDecision: {
          effect: "allow",
          reason: "Human reviewer approved the tool call",
          provenance: { source: "user-global" },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for model review paths that did not allow or deny", () => {
    expect(
      formatModelOutcomeNotice({
        reviewerMode: "model",
        finalDecision: reviewDecision,
      }),
    ).toBeUndefined();
  });
});

type BashToolShape = Extract<ToolShape, { readonly kind: "bash" }>;

async function analyzedBashShape(command: string): Promise<BashToolShape> {
  const parsed = await analyzeBashCommand(command);
  return enrichToolShapeWithPathFacts(parsed, {
    cwd: "/repo",
    projectScope: projectScope(),
  }) as BashToolShape;
}

function compoundReviewDecision(ruleId: string, reason: string): Decision {
  return {
    effect: "review",
    reason,
    provenance: {
      source: "shipped",
      packId: "bash.review.compound",
      ruleId,
    },
  };
}

function projectScope(): ResolvedProjectScope {
  return {
    roots: ["/repo"],
    writableDirectories: ["/repo"],
    tempDirectories: ["/tmp"],
    deniedDirectories: ["/repo/denied"],
    safeHomeDirectories: [],
    unknownPathBehavior: "review",
    sensitivePathBehavior: "review",
    homePathBehavior: "allow",
  };
}

function modelDecision(effect: "allow" | "deny", reason: string): Decision {
  return { effect, reason, provenance: { source: "generated" } };
}

function reviewerConfig(
  overrides: Partial<ResolvedReviewerConfig> = {},
): ResolvedReviewerConfig {
  return {
    promptPosture: "reviewer.default",
    promptAppends: [],
    projectPromptAppends: [],
    promptOverride: null,
    model: null,
    tokenBudget: { window: "24h", limit: null },
    contextMode: "minimal",
    recentContext: {
      decisionLimit: 25,
      decisionWindow: "2h",
      conversationTurns: 3,
      conversationCharLimit: 6000,
    },
    escalation: { enabled: true, denialLimit: 3, window: "10m" },
    ...overrides,
  };
}

function statusView(
  overrides: Partial<AutoReviewerStatusView> = {},
): AutoReviewerStatusView {
  return {
    ratchet: {
      active: true,
      previousActiveTools: ["bash"],
      ratchetToolNames: ["clearance_status"],
    },
    project: { trusted: true, cwd: "/repo" },
    mode: "ask",
    reviewer: {
      promptPosture: "reviewer.default",
      configuredModel: null,
      resolvedModel: "openai-codex/gpt-5.5",
      resolvedModelSource: "fallback",
      modelHighCost: true,
      contextMode: "minimal",
      path: "model",
      consequence: "Reviews gray-area calls with the model first.",
    },
    packs: { total: 10, enabled: 7 },
    warnings: ["first warning", "second warning"],
    ...overrides,
  };
}

function span(start: number, end: number): SourceSpan {
  return { start, end };
}
