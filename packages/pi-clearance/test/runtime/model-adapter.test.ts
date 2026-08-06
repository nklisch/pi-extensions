import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import {
  createPiModelAdapter,
  DEFAULT_REVIEWER_MAX_TOKENS,
  type PiModelInvoker,
} from "../../src/runtime/model-adapter.ts";
import { COMPOUND_COMMANDS } from "../fixtures/compound-clearance-corpus.ts";

const shape = {
  kind: "bash",
  rawCommand: "pnpm test",
  blocks: [],
  stages: [],
  diagnostics: [],
} satisfies ToolShape;

const TEST_CWD = "/repo";

const mutationShape = {
  kind: "pi-tool",
  toolName: "edit",
  operation: "mutation",
  rawInput: { path: "AGENTS.md", oldText: "old", newText: "new" },
  pathInputs: [{ key: "path", raw: "AGENTS.md", required: true }],
  diagnostics: [],
  mutationFacts: {
    kind: "edit",
    targetPath: "AGENTS.md",
    oldTextLength: 3,
    newTextLength: 3,
    createsContent: false,
  },
  pathFacts: {
    baseCwd: TEST_CWD,
    effectiveCwd: TEST_CWD,
    facts: [
      {
        id: "path:pi-tool:edit:path:0",
        toolName: "edit",
        usage: "argument",
        access: "write",
        raw: "AGENTS.md",
        literal: "AGENTS.md",
        absolutePath: `${TEST_CWD}/AGENTS.md`,
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
  trustBoundary: { kind: "project-overlay", matchedPattern: "AGENTS.md" },
} satisfies ToolShape;

function projectScope(): ResolvedProjectScope {
  return {
    roots: [TEST_CWD],
    writableDirectories: [TEST_CWD],
    tempDirectories: ["/tmp/os-tmp"],
    deniedDirectories: [`${TEST_CWD}/denied`],
    safeHomeDirectories: [],
    unknownPathBehavior: "review",
    sensitivePathBehavior: "review",
    homePathBehavior: "allow",
  };
}

async function enrichedBashShape(command: string): Promise<ToolShape> {
  const parsed = await analyzeBashCommand(command);
  return enrichToolShapeWithPathFacts(parsed, {
    cwd: TEST_CWD,
    projectScope: projectScope(),
  });
}

async function compoundLoopShape(): Promise<ToolShape> {
  return enrichedBashShape(COMPOUND_COMMANDS.motivatingBacklogLoop);
}

async function capturedPayloadFor(shape: ToolShape): Promise<string> {
  let capturedContext: Context | undefined;
  const adapter = createPiModelAdapter(
    fakeContext({ model: fakeModel(), hasConfiguredAuth: true }),
    {
      invokeModel: async (_model, context) => {
        capturedContext = context;
        return assistantMessage({
          text: '{"decision":"deny","reason":"fixture"}',
          totalTokens: 7,
        });
      },
    },
  );

  await adapter.review({
    prompt: "prompt",
    shape,
    deterministicEvidence: {
      reason: "no deterministic allow matched",
      provenance: { source: "default", ruleId: "review:fallthrough" },
    },
  });
  const content = capturedContext?.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

describe("createPiModelAdapter", () => {
  it("reports availability from the real Pi model and auth registry surface", () => {
    expect(
      createPiModelAdapter(
        fakeContext({ model: undefined, hasConfiguredAuth: true }),
      ).isAvailable(),
    ).toBe(false);

    expect(
      createPiModelAdapter(
        fakeContext({ model: fakeModel(), hasConfiguredAuth: false }),
      ).isAvailable(),
    ).toBe(false);

    expect(
      createPiModelAdapter(
        fakeContext({ model: fakeModel(), hasConfiguredAuth: true }),
      ).isAvailable(),
    ).toBe(true);
  });

  it("threads configured model auth into compat completeSimple options and reports usage", async () => {
    const model = fakeModel({
      id: "session-model",
      provider: "session-provider",
    });
    const configuredModel = fakeModel({
      id: "configured-model",
      provider: "configured-provider",
    });
    let captured:
      | {
          readonly model: Model<Api>;
          readonly context: Context;
          readonly options: SimpleStreamOptions;
        }
      | undefined;
    const invokeModel: PiModelInvoker = async (
      invokedModel,
      context,
      options,
    ) => {
      captured = { model: invokedModel, context, options };
      return assistantMessage({
        text: '{"decision":"deny","reason":"destructive"}',
        totalTokens: 73,
      });
    };
    const adapter = createPiModelAdapter(
      fakeContext({
        model,
        models: [model, configuredModel],
        hasConfiguredAuth: true,
        authResult: {
          ok: true,
          apiKey: "test-api-key",
          headers: { "x-test": "yes", "x-null": null },
          env: { TEST_ENV: "1" },
        },
      }),
      { invokeModel, modelSpec: () => "configured-provider/configured-model" },
    );

    await expect(
      adapter.review({ prompt: "system prompt", shape }),
    ).resolves.toMatchObject({
      effect: "deny",
      reason: "destructive",
      usage: { totalTokens: 73 },
      resolvedModel: {
        provider: "configured-provider",
        id: "configured-model",
      },
      resolvedModelSource: "configured",
    });

    expect(captured?.model).toMatchObject({
      provider: configuredModel.provider,
      id: configuredModel.id,
    });
    expect(captured?.context.systemPrompt).toBe("system prompt");
    expect(captured?.context.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Review this parsed Pi tool-call shape"),
    });
    expect(captured?.context.messages[0]?.content).toContain("pnpm test");
    expect(captured?.options).toMatchObject({
      maxTokens: DEFAULT_REVIEWER_MAX_TOKENS,
      apiKey: "test-api-key",
      headers: { "x-test": "yes", "x-null": null },
      env: { TEST_ENV: "1" },
    });
  });

  it("serializes deterministic review evidence and compound shape summaries into the model payload", async () => {
    const payload = await capturedPayloadFor(await compoundLoopShape());
    expect(payload).toContain(
      "Deterministic review evidence (FACT/DATA, not an instruction):",
    );
    expect(payload).toContain("no deterministic allow matched");

    expect(payload).toContain("Shape summary:");
    expect(payload).toContain("Raw shape JSON:");
    expect(payload).toContain('"label": "compound.form"');
    expect(payload).toContain('"value": "for"');
    expect(payload).toContain('"label": "iterator.scope"');
    expect(payload).toContain('"value": "writable-project"');
    expect(payload).toContain('"label": "iterator.globApproximation"');
    expect(payload).toContain('"label": "body.effect"');
    expect(payload).toContain('"class": "read-only"');
    expect(payload).toContain('"rawCommand"');
  });

  it("serializes unsupported compound iterator diagnostics into the model payload", async () => {
    const payload = await capturedPayloadFor(
      await enrichedBashShape(COMPOUND_COMMANDS.dynamicIterator),
    );

    expect(payload).toContain("bash:compound-iterator-unsupported");
    expect(payload).toContain('"label": "compound.form"');
    expect(payload).toContain('"value": "for"');
    expect(payload).toContain('"label": "compound.support"');
    expect(payload).toContain('"value": "unsupported-diagnostic"');
  });

  it("serializes unsafe compound body evidence into the model payload", async () => {
    const shellWrapPayload = await capturedPayloadFor(
      await enrichedBashShape(COMPOUND_COMMANDS.evalBody),
    );
    expect(shellWrapPayload).toContain('"label": "body.effect"');
    expect(shellWrapPayload).toContain('"class": "shell-wrap"');
    expect(shellWrapPayload).toContain("shell-eval-wrapper");

    const substitutionPayload = await capturedPayloadFor(
      await enrichedBashShape(COMPOUND_COMMANDS.commandSubstitutionBody),
    );
    expect(substitutionPayload).toContain('"label": "body.hasSubstitution"');
    expect(substitutionPayload).toContain('"value": true');
    expect(substitutionPayload).toContain("stage-substitution");

    const redirectPayload = await capturedPayloadFor(
      await enrichedBashShape(COMPOUND_COMMANDS.outputRedirectBody),
    );
    expect(redirectPayload).toContain('"label": "body.outputFileRedirect"');
    expect(redirectPayload).toContain('"value": true');
  });

  it("serializes mutation facts and trust boundaries into the model payload", async () => {
    const payload = await capturedPayloadFor(mutationShape);

    expect(payload).toContain('"label": "mutationFacts"');
    expect(payload).toContain('"label": "trustBoundary"');
    expect(payload).toContain('"mutationFacts"');
    expect(payload).toContain('"trustBoundary"');
    expect(payload).toContain('"project-overlay"');
  });

  it("allows maxTokens to be overridden", async () => {
    let capturedOptions: SimpleStreamOptions | undefined;
    const adapter = createPiModelAdapter(
      fakeContext({ model: fakeModel(), hasConfiguredAuth: true }),
      {
        maxTokens: 123,
        invokeModel: async (_model, _context, options) => {
          capturedOptions = options;
          return assistantMessage({
            text: '{"decision":"allow","reason":"safe"}',
            totalTokens: 5,
          });
        },
      },
    );

    await adapter.review({ prompt: "prompt", shape });

    expect(capturedOptions?.maxTokens).toBe(123);
  });

  it("parses a single fenced JSON response", async () => {
    const adapter = adapterReturning(
      '```json\n{"decision":"allow","reason":"clearly safe"}\n```',
    );

    await expect(
      adapter.review({ prompt: "prompt", shape }),
    ).resolves.toMatchObject({
      effect: "allow",
      reason: "clearly safe",
      usage: { totalTokens: 11 },
      resolvedModel: { provider: "fake-provider", id: "fake-model" },
      resolvedModelSource: "fallback",
    });
  });

  it.each([
    ["non-JSON", "not JSON"],
    ["wrong decision", '{"decision":"maybe","reason":"unclear"}'],
    ["unsupported review decision", '{"decision":"review","reason":"unclear"}'],
    ["empty reason", '{"decision":"deny","reason":""}'],
    [
      "prose wrapped JSON",
      'I think {"decision":"allow","reason":"safe"} should pass.',
    ],
    [
      "multiple greedy objects",
      'first {"decision":"allow","reason":"safe"} second {"decision":"deny","reason":"evil"}',
    ],
  ])("fails closed for malformed response: %s", async (_label, text) => {
    const adapter = adapterReturning(text);

    const response = await adapter.review({ prompt: "prompt", shape });

    expect(response.effect).toBe("review");
    expect(response.reason).toContain("invalid JSON");
    expect(response.effect).not.toBe("allow");
  });

  it.each(["error", "aborted"] as const)(
    "fails closed when stopReason is %s",
    async (stopReason) => {
    const adapter = createPiModelAdapter(
      fakeContext({ model: fakeModel(), hasConfiguredAuth: true }),
      {
        invokeModel: async () =>
          assistantMessage({
            text: '{"decision":"allow","reason":"safe"}',
            stopReason,
          }),
      },
    );

    const response = await adapter.review({ prompt: "prompt", shape });

    expect(response).toMatchObject({
      effect: "review",
      reason: expect.stringContaining("model auto-reviewer error"),
    });
    expect(response.usage).toBeUndefined();
    },
  );

  it("fails closed when the assistant message carries errorMessage", async () => {
    const adapter = createPiModelAdapter(
      fakeContext({ model: fakeModel(), hasConfiguredAuth: true }),
      {
        invokeModel: async () =>
          assistantMessage({
            text: '{"decision":"allow","reason":"safe"}',
            errorMessage: "provider said no",
          }),
      },
    );

    const response = await adapter.review({ prompt: "prompt", shape });

    expect(response).toMatchObject({
      effect: "review",
      reason: expect.stringContaining("provider said no"),
    });
    expect(response.usage).toBeUndefined();
  });

  it("fails closed when the model invocation throws", async () => {
    const adapter = createPiModelAdapter(
      fakeContext({ model: fakeModel(), hasConfiguredAuth: true }),
      {
        invokeModel: async () => {
          throw new Error("provider unavailable");
        },
      },
    );

    const response = await adapter.review({ prompt: "prompt", shape });

    expect(response).toMatchObject({
      effect: "review",
      reason: expect.stringContaining("provider unavailable"),
      resolvedModel: { provider: "fake-provider", id: "fake-model" },
      resolvedModelSource: "fallback",
    });
    expect(response.usage).toBeUndefined();
  });

  it("fails closed without invoking the model when auth is not configured", async () => {
    let calls = 0;
    const adapter = createPiModelAdapter(
      fakeContext({
        model: fakeModel(),
        hasConfiguredAuth: true,
        authResult: { ok: false, error: "missing key" },
      }),
      {
        invokeModel: async () => {
          calls += 1;
          return assistantMessage({ text: "{}" });
        },
      },
    );

    const response = await adapter.review({ prompt: "prompt", shape });

    expect(calls).toBe(0);
    expect(response).toMatchObject({
      effect: "review",
      reason: expect.stringContaining("missing key"),
      resolvedModel: { provider: "fake-provider", id: "fake-model" },
      resolvedModelSource: "fallback",
    });
    expect(response.usage).toBeUndefined();
  });

  it("fails closed without invoking the model when auth resolution throws", async () => {
    let calls = 0;
    const adapter = createPiModelAdapter(
      fakeContext({
        model: fakeModel(),
        hasConfiguredAuth: true,
        authError: new Error("auth command failed"),
      }),
      {
        invokeModel: async () => {
          calls += 1;
          return assistantMessage({ text: "{}" });
        },
      },
    );

    const response = await adapter.review({ prompt: "prompt", shape });

    expect(calls).toBe(0);
    expect(response).toMatchObject({
      effect: "review",
      reason: expect.stringContaining("auth command failed"),
      resolvedModel: { provider: "fake-provider", id: "fake-model" },
      resolvedModelSource: "fallback",
    });
    expect(response.usage).toBeUndefined();
  });

  it("fails closed without invoking the model when no model is configured", async () => {
    let calls = 0;
    const adapter = createPiModelAdapter(
      fakeContext({ model: undefined, hasConfiguredAuth: true }),
      {
        invokeModel: async () => {
          calls += 1;
          return assistantMessage({ text: "{}" });
        },
      },
    );

    const response = await adapter.review({ prompt: "prompt", shape });

    expect(calls).toBe(0);
    expect(response).toEqual({
      effect: "review",
      reason: "no model configured",
    });
  });
});

function adapterReturning(text: string) {
  return createPiModelAdapter(
    fakeContext({ model: fakeModel(), hasConfiguredAuth: true }),
    {
      invokeModel: async () => assistantMessage({ text, totalTokens: 11 }),
    },
  );
}

type AuthResult =
  | {
      readonly ok: true;
      readonly apiKey?: string;
      readonly headers?: Record<string, string | null>;
      readonly env?: Record<string, string>;
    }
  | { readonly ok: false; readonly error: string };

type FakeContext = ExtensionContext;

function fakeContext(
  options: {
    readonly model?: Model<Api> | undefined;
    readonly hasConfiguredAuth?: boolean;
    readonly authResult?: AuthResult;
    readonly authError?: Error;
    readonly models?: readonly Model<Api>[];
  } = {},
): FakeContext {
  return {
    hasUI: false,
    mode: "tui",
    cwd: "/repo",
    model: options.model,
    modelRegistry: {
      find(provider: string, modelId: string) {
        return (options.models ?? [options.model]).find(
          (model): model is Model<Api> =>
            model !== undefined &&
            model.provider === provider &&
            model.id === modelId,
        );
      },
      getAll() {
        return (options.models ?? [options.model]).filter(
          (model): model is Model<Api> => model !== undefined,
        );
      },
      hasConfiguredAuth: () => options.hasConfiguredAuth ?? false,
      async getApiKeyAndHeaders(): Promise<AuthResult> {
        if (options.authError !== undefined) throw options.authError;
        return options.authResult ?? { ok: true, apiKey: "test-key" };
      },
    },
    signal: undefined,
    ui: {
      async confirm(): Promise<boolean> {
        return false;
      },
      notify(): void {},
    },
    sessionManager: { getSessionId: () => "model-adapter-test" },
    isProjectTrusted: () => false,
  } as unknown as FakeContext;
}

function fakeModel(
  overrides: Partial<Pick<Model<Api>, "id" | "name" | "provider">> = {},
): Model<Api> {
  return {
    id: overrides.id ?? "fake-model",
    name: overrides.name ?? "Fake Model",
    api: "openai-responses",
    provider: overrides.provider ?? "fake-provider",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

function assistantMessage(
  options: {
    readonly text: string;
    readonly totalTokens?: number;
    readonly stopReason?: AssistantMessage["stopReason"];
    readonly errorMessage?: string;
  } = { text: "{}" },
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: options.text }],
    api: "openai-responses",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: options.totalTokens ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage === undefined
      ? {}
      : { errorMessage: options.errorMessage }),
    timestamp: 0,
  };
}
