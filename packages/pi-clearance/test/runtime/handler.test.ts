import type {
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type {
  AuditEntry,
  PolicyDecisionEntry,
  ReviewerDecisionEntry,
} from "../../src/audit/entry.ts";
import type { AuditLogger } from "../../src/audit/logger.ts";
import type {
  ResolvedConfig,
  ResolvedReviewerConfig,
} from "../../src/config/loader.ts";
import { baselinePacks } from "../../src/packs/baseline.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import type { PackageRegistrationSnapshot } from "../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../src/packs/registry.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import {
  createDefaultAnalyzerRegistry,
  type ToolAnalyzerRegistry,
} from "../../src/parse/registry.ts";
import type { BashCommandShape, ToolShape } from "../../src/parse/shape.ts";
import type {
  DecisionEffect,
  EffectivePolicy,
  PolicyRule,
} from "../../src/policy/core.ts";
import { always, inspectable } from "../../src/policy/core.ts";
import {
  type CommandTransformStore,
  createCommandTransformStore,
} from "../../src/runtime/command-transforms.ts";
import {
  createHandleSessionStart,
  createHandleToolCall,
} from "../../src/runtime/handler.ts";
import { createOperatorStatusController } from "../../src/runtime/operator-status.ts";
import type {
  PolicyResolver,
  PolicyResolverResult,
} from "../../src/runtime/policy-cache.ts";
import { createRatchetModeManager } from "../../src/runtime/ratchet-mode.ts";
import type {
  ReviewerHumanAdapter,
  ReviewerModelAdapter,
} from "../../src/runtime/reviewer.ts";
import {
  type RawConversationTurn,
  REVIEWER_CONTEXT_BUNDLE_LABEL,
  type RecentDecisionEntry,
  type ReviewerContextSources,
} from "../../src/runtime/reviewer-context.ts";
import type { ReviewerTokenBudgetGate } from "../../src/runtime/token-budget.ts";
import {
  AUTO_REVIEWER_TRANSFORMS_API_VERSION,
  AUTO_REVIEWER_TRANSFORMS_REGISTER_EVENT,
  AUTO_REVIEWER_TRANSFORMS_REQUEST_EVENT,
} from "../../src/runtime/transform-contract.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../fixtures/resolved-config.ts";

const baselinePolicyPack: { readonly rules: readonly PolicyRule[] } = {
  rules: baselinePacks.flatMap((pack) => pack.rules),
};
const strictPosturePack = baselinePolicyPack;
const permissivePosturePack = baselinePolicyPack;

describe("createHandleToolCall", () => {
  it("allows deterministic allow decisions and logs the decision shape", async () => {
    const audit = captureAudit();
    const shape = bashShape("git status --short");
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(shape),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("allow") }),
        ),
      }),
    );

    await expect(
      handler(bashEvent(), context("allow-session")),
    ).resolves.toEqual({});

    expect(audit.policyEntries).toHaveLength(1);
    expect(audit.policyEntries[0]).toMatchObject({
      entryType: "policy.decision",
      toolCallId: "tool-call-1",
      sessionId: "allow-session",
      projectPath: "/repo",
      toolName: "bash",
      toolInput: { command: "git status --short" },
      shape,
      decision: { effect: "allow" },
    });
  });

  it("does not present review decision notes for deterministic allow decisions", async () => {
    const ctx = context("allow-no-review-note", { includeSetWidget: true });
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "would allow if reviewed",
    });
    const handler = createHandleToolCall(
      deps({
        analyzerRegistry: registryReturning(bashShape("git status --short")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("allow") }),
        ),
        modelAdapter: model,
      }),
    );

    await expect(handler(bashEvent(), ctx)).resolves.toEqual({});

    expect(model.calls).toBe(0);
    expect(ctx.__widgetCalls).toEqual([]);
  });

  it("logs enriched bash shapes in policy decision audit entries", async () => {
    const audit = captureAudit();
    const shape = await analyzedBashShape("touch README.md");
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(shape),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("allow") }),
        ),
      }),
    );

    await expect(
      handler(bashEvent({ command: "touch README.md" }), context("path-audit")),
    ).resolves.toEqual({});

    expect(audit.policyEntries[0]?.shape).toMatchObject({
      kind: "bash",
      pathFacts: {
        baseCwd: "/repo",
        facts: [
          expect.objectContaining({
            raw: "README.md",
            usage: "argument",
            access: "write",
            program: "touch",
            absolutePath: "/repo/README.md",
          }),
        ],
      },
    });
  });

  it("classifies runtime tilde operands with resolved home and concrete scope precedence", async () => {
    const audit = captureAudit();
    const config = resolvedConfig({
      cwd: "/home/user/proj",
      homeDirectory: "/home/user",
      projectScope: {
        ...defaultResolvedProjectScope(),
        roots: ["/home/user/proj"],
        writableDirectories: ["/home/user/proj"],
        tempDirectories: ["/home/user/tmp"],
        deniedDirectories: ["/home/user/proj/secrets"],
      },
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(
          await analyzedBashShape(
            "touch ~/notes ~/proj/file ~/tmp/file ~/proj/secrets/key",
          ),
        ),
        policyResolver: resolverReturning(
          okPolicy({ config, policy: policyWith("allow") }),
        ),
      }),
    );

    await expect(
      handler(
        bashEvent({
          command: "touch ~/notes ~/proj/file ~/tmp/file ~/proj/secrets/key",
        }),
        context("path-home"),
      ),
    ).resolves.toEqual({});

    expect(audit.policyEntries[0]?.shape).toMatchObject({
      kind: "bash",
      pathFacts: {
        facts: [
          expect.objectContaining({
            raw: "~/notes",
            scope: "home",
            absolutePath: "/home/user/notes",
          }),
          expect.objectContaining({
            raw: "~/proj/file",
            scope: "writable-project",
            matchedScopes: ["writable-project", "project", "home"],
            absolutePath: "/home/user/proj/file",
          }),
          expect.objectContaining({
            raw: "~/tmp/file",
            scope: "temp",
            matchedScopes: ["temp", "home"],
            absolutePath: "/home/user/tmp/file",
          }),
          expect.objectContaining({
            raw: "~/proj/secrets/key",
            scope: "denied",
            matchedScopes: ["denied", "writable-project", "project", "home"],
            absolutePath: "/home/user/proj/secrets/key",
          }),
        ],
      },
    });
  });

  it("keeps tilde operands unknown when home is absent or targets another user", async () => {
    const audit = captureAudit();
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(
          await analyzedBashShape("touch ~/notes ~other/file"),
        ),
        policyResolver: resolverReturning(
          okPolicy({
            config: resolvedConfig({ cwd: "/repo" }),
            policy: policyWith("allow"),
          }),
        ),
      }),
    );

    await expect(
      handler(
        bashEvent({ command: "touch ~/notes ~other/file" }),
        context("path-home-missing"),
      ),
    ).resolves.toEqual({});

    expect(audit.policyEntries[0]?.shape).toMatchObject({
      kind: "bash",
      pathFacts: {
        facts: [
          expect.objectContaining({
            raw: "~/notes",
            scope: "unknown",
            unknownReason: "unsupported-shell-literal",
            dynamic: false,
          }),
          expect.objectContaining({
            raw: "~other/file",
            scope: "unknown",
            unknownReason: "unsupported-shell-literal",
            dynamic: true,
          }),
        ],
      },
    });
  });

  it("passes enriched bash shapes to review fallback", async () => {
    const audit = captureAudit();
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "path facts inspected",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(
          await analyzedBashShape("touch file"),
        ),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("review") }),
        ),
        modelAdapter: model,
      }),
    );

    await expect(
      handler(bashEvent({ command: "touch file" }), context("path-review")),
    ).resolves.toEqual({});

    expect(model.calls).toBe(1);
    expect(model.shapes[0]).toMatchObject({
      kind: "bash",
      pathFacts: {
        facts: [expect.objectContaining({ raw: "file", program: "touch" })],
      },
    });
  });

  it("routes analyzed non-bash tools through deterministic policy and logs path facts", async () => {
    const audit = captureAudit();
    const config = resolvedConfig({
      projectScope: {
        ...defaultResolvedProjectScope(),
        roots: ["/repo"],
        writableDirectories: ["/repo"],
      },
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: createDefaultAnalyzerRegistry(),
        policyResolver: resolverReturning({
          ok: true,
          policy: {
            config,
            effectivePolicy: {
              floor: sealedFloor.rules,
              active: strictPosturePack.rules,
            },
            registry: createPackRegistry({ resolvedConfig: config }),
            packageRegistration: emptyPackageRegistrationSnapshot(),
            warnings: [],
          },
        }),
      }),
    );

    await expect(
      handler(
        customEvent("read", { path: "README.md" }),
        context("non-bash-policy"),
      ),
    ).resolves.toEqual({});

    expect(audit.policyEntries).toHaveLength(1);
    expect(audit.reviewerEntries).toHaveLength(0);
    expect(audit.policyEntries[0]).toMatchObject({
      toolName: "read",
      decision: {
        effect: "allow",
        provenance: { packId: "pi.inspect.read" },
      },
      shape: {
        kind: "pi-tool",
        pathFacts: {
          facts: [
            expect.objectContaining({
              raw: "README.md",
              usage: "argument",
              access: "read",
              absolutePath: "/repo/README.md",
            }),
          ],
        },
      },
    });
  });

  it("allows routine project writes and reviews trust-boundary edits with typed visibility", async () => {
    const audit = captureAudit();
    const human = humanAdapter({ available: true, decision: "dismiss" });
    const config = resolvedConfig({
      projectScope: {
        ...defaultResolvedProjectScope(),
        roots: ["/repo"],
        writableDirectories: ["/repo"],
      },
      mode: "ask",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: createDefaultAnalyzerRegistry(),
        policyResolver: resolverReturning({
          ok: true,
          policy: {
            config,
            effectivePolicy: {
              floor: sealedFloor.rules,
              active: strictPosturePack.rules,
            },
            registry: createPackRegistry({ resolvedConfig: config }),
            packageRegistration: emptyPackageRegistrationSnapshot(),
            warnings: [],
          },
        }),
        humanAdapter: human,
      }),
    );

    await expect(
      handler(
        customEvent("write", { path: "src/generated.ts", content: "body" }),
        context("mutation-write-allow"),
      ),
    ).resolves.toEqual({});
    await expect(
      handler(
        customEvent("edit", {
          path: "package.json",
          oldText: "old",
          newText: "new",
        }),
        context("mutation-edit-review"),
      ),
    ).resolves.toEqual({
      block: true,
      reason: expect.stringContaining("Blocked pending review"),
    });

    expect(audit.policyEntries[0]).toMatchObject({
      toolName: "write",
      decision: {
        effect: "allow",
        provenance: { packId: "pi.file.mutate" },
      },
      shape: {
        kind: "pi-tool",
        toolName: "write",
        mutationFacts: { kind: "write" },
        trustBoundary: { kind: "none" },
      },
    });
    expect(audit.policyEntries[0]?.shape).not.toMatchObject({
      kind: "unknown",
    });
    expect(audit.policyEntries[1]).toMatchObject({
      toolName: "edit",
      decision: {
        effect: "review",
        provenance: {
          packId: "pi.file.mutate",
          ruleId: "pi.file.mutate:review-trust-boundary-target",
        },
      },
      shape: {
        kind: "pi-tool",
        toolName: "edit",
        mutationFacts: { kind: "edit" },
        trustBoundary: { kind: "package-script" },
      },
    });
    expect(human.calls).toBe(1);
    expect(human.messages[0]).toContain(
      "trust-boundary target: package-script",
    );
    expect(human.messages[0]).not.toMatch(/unsupported tool|unanalyzed/i);
  });

  it("allows permissive safe-home writes and reviews sensitive-home writes with typed visibility", async () => {
    const audit = captureAudit();
    const human = humanAdapter({ available: true, decision: "dismiss" });
    const config = resolvedConfig({
      cwd: "/repo",
      homeDirectory: "/home/user",
      projectScope: {
        ...defaultResolvedProjectScope(),
        roots: ["/repo"],
        writableDirectories: ["/repo"],
        safeHomeDirectories: ["/home/user/dev"],
      },
      mode: "ask",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: createDefaultAnalyzerRegistry(),
        policyResolver: resolverReturning({
          ok: true,
          policy: {
            config,
            effectivePolicy: {
              floor: sealedFloor.rules,
              active: permissivePosturePack.rules,
            },
            registry: createPackRegistry({ resolvedConfig: config }),
            packageRegistration: emptyPackageRegistrationSnapshot(),
            warnings: [],
          },
        }),
        humanAdapter: human,
      }),
    );

    await expect(
      handler(
        customEvent("write", { path: "~/dev/foo.ts", content: "body" }),
        context("safe-home-write-allow"),
      ),
    ).resolves.toEqual({});
    await expect(
      handler(
        customEvent("write", { path: "~/.ssh/config", content: "host" }),
        context("sensitive-home-write-review"),
      ),
    ).resolves.toEqual({
      block: true,
      reason: expect.stringContaining("Blocked pending review"),
    });

    expect(audit.policyEntries[0]).toMatchObject({
      toolName: "write",
      decision: {
        effect: "allow",
        provenance: {
          packId: "pi.home.safe",
          ruleId: "pi.home.safe:allow-safe-home-mutation",
        },
      },
      shape: {
        kind: "pi-tool",
        toolName: "write",
        pathFacts: {
          facts: [expect.objectContaining({ scope: "safe-home" })],
        },
        trustBoundary: { kind: "none" },
      },
    });
    expect(audit.policyEntries[1]).toMatchObject({
      toolName: "write",
      decision: {
        effect: "review",
        provenance: {
          packId: "pi.home.safe",
          ruleId: "pi.home.safe:review-trust-boundary-home-mutation",
        },
      },
      shape: {
        kind: "pi-tool",
        toolName: "write",
        pathFacts: {
          facts: [expect.objectContaining({ scope: "sensitive-home" })],
        },
        trustBoundary: { kind: "sensitive-home" },
      },
    });
    expect(human.calls).toBe(1);
    expect(human.messages[0]).toContain("sensitive-home");
  });

  it("turns path-fact derivation failures into review diagnostics", async () => {
    const audit = captureAudit();
    const brokenConfig = {
      ...resolvedConfig(),
      cwd: undefined as unknown as string,
    };
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(
          await analyzedBashShape("touch file"),
        ),
        policyResolver: resolverReturning({
          ok: true,
          policy: {
            config: brokenConfig,
            effectivePolicy: policyWith("allow"),
            registry: createPackRegistry({ resolvedConfig: brokenConfig }),
            packageRegistration: emptyPackageRegistrationSnapshot(),
            warnings: [],
          },
        }),
      }),
    );

    await expect(
      handler(bashEvent({ command: "touch file" }), context("path-error")),
    ).resolves.toEqual({
      block: true,
      reason: expect.stringContaining("Blocked pending review"),
    });

    expect(audit.policyEntries[0]?.decision).toMatchObject({
      effect: "review",
      reason: "parse diagnostics present",
    });
    expect(audit.policyEntries[0]?.shape).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "bash:path-facts-error",
          severity: "error",
        }),
      ],
    });
  });

  it("blocks deterministic deny decisions with the policy reason", async () => {
    const audit = captureAudit();
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(bashShape("rm -rf /")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("deny") }),
        ),
      }),
    );

    await expect(
      handler(bashEvent({ command: "rm -rf /" }), context("deny-session")),
    ).resolves.toEqual({
      block: true,
      reason: "test-rule: deny from test policy — /clearance why for details",
    });

    expect(audit.policyEntries[0]?.decision.effect).toBe("deny");
  });

  it.each([
    ["allow", {}, "allow from model"],
    [
      "deny",
      {
        block: true,
        reason:
          "Model auto-reviewer deny: deny from model — /clearance why for details; /clearance allow <plain language> to permit this family",
      },
      "deny from model",
    ],
    [
      "review",
      {
        block: true,
        reason: expect.stringContaining("Blocked pending review"),
      },
      "still uncertain",
    ],
  ] as const)("maps review fallback final %s decisions to Pi results", async (effect, expectedResult, reason) => {
    const audit = captureAudit();
    const model = modelAdapter({ available: true, effect, reason });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(bashShape("pnpm test")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("review") }),
        ),
        modelAdapter: model,
      }),
    );

    await expect(
      handler(bashEvent({ command: "pnpm test" }), context(`review-${effect}`)),
    ).resolves.toEqual(expectedResult);

    expect(model.calls).toBe(1);
    expect(audit.policyEntries[0]?.decision.effect).toBe("review");
    expect(audit.reviewerEntries).toHaveLength(1);
    expect(audit.reviewerEntries[0]?.toolCallId).toBe("tool-call-1");
  });

  it("updates operator status during model review and notifies model reasons", async () => {
    const audit = captureAudit();
    const ctx = context("review-status");
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "project-local command is safe",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(bashShape("pnpm test")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("review") }),
        ),
        modelAdapter: model,
        operatorStatus: createOperatorStatusController({
          ratchetModeManager: createRatchetModeManager(),
        }),
      }),
    );

    await expect(
      handler(bashEvent({ command: "pnpm test" }), ctx),
    ).resolves.toEqual({});

    expect(ctx.__statusCalls).toEqual([
      ["auto-reviewer", "clearance: auto · reviewer model"],
      ["auto-reviewer", "auto-reviewer: reviewing via model · bash"],
      ["auto-reviewer", "clearance: auto · reviewer model"],
    ]);
    // The allow outcome surfaces once, via the decision note (notify fallback
    // when no widget capability), never as a duplicate stream notify.
    expect(ctx.__notifications).toContain("project-local command is safe");
    expect(
      ctx.__notifications.some((n) => n.startsWith("Auto-reviewer:")),
    ).toBe(false);
  });

  it("presents review decision notes through the resolved display preference", async () => {
    const ctx = context("review-note-widget", { includeSetWidget: true });
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "project-local command is safe",
      resolvedModel: { provider: "fake-provider", id: "fake-model" },
    });
    const config = resolvedConfig({
      display: {
        reviewNote: {
          mode: "reason+model",
          showModelLabel: false,
          accent: true,
        },
      },
    });
    const handler = createHandleToolCall(
      deps({
        analyzerRegistry: registryReturning(bashShape("pnpm test")),
        policyResolver: resolverReturning(
          okPolicy({ config, policy: policyWith("review") }),
        ),
        modelAdapter: model,
      }),
    );

    await expect(
      handler(bashEvent({ command: "pnpm test" }), ctx),
    ).resolves.toEqual({});

    expect(ctx.__widgetCalls).toEqual([
      [
        "auto-reviewer:review-note",
        "project-local command is safe\nfake-provider/fake-model",
      ],
    ]);
  });

  it("keeps runtime decisions unchanged when operator status UI throws", async () => {
    const ctx = context("review-status-throws", { setStatusThrows: true });
    const model = modelAdapter({
      available: true,
      effect: "deny",
      reason: "unsafe command",
    });
    const handler = createHandleToolCall(
      deps({
        analyzerRegistry: registryReturning(bashShape("rm -rf dist")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("review") }),
        ),
        modelAdapter: model,
        operatorStatus: createOperatorStatusController({
          ratchetModeManager: createRatchetModeManager(),
        }),
      }),
    );

    await expect(
      handler(bashEvent({ command: "rm -rf dist" }), ctx),
    ).resolves.toEqual({
      block: true,
      reason:
        "Model auto-reviewer deny: unsafe command — /clearance why for details; /clearance allow <plain language> to permit this family",
    });
    expect(model.calls).toBe(1);
    // Single-surface deny contract: the block reason is the only outcome
    // surface (the session-once reviewer config line is not an outcome).
    expect(
      ctx.__notifications.filter((n) => !n.startsWith("Clearance:")),
    ).toEqual([]);
  });

  it("dispatches review decisions through an injected human adapter when model review is unavailable", async () => {
    const audit = captureAudit();
    const human = humanAdapter({ available: true, decision: "allow" });
    const model = modelAdapter({
      available: false,
      effect: "review",
      reason: "model unavailable",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(bashShape("pnpm test")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("review") }),
        ),
        humanAdapter: human,
        modelAdapter: model,
      }),
    );

    await expect(
      handler(bashEvent({ command: "pnpm test" }), context("review-human")),
    ).resolves.toEqual({});

    expect(model.calls).toBe(0);
    expect(human.calls).toBe(1);
    expect(audit.reviewerEntries[0]?.reviewerMode).toBe("human");
    expect(audit.reviewerEntries[0]?.finalDecision.effect).toBe("allow");
  });

  it("surfaces a human reviewer deny exactly once with prose-only message", async () => {
    const audit = captureAudit();
    const ctx = context("review-human-deny");
    const human = humanAdapter({ available: true, decision: "deny" });
    const model = modelAdapter({
      available: false,
      effect: "review",
      reason: "model unavailable",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(bashShape("rm -rf dist")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("review") }),
        ),
        humanAdapter: human,
        modelAdapter: model,
      }),
    );

    await expect(
      handler(bashEvent({ command: "rm -rf dist" }), ctx),
    ).resolves.toEqual({
      block: true,
      reason:
        "Human reviewer denied the tool call — /clearance why for details; /clearance allow <plain language> to permit this family",
    });

    // The human review card is prose-only: no JSON dumps, ever.
    expect(human.messages).toHaveLength(1);
    expect(human.messages[0]).not.toContain("```json");
    expect(human.messages[0]).not.toContain("### Raw tool input");
    expect(human.messages[0]).not.toContain("### Parsed shape");
    expect(human.messages[0]).toContain("**What it does**");
    // Single-surface deny: no additional outcome notify or note.
    expect(
      ctx.__notifications.filter((n) => !n.startsWith("Clearance:")),
    ).toEqual([]);
    expect(audit.reviewerEntries[0]?.finalDecision.effect).toBe("deny");
  });

  it("passes an injected token-budget gate into review dispatch", async () => {
    const audit = captureAudit();
    const human = humanAdapter({ available: true, decision: "allow" });
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "would call model",
    });
    const tokenBudgetGate: ReviewerTokenBudgetGate = {
      isExhausted: () => true,
      record: () => {},
    };
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(bashShape("pnpm test")),
        policyResolver: resolverReturning(
          okPolicy({
            policy: policyWith("review"),
            reviewer: { tokenBudget: { window: "1h", limit: 1 } },
          }),
        ),
        humanAdapter: human,
        modelAdapter: model,
        tokenBudgetGate,
      }),
    );

    await expect(
      handler(bashEvent({ command: "pnpm test" }), context("review-budget")),
    ).resolves.toEqual({});

    expect(model.calls).toBe(0);
    expect(human.calls).toBe(1);
    expect(audit.reviewerEntries[0]?.reviewerMode).toBe("human");
    expect(audit.reviewerEntries[0]?.budgetExhausted).toBe(true);
  });

  it("passes injected recent-context sources into review dispatch", async () => {
    const audit = captureAudit();
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "recent context helped",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(bashShape("pnpm test")),
        policyResolver: resolverReturning(
          okPolicy({
            policy: policyWith("review"),
            reviewer: { contextMode: "recentContext" },
          }),
        ),
        modelAdapter: model,
        createContextSources: () =>
          contextSources({
            decisions: [recentDecision("recent policy review")],
            conversationTurns: [conversationTurn("user", "run the tests")],
          }),
      }),
    );

    await expect(
      handler(
        bashEvent({ command: "pnpm test" }),
        context("review-recent-context"),
      ),
    ).resolves.toEqual({});

    expect(model.calls).toBe(1);
    expect(model.prompts[0]).toContain(REVIEWER_CONTEXT_BUNDLE_LABEL);
    expect(model.prompts[0]).toContain("recent policy review");
    expect(model.prompts[0]).toContain("run the tests");
    expect(audit.reviewerEntries[0]?.contextMode).toBe("recentContext");
    expect(audit.reviewerEntries[0]?.recentContextAttached).toBe(true);
  });

  it.each([
    { posture: "allow" as const, result: {}, modelCalls: 0 },
    {
      posture: "deny" as const,
      result: {
        block: true,
        reason: "unknown tool: mystery — /clearance why for details",
      },
      modelCalls: 0,
    },
    { posture: "review" as const, result: {}, modelCalls: 1 },
  ])("applies unknown-tool posture $posture to unsupported non-bash tools", async ({
    posture,
    result,
    modelCalls,
  }) => {
    const audit = captureAudit();
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "safe read",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(unknownShape("mystery")),
        policyResolver: resolverReturning(
          okPolicy({ unknownToolPosture: posture }),
        ),
        modelAdapter: model,
      }),
    );

    await expect(
      handler(
        customEvent("mystery", { path: "README.md" }),
        context(`unknown-${posture}`),
      ),
    ).resolves.toEqual(result);

    expect(model.calls).toBe(modelCalls);
    expect(audit.policyEntries).toHaveLength(1);
    expect(audit.policyEntries[0]).toMatchObject({
      toolName: "mystery",
      decision: {
        effect: posture,
        reason: "unknown tool: mystery",
        provenance: { source: "default" },
      },
      shape: { kind: "unknown", toolName: "mystery" },
    });
  });

  it("fails closed and logs a policy decision when policy resolution fails", async () => {
    const audit = captureAudit();
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "would allow",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        policyResolver: resolverReturning({ ok: false, reason: "bad config" }),
        modelAdapter: model,
      }),
    );

    await expect(handler(bashEvent(), context("policy-fail"))).resolves.toEqual(
      {
        block: true,
        reason: "policy resolution failed: bad config",
      },
    );

    expect(model.calls).toBe(0);
    expect(audit.policyEntries).toHaveLength(1);
    expect(audit.policyEntries[0]).toMatchObject({
      toolCallId: "tool-call-1",
      toolName: "bash",
      decision: {
        effect: "review",
        reason: "policy resolution failed: bad config",
      },
    });
    expect(audit.policyEntries[0]?.shape).toBeUndefined();
  });

  it("catches analyzer exceptions and blocks", async () => {
    const audit = captureAudit();
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: throwingRegistry(),
        policyResolver: resolverReturning(okPolicy()),
      }),
    );

    await expect(
      handler(bashEvent(), context("analyzer-throw")),
    ).resolves.toEqual({
      block: true,
      reason: "pi-clearance handler error: analyzer unavailable",
    });

    expect(audit.policyEntries[0]?.decision).toMatchObject({
      effect: "review",
      reason: "pi-clearance handler error: analyzer unavailable",
    });
  });

  it("blocks analyzer-error diagnostic bash shapes even when unknown-tool posture is allow", async () => {
    const audit = captureAudit();
    const model = modelAdapter({
      available: true,
      effect: "allow",
      reason: "would allow",
    });
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning({
          ...bashShape("x"),
          diagnostics: [
            {
              code: "tool:analyzer-error",
              severity: "error",
              message: "Tool analyzer failed closed: boom",
            },
          ],
        }),
        policyResolver: resolverReturning(
          okPolicy({ unknownToolPosture: "allow" }),
        ),
        modelAdapter: model,
      }),
    );

    await expect(
      handler(bashEvent({ command: "x" }), context("analyzer-error-shape")),
    ).resolves.toEqual({
      block: true,
      reason: "Tool analyzer failed closed: boom",
    });

    expect(model.calls).toBe(0);
    expect(audit.policyEntries[0]?.decision.effect).toBe("review");
    expect(audit.policyEntries[0]?.shape).toMatchObject({
      diagnostics: [expect.objectContaining({ code: "tool:analyzer-error" })],
    });
  });
});

describe("createHandleSessionStart", () => {
  it("resolves policy and shows reviewer config once when UI is available", async () => {
    const ctx = context("session-start-visible", { hasUI: true });
    const handler = createHandleSessionStart({
      policyResolver: resolverReturning(okPolicy()),
    });

    await handler(sessionStartEvent(), ctx);
    await handler(sessionStartEvent(), ctx);

    expect(ctx.__notifications).toHaveLength(1);
    expect(ctx.__notifications[0]).toContain("Clearance: auto");
    expect(ctx.__notifications[0]).toContain("/clearance status");
  });

  it("refreshes the operator status on session start", async () => {
    const ctx = context("session-start-status", { hasUI: true });
    const handler = createHandleSessionStart({
      policyResolver: resolverReturning(okPolicy()),
      operatorStatus: createOperatorStatusController({
        ratchetModeManager: createRatchetModeManager(),
      }),
    });

    await handler(sessionStartEvent(), ctx);

    expect(ctx.__statusCalls).toEqual([
      ["auto-reviewer", "clearance: auto · reviewer model"],
    ]);
  });

  it("skips reviewer visibility when UI is unavailable", async () => {
    const ctx = context("session-start-headless", { hasUI: false });
    const handler = createHandleSessionStart({
      policyResolver: resolverReturning(okPolicy()),
    });

    await handler(sessionStartEvent(), ctx);

    expect(ctx.__notifications).toHaveLength(0);
  });

  it("runs beforeResolve before policy resolution", async () => {
    const order: string[] = [];
    const ctx = context("session-start-before-resolve", { hasUI: true });
    const handler = createHandleSessionStart({
      policyResolver: {
        async resolve(): Promise<PolicyResolverResult> {
          order.push("resolve");
          return okPolicy();
        },
        invalidate() {
          order.push("invalidate");
        },
      },
      beforeResolve: () => {
        order.push("beforeResolve");
      },
    });

    await handler(sessionStartEvent(), ctx);

    expect(order).toEqual(["beforeResolve", "resolve"]);
    expect(ctx.__notifications).toHaveLength(1);
  });

  it("does not throw when policy resolution fails or rejects", async () => {
    const failingHandler = createHandleSessionStart({
      policyResolver: resolverReturning({ ok: false, reason: "bad config" }),
    });
    const throwingHandler = createHandleSessionStart({
      policyResolver: {
        async resolve(): Promise<never> {
          throw new Error("resolver exploded");
        },
        invalidate() {},
      },
    });

    await expect(
      failingHandler(sessionStartEvent(), context("session-start-fail")),
    ).resolves.toBeUndefined();
    await expect(
      throwingHandler(sessionStartEvent(), context("session-start-throw")),
    ).resolves.toBeUndefined();
  });
});

interface CapturingAuditLogger extends AuditLogger {
  readonly entries: readonly AuditEntry[];
  readonly policyEntries: readonly PolicyDecisionEntry[];
  readonly reviewerEntries: readonly ReviewerDecisionEntry[];
}

function captureAudit(): CapturingAuditLogger {
  const entries: AuditEntry[] = [];
  return {
    entries,
    get policyEntries() {
      return entries.filter(
        (entry): entry is PolicyDecisionEntry =>
          entry.entryType === "policy.decision",
      );
    },
    get reviewerEntries() {
      return entries.filter(
        (entry): entry is ReviewerDecisionEntry =>
          entry.entryType === "reviewer.decision",
      );
    },
    async log(entry): Promise<void> {
      entries.push(entry);
    },
  };
}

function deps(overrides: Partial<HandlerDepsForTest> = {}): HandlerDepsForTest {
  const humanAdapterValue =
    overrides.humanAdapter ??
    humanAdapter({ available: false, decision: "dismiss" });
  const modelAdapterValue =
    overrides.modelAdapter ??
    modelAdapter({ available: false, effect: "review", reason: "unavailable" });
  return {
    analyzerRegistry: registryReturning(bashShape("git status --short")),
    audit: captureAudit(),
    policyResolver: resolverReturning(okPolicy()),
    createAdapters: () => ({
      humanAdapter: humanAdapterValue,
      modelAdapter: modelAdapterValue,
    }),
    ...overrides,
  };
}

type HandlerDepsForTest = Parameters<typeof createHandleToolCall>[0] & {
  readonly humanAdapter?: ReviewerHumanAdapter;
  readonly modelAdapter?: ReviewerModelAdapter;
};

function contextSources(raw: {
  readonly decisions: readonly RecentDecisionEntry[];
  readonly conversationTurns: readonly RawConversationTurn[];
}): ReviewerContextSources {
  return {
    decisions: {
      readRecent() {
        return { items: raw.decisions, warnings: [] };
      },
    },
    conversation: {
      readRecent() {
        return { items: raw.conversationTurns, warnings: [] };
      },
    },
  };
}

function recentDecision(reason: string): RecentDecisionEntry {
  return {
    timestamp: new Date().toISOString(),
    entryType: "policy.decision",
    toolName: "bash",
    effect: "review",
    reason,
    command: "pnpm test",
  };
}

function conversationTurn(
  role: RawConversationTurn["role"],
  text: string,
): RawConversationTurn {
  return {
    role,
    text,
    timestamp: "2026-06-25T12:01:00.000Z",
  };
}

function resolverReturning(result: PolicyResolverResult): PolicyResolver {
  return { resolve: async () => result, invalidate() {} };
}

function registryReturning(shape: ToolShape): ToolAnalyzerRegistry {
  return { analyze: async () => shape };
}

function throwingRegistry(): ToolAnalyzerRegistry {
  return {
    async analyze(): Promise<never> {
      throw new Error("analyzer unavailable");
    },
  };
}

interface FakeModelAdapter extends ReviewerModelAdapter {
  readonly calls: number;
  readonly prompts: readonly string[];
  readonly shapes: readonly ToolShape[];
}

function modelAdapter(options: {
  readonly available: boolean;
  readonly effect: DecisionEffect;
  readonly reason: string;
  readonly resolvedModel?: { readonly provider: string; readonly id: string };
}): FakeModelAdapter {
  let calls = 0;
  const prompts: string[] = [];
  const shapes: ToolShape[] = [];
  return {
    kind: "model",
    isAvailable: () => options.available,
    async review(reviewOptions) {
      calls += 1;
      prompts.push(reviewOptions.prompt);
      shapes.push(reviewOptions.shape);
      return {
        effect: options.effect,
        reason: options.reason,
        ...(options.resolvedModel === undefined
          ? {}
          : {
              resolvedModel: options.resolvedModel,
              resolvedModelSource: "fallback" as const,
            }),
      };
    },
    get calls() {
      return calls;
    },
    get prompts() {
      return prompts;
    },
    get shapes() {
      return shapes;
    },
  };
}

interface FakeHumanAdapter extends ReviewerHumanAdapter {
  readonly calls: number;
  readonly messages: readonly string[];
}

function humanAdapter(options: {
  readonly available: boolean;
  readonly decision: "allow" | "deny" | "dismiss";
}): FakeHumanAdapter {
  let calls = 0;
  const messages: string[] = [];
  return {
    kind: "human",
    isAvailable: () => options.available,
    async approve(reviewOptions) {
      calls += 1;
      messages.push(reviewOptions.message);
      return { decision: options.decision };
    },
    get calls() {
      return calls;
    },
    get messages() {
      return messages;
    },
  };
}

function okPolicy(
  options: {
    readonly config?: ResolvedConfig;
    readonly policy?: EffectivePolicy;
    readonly unknownToolPosture?: DecisionEffect;
    readonly reviewer?: Partial<ResolvedReviewerConfig>;
  } = {},
): PolicyResolverResult {
  const config =
    options.config ??
    resolvedConfig({
      ...(options.unknownToolPosture === undefined
        ? {}
        : { unknownToolPosture: options.unknownToolPosture }),
      ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    });
  return {
    ok: true,
    policy: {
      config,
      effectivePolicy: options.policy ?? policyWith("allow"),
      registry: createPackRegistry({ resolvedConfig: config }),
      packageRegistration: emptyPackageRegistrationSnapshot(),
      warnings: [],
    },
  };
}

function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return {
    requestId: null,
    packs: [],
    issues: [],
  };
}

function resolvedConfig(
  options: {
    readonly cwd?: string;
    readonly homeDirectory?: string;
    readonly unknownToolPosture?: DecisionEffect;
    readonly mode?: ResolvedConfig["mode"];
    readonly reviewer?: Partial<ResolvedReviewerConfig>;
    readonly projectScope?: ResolvedConfig["projectScope"];
    readonly display?: ResolvedConfig["display"];
  } = {},
): ResolvedConfig {
  return {
    version: 1,
    mode: options.mode ?? "auto",
    cwd: options.cwd ?? "/repo",
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
    unknownToolPosture: options.unknownToolPosture ?? "review",
    projectScope: options.projectScope ?? defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    display: options.display ?? defaultResolvedDisplay(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted: false,
    },
    reviewer: { ...defaultResolvedReviewer(), ...options.reviewer },
    errors: [],
    warnings: [],
  };
}

function policyWith(effect: DecisionEffect): EffectivePolicy {
  return { active: [rule(effect)] };
}

function rule(effect: DecisionEffect): PolicyRule {
  return {
    id: "test-rule",
    effect,
    match: inspectable(always()),
    reason: `${effect} from test policy`,
    provenance: { source: "generated", ruleId: "test-rule" },
  };
}

async function analyzedBashShape(
  rawCommand: string,
): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(rawCommand);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

function bashShape(rawCommand: string): BashCommandShape {
  return {
    kind: "bash",
    rawCommand,
    blocks: [],
    stages: [],
    diagnostics: [],
  };
}

function unknownShape(toolName: string): ToolShape {
  return {
    kind: "unknown",
    toolName,
    rawInput: { path: "README.md" },
    diagnostics: [],
  };
}

function bashEvent(
  input: { readonly command: string } = { command: "git status --short" },
): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "tool-call-1",
    toolName: "bash",
    input,
  };
}

function customEvent(
  toolName: string,
  input: Record<string, unknown>,
): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "tool-call-1",
    toolName,
    input,
  };
}

function sessionStartEvent(): SessionStartEvent {
  return { type: "session_start", reason: "startup" };
}

type FakeContext = ExtensionContext & {
  readonly __notifications: readonly string[];
  readonly __statusCalls: readonly (readonly [string, string | undefined])[];
  readonly __widgetCalls: readonly (readonly [string, string | undefined])[];
};

function context(
  sessionId: string,
  options: {
    readonly hasUI?: boolean;
    readonly setStatusThrows?: boolean;
    readonly includeSetWidget?: boolean;
  } = {},
): FakeContext {
  const notifications: string[] = [];
  const statusCalls: (readonly [string, string | undefined])[] = [];
  const widgetCalls: (readonly [string, string | undefined])[] = [];
  const ui: Record<string, unknown> = {
    async confirm(): Promise<boolean> {
      return false;
    },
    notify(message: string): void {
      notifications.push(message);
    },
    setStatus(key: string, value: string | undefined): void {
      if (options.setStatusThrows === true) {
        throw new Error("status failed");
      }
      statusCalls.push([key, value]);
    },
  };
  if (options.includeSetWidget === true) {
    ui.setWidget = (key: string, content: string | undefined): void => {
      widgetCalls.push([key, content]);
    };
  }

  return {
    hasUI: options.hasUI ?? true,
    cwd: "/repo",
    model: { id: "fake-model", provider: "fake-provider" },
    signal: undefined,
    ui,
    sessionManager: { getSessionId: () => sessionId },
    isProjectTrusted: () => false,
    __notifications: notifications,
    __statusCalls: statusCalls,
    __widgetCalls: widgetCalls,
  } as unknown as FakeContext;
}

// --- Command transform integration -------------------------------------------
//
// The transform hook lets a rewriter (e.g. RTK) rewrite an APPROVED bash command
// for execution while the reviewer still judges the ORIGINAL. These tests pin
// the load-order-independent contract: transforms run only on allow, see the
// original command, and fail open.

interface FakeEventBus {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
}

function fakeEventBus(): FakeEventBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel, handler) {
      let set = handlers.get(channel);
      if (set === undefined) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      const handlersForChannel = set;
      return () => handlersForChannel.delete(handler);
    },
    emit(channel, data) {
      const set = handlers.get(channel);
      if (set !== undefined) {
        for (const h of set) h(data);
      }
    },
  };
}

/** A contributor that registers one transform via the event bus. */
function registerTransform(
  bus: FakeEventBus,
  id: string,
  fn: (
    command: string,
  ) => Promise<{ command?: string; skipped?: string; error?: string }>,
): void {
  bus.on(AUTO_REVIEWER_TRANSFORMS_REQUEST_EVENT, (data) => {
    const request = data as { readonly requestId?: string };
    bus.emit(AUTO_REVIEWER_TRANSFORMS_REGISTER_EVENT, {
      apiVersion: AUTO_REVIEWER_TRANSFORMS_API_VERSION,
      requestId: request.requestId,
      id,
      transform: fn,
    });
  });
}

function transformStoreFromBus(bus: FakeEventBus): CommandTransformStore {
  const store = createCommandTransformStore({ events: bus });
  store.collect("startup");
  return store;
}

describe("createHandleToolCall command transforms", () => {
  it("runs an approved command through a registered transform and writes the result back", async () => {
    const bus = fakeEventBus();
    registerTransform(bus, "rtk", async (command) => ({
      command: `rtk rewrite ${command}`,
    }));
    const audit = captureAudit();
    const handler = createHandleToolCall(
      deps({
        audit,
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("allow") }),
        ),
        transformStore: transformStoreFromBus(bus),
      }),
    );

    const event = bashEvent({ command: "git status --short" });
    await expect(handler(event, context("t-session"))).resolves.toEqual({});

    // The transform rewrote the command that will execute.
    expect((event.input as { command: string }).command).toBe(
      "rtk rewrite git status --short",
    );
    // The audit logged the ORIGINAL command — the reviewer judged what the
    // agent typed, not the rewritten form.
    expect(audit.policyEntries[0]?.toolInput).toEqual({
      command: "git status --short",
    });
  });

  it("does not transform a denied command", async () => {
    const bus = fakeEventBus();
    const seen: string[] = [];
    registerTransform(bus, "rtk", async (command) => {
      seen.push(command);
      return { command: "SHOULD NOT RUN" };
    });
    const audit = captureAudit();
    const handler = createHandleToolCall(
      deps({
        audit,
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("deny") }),
        ),
        transformStore: transformStoreFromBus(bus),
      }),
    );

    const event = bashEvent({ command: "rm -rf /" });
    const result = await handler(event, context("deny-session"));
    expect(result).toEqual({ block: true, reason: expect.any(String) });
    expect((event.input as { command: string }).command).toBe("rm -rf /");
    expect(seen).toEqual([]);
  });

  it("runs a model-reviewed allow through the transform (reviewer sees original)", async () => {
    const bus = fakeEventBus();
    registerTransform(bus, "rtk", async (command) => ({
      command: `compressed:${command}`,
    }));
    const audit = captureAudit();
    const handler = createHandleToolCall(
      deps({
        audit,
        analyzerRegistry: registryReturning(bashShape("pnpm test")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("review") }),
        ),
        modelAdapter: modelAdapter({
          available: true,
          effect: "allow",
          reason: "ok",
        }),
        transformStore: transformStoreFromBus(bus),
      }),
    );

    const event = bashEvent({ command: "pnpm test" });
    await expect(handler(event, context("review-allow"))).resolves.toEqual({});
    expect((event.input as { command: string }).command).toBe(
      "compressed:pnpm test",
    );
    // Reviewer audit recorded the original command (transforms ran after).
    const reviewerEntry = audit.reviewerEntries[0];
    expect(reviewerEntry?.toolInput).toEqual({ command: "pnpm test" });
  });

  it("fails open: a throwing transform preserves the original command", async () => {
    const bus = fakeEventBus();
    registerTransform(bus, "broken", async () => {
      throw new Error("rtk crashed");
    });
    const audit = captureAudit();
    const handler = createHandleToolCall(
      deps({
        audit,
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("allow") }),
        ),
        transformStore: transformStoreFromBus(bus),
      }),
    );

    const event = bashEvent({ command: "ls -la" });
    await expect(handler(event, context("fail-open"))).resolves.toEqual({});
    // Transform failed; the original allowed command still runs.
    expect((event.input as { command: string }).command).toBe("ls -la");
  });

  it("applies transforms in registration order, each seeing the prior result (v1 chaining)", async () => {
    const bus = fakeEventBus();
    // v1 composition: transforms run in registration order and each sees the
    // evolving command (the prior transform's output, or the original for the
    // first). The final command is what runs.
    const seen: string[] = [];
    registerTransform(bus, "upper", async (command) => {
      seen.push(command);
      return { command: command.toUpperCase() };
    });
    registerTransform(bus, "prefix", async (command) => {
      seen.push(command);
      return { command: `pre:${command}` };
    });
    const handler = createHandleToolCall(
      deps({
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("allow") }),
        ),
        transformStore: transformStoreFromBus(bus),
      }),
    );

    const event = bashEvent({ command: "git status" });
    await handler(event, context("compose"));
    // First saw the original; second saw the first's output (chained).
    expect(seen).toEqual(["git status", "GIT STATUS"]);
    expect((event.input as { command: string }).command).toBe("pre:GIT STATUS");
  });

  it("leaves non-bash tools untouched even with transforms registered", async () => {
    const bus = fakeEventBus();
    const seen: string[] = [];
    registerTransform(bus, "rtk", async (command) => {
      seen.push(command);
      return { command: "rewritten" };
    });
    const handler = createHandleToolCall(
      deps({
        analyzerRegistry: registryReturning(unknownShape("read")),
        policyResolver: resolverReturning(
          okPolicy({ policy: policyWith("review") }),
        ),
        modelAdapter: modelAdapter({
          available: true,
          effect: "allow",
          reason: "ok",
        }),
        transformStore: transformStoreFromBus(bus),
      }),
    );

    const event = customEvent("read", { path: "README.md" });
    await expect(handler(event, context("non-bash"))).resolves.toEqual({});
    expect(seen).toEqual([]);
    expect(event.input).toEqual({ path: "README.md" });
  });
});
