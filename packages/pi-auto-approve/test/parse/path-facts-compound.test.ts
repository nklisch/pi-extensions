import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPolicyDecisionEntry } from "../../src/audit/log.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import {
  defaultSystemPathPrefixes,
  deriveBashPathFacts,
  enrichToolShapeWithPathFacts,
  type PathFactProjectScope,
} from "../../src/parse/native-path-facts.ts";
import type { BashCommandShape, BashPathFact } from "../../src/parse/shape.ts";
import type { EffectivePolicy } from "../../src/policy/core.ts";
import {
  decide,
  evalMatcher,
  inspectable,
  pathScopesAllIn,
} from "../../src/policy/core.ts";
import {
  createPiModelAdapter,
  type PiModelInvoker,
} from "../../src/runtime/model-adapter.ts";

const ORIGINAL_PLATFORM = process.platform;
const CWD = "/home/user/proj";
const HOME = "/home/user";

beforeEach(() => {
  setPlatform("linux");
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

function makeScope(
  overrides: Partial<PathFactProjectScope> = {},
): PathFactProjectScope {
  return {
    roots: [CWD, "/home/user/readonly-area"],
    writableDirectories: [CWD, `${CWD}/build`],
    tempDirectories: ["/var/tmp", "/tmp/os-tmp"],
    deniedDirectories: [`${CWD}/secrets`, "/opt/secret"],
    safeHomeDirectories: ["/home/user/dev", "/home/user/repos"],
    unknownPathBehavior: "review",
    ...overrides,
  };
}

const PATH_FACTS_CONTEXT = {
  cwd: CWD,
  projectScope: makeScope(),
  homeDirectory: HOME,
  systemPathPrefixes: defaultSystemPathPrefixes(),
};

async function enrichedBash(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error(`expected bash shape for ${command}`);
  }

  const enriched = enrichToolShapeWithPathFacts(shape, PATH_FACTS_CONTEXT);
  expect(enriched.kind).toBe("bash");
  if (enriched.kind !== "bash") {
    throw new Error(`expected enriched bash shape for ${command}`);
  }
  return enriched;
}

function compoundFacts(shape: BashCommandShape): readonly BashPathFact[] {
  return (shape.pathFacts?.facts ?? []).filter((fact) =>
    fact.id.startsWith("path:compound:loop-var:"),
  );
}

function firstCompoundFact(shape: BashCommandShape): BashPathFact {
  const fact = compoundFacts(shape)[0];
  if (fact === undefined) {
    throw new Error("expected a compound loop-variable path fact");
  }
  return fact;
}

function projectPathMatcher(
  scopes = ["project", "writable-project", "temp"] as const,
) {
  return inspectable(pathScopesAllIn({ scopes }));
}

describe("compound body path-fact propagation", () => {
  it("emits provenance for the motivating sed loop without treating echo as a path use", async () => {
    const shape = await enrichedBash(
      "for f in .work/backlog/*.md; do echo '---' \"$f\"; sed -n '1,120p' \"$f\"; done",
    );
    const loop = shape.stages[0];
    expect(loop?.kind).toBe("for-loop");
    if (loop?.kind !== "for-loop") throw new Error("expected for-loop");

    const echoStage = loop.body.pipeline.stages[0];
    expect(echoStage?.kind).toBe("command");
    if (echoStage?.kind !== "command") throw new Error("expected echo stage");
    expect(echoStage.program.variableReferences).toEqual([
      expect.objectContaining({ name: "f", raw: '"$f"' }),
    ]);

    const facts = compoundFacts(shape);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      raw: '"$f"',
      usage: "argument",
      access: "read",
      program: "sed",
      scope: "writable-project",
      globApproximation: true,
      provenance: {
        kind: "loop-variable",
        variableName: "f",
        iteratorSourceKind: "literal-glob",
        loopStageIndex: 0,
        iteratorEntries: [
          expect.objectContaining({
            raw: ".work/backlog/*.md",
            literal: ".work/backlog/",
            scope: "writable-project",
          }),
        ],
      },
    });
    expect(facts[0]?.absolutePath).toBeUndefined();
    expect(shape.pathFacts?.hasUnknown).toBe(false);
  });

  it("emits one provenance fact for cat loop inputs and no duplicate generic dynamic unknown", async () => {
    const shape = await enrichedBash(
      'for f in .work/backlog/*.md; do cat "$f"; done',
    );

    const rawVariableFacts = (shape.pathFacts?.facts ?? []).filter(
      (fact) => fact.raw === '"$f"',
    );
    expect(rawVariableFacts).toHaveLength(1);
    expect(rawVariableFacts[0]).toMatchObject({
      id: expect.stringContaining("path:compound:loop-var:"),
      scope: "writable-project",
      provenance: expect.objectContaining({ variableName: "f" }),
    });
    expect(rawVariableFacts[0]?.unknownReason).toBeUndefined();
  });

  it("propagates same-loop provenance through a brace-group body", async () => {
    const shape = await enrichedBash(
      'for f in *.md; do { echo "$f"; cat "$f"; }; done',
    );

    const facts = compoundFacts(shape);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      program: "cat",
      scope: "writable-project",
      globApproximation: true,
      provenance: expect.objectContaining({ variableName: "f" }),
    });
  });

  it("classifies denied, home, and mixed iterators conservatively", async () => {
    const denied = await enrichedBash(
      'for f in /opt/secret/*.txt; do cat "$f"; done',
    );
    expect(firstCompoundFact(denied)).toMatchObject({ scope: "denied" });
    expect(evalMatcher(projectPathMatcher(), denied)).toBe(false);

    const homeGlob = await enrichedBash('for f in ~/x/*.md; do cat "$f"; done');
    expect(firstCompoundFact(homeGlob)).toMatchObject({
      scope: "home",
      globApproximation: true,
      provenance: expect.objectContaining({
        iteratorEntries: [
          expect.objectContaining({ raw: "~/x/*.md", scope: "home" }),
        ],
      }),
    });
    expect(evalMatcher(projectPathMatcher(), homeGlob)).toBe(false);

    const mixed = await enrichedBash(
      'for f in .work/in/*.md /etc/x; do cat "$f"; done',
    );
    expect(firstCompoundFact(mixed)).toMatchObject({
      scope: "system",
      provenance: expect.objectContaining({ iteratorSourceKind: "mixed" }),
    });
    expect(evalMatcher(projectPathMatcher(), mixed)).toBe(false);
  });

  it("emits unknown provenance for iterator reductions that fail closed", async () => {
    const withoutHome = await analyzeBashCommand(
      'for f in ~/x; do cat "$f"; done',
    );
    expect(withoutHome.kind).toBe("bash");
    if (withoutHome.kind !== "bash") throw new Error("expected bash shape");

    const facts = deriveBashPathFacts(withoutHome, {
      cwd: CWD,
      projectScope: makeScope(),
      systemPathPrefixes: defaultSystemPathPrefixes(),
    });
    expect(facts.hasUnknown).toBe(true);
    expect(facts.facts[0]).toMatchObject({
      raw: '"$f"',
      scope: "unknown",
      provenance: {
        variableName: "f",
        iteratorSourceKind: "opaque",
        unknownReason: "opaque-iterator",
        iteratorEntries: [
          expect.objectContaining({
            raw: "~/x",
            unknownReason: "unsupported-shell-literal",
          }),
        ],
      },
    });
  });

  it("uses the read-only file-input seam for sed, grep, and fail-closed programs", async () => {
    const sedInPlace = await enrichedBash(
      "for f in *.md; do sed -i 's/x/y/' \"$f\"; done",
    );
    expect(compoundFacts(sedInPlace)).toEqual([]);

    const sedWithoutQuiet = await enrichedBash(
      "for f in *.md; do sed '1,120p' \"$f\"; done",
    );
    expect(compoundFacts(sedWithoutQuiet)).toEqual([]);

    const grep = await enrichedBash(
      'for f in *.md; do grep pattern "$f"; done',
    );
    expect(firstCompoundFact(grep)).toMatchObject({
      program: "grep",
      scope: "writable-project",
    });

    const findReadOnlyButNoArgRoles = await enrichedBash(
      'for f in *.md; do find "$f" -name x; done',
    );
    expect(compoundFacts(findReadOnlyButNoArgRoles)).toEqual([]);

    const findDestructive = await enrichedBash(
      'for f in *.md; do find "$f" -delete; done',
    );
    expect(compoundFacts(findDestructive)).toEqual([]);
  });

  it("keeps redirect targets unchanged and does not trust variable-derived redirects", async () => {
    const literalRedirect = await enrichedBash(
      'for f in *.md; do cat "$f" > out; done',
    );
    const redirectFact = (literalRedirect.pathFacts?.facts ?? []).find(
      (fact) => fact.usage === "redirect-target",
    );
    expect(redirectFact).toMatchObject({
      raw: "out",
      access: "write",
      scope: "writable-project",
    });
    // Current effect classification treats output-redirect stages as writes, so
    // the read-input seam returns no trusted file operands for this body command.
    expect(compoundFacts(literalRedirect)).toEqual([]);

    const variableRedirect = await enrichedBash(
      'for f in *.md; do echo ok > "$f"; done',
    );
    expect(variableRedirect.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "bash:redirect-expansion" }),
      ]),
    );
    expect(compoundFacts(variableRedirect)).toEqual([]);
    expect(
      (variableRedirect.pathFacts?.facts ?? []).find(
        (fact) => fact.usage === "redirect-target",
      ),
    ).toMatchObject({ raw: '"$f"', scope: "unknown" });
  });

  it("lets existing path-scope matchers consume compound facts unchanged", async () => {
    const project = await enrichedBash(
      'for f in .work/backlog/*.md; do cat "$f"; done',
    );
    const unknown = await enrichedBash('for f in $LIST; do cat "$f"; done');
    const denied = await enrichedBash(
      'for f in /opt/secret/*.txt; do cat "$f"; done',
    );

    expect(evalMatcher(projectPathMatcher(), project)).toBe(true);
    expect(evalMatcher(projectPathMatcher(), unknown)).toBe(false);
    expect(evalMatcher(projectPathMatcher(), denied)).toBe(false);
  });

  it("policy diagnostic review gate beats otherwise project-local compound facts", async () => {
    const shape = await enrichedBash('for f in *.md; do cat "$f"; done');
    const diagnosticShape = {
      ...shape,
      diagnostics: [
        ...shape.diagnostics,
        {
          code: "bash:compound-body-unsupported",
          severity: "error" as const,
          message: "synthetic unsupported compound diagnostic",
        },
      ],
    } satisfies BashCommandShape;
    const policy: EffectivePolicy = {
      floor: [],
      active: [
        {
          id: "allow-project-compound-read",
          effect: "allow",
          match: projectPathMatcher(),
          reason: "project-local compound read",
          provenance: { source: "generated" },
        },
      ],
    };

    expect(evalMatcher(projectPathMatcher(), diagnosticShape)).toBe(true);
    expect(decide(diagnosticShape, policy)).toMatchObject({
      effect: "review",
      reason: "parse diagnostics present",
    });
  });

  it("carries provenance and glob approximation through audit and reviewer model payloads", async () => {
    const shape = await enrichedBash(
      'for f in .work/backlog/*.md; do cat "$f"; done',
    );
    const auditEntry = createPolicyDecisionEntry({
      entryType: "policy.decision",
      toolName: "bash",
      toolInput: { command: shape.rawCommand },
      shape,
      decision: {
        effect: "review",
        reason: "coverage assertion",
        provenance: { source: "default" },
      },
    });

    const auditText = JSON.stringify(auditEntry);
    expect(auditText).toContain(".work/backlog/*.md");
    expect(auditText).toContain("globApproximation");

    let capturedContext: Context | undefined;
    const invokeModel: PiModelInvoker = async (_model, context) => {
      capturedContext = context;
      return assistantMessage({
        text: '{"decision":"deny","reason":"coverage"}',
      });
    };
    const adapter = createPiModelAdapter(
      fakeContext({ model: fakeModel(), hasConfiguredAuth: true }),
      { invokeModel },
    );

    await adapter.review({ prompt: "prompt", shape });

    const reviewerPayload = capturedContext?.messages[0]?.content ?? "";
    expect(reviewerPayload).toContain(".work/backlog/*.md");
    expect(reviewerPayload).toContain("globApproximation");
  });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

type AuthResult =
  | { readonly ok: true; readonly apiKey?: string }
  | { readonly ok: false; readonly error: string };

function fakeContext(options: {
  readonly model?: Model<Api> | undefined;
  readonly hasConfiguredAuth?: boolean;
  readonly authResult?: AuthResult;
}): ExtensionContext {
  return {
    hasUI: false,
    mode: "tui",
    cwd: CWD,
    model: options.model,
    modelRegistry: {
      find(provider: string, modelId: string) {
        const model = options.model;
        return model?.provider === provider && model.id === modelId
          ? model
          : undefined;
      },
      getAll() {
        return options.model === undefined ? [] : [options.model];
      },
      hasConfiguredAuth: () => options.hasConfiguredAuth ?? false,
      async getApiKeyAndHeaders(): Promise<AuthResult> {
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
    sessionManager: { getSessionId: () => "compound-path-facts-test" },
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;
}

function fakeModel(): Model<Api> {
  return {
    id: "fake-model",
    name: "Fake Model",
    api: "openai-responses",
    provider: "fake-provider",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

function assistantMessage(
  options: { readonly text: string } = { text: "{}" },
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
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}
