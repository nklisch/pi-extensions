import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planModeCommandChange } from "../../src/config/config-command-plans.ts";
import {
  applyConfigCommandPlan,
  type ConfigCommandPlan,
  writeConfigTargetAndValidate,
} from "../../src/config/config-command-writer.ts";
import { loadConfig, type ResolvedConfig } from "../../src/config/loader.ts";
import { resolveConfigPaths } from "../../src/config/paths.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
} from "../../src/config/schema.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
} from "../fixtures/resolved-config.ts";

const ORIGINAL_ENV = { ...process.env };

let tempRoot: string;
let cwd: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "pi-clearance-config-writer-"));
  cwd = path.join(tempRoot, "repo");
  process.env = {
    ...ORIGINAL_ENV,
    XDG_CONFIG_HOME: path.join(tempRoot, "config"),
  };
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function config(): ResolvedConfig {
  const reviewer = {
    promptPosture: "reviewer.default",
    promptAppends: [],
    projectPromptAppends: [],
    promptOverride: null,
    model: null,
    tokenBudget: { window: "24h", limit: null },
    contextMode: "recentContext" as const,
    recentContext: {
      decisionLimit: 25,
      decisionWindow: "2h",
      conversationTurns: 3,
      conversationCharLimit: 6000,
    },
    escalation: { enabled: true, denialLimit: 3, window: "10m" },
  };
  return {
    version: 1,
    cwd: "/tmp/project",
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted: false,
    },
    reviewer,
    display: defaultResolvedDisplay(),
    errors: [],
    warnings: [],
    sourceSnapshots: {
      paths: {
        userConfigRoot: "/tmp/config",
        globalConfigFile: "/tmp/config/global.json",
        projectDir: "/tmp/config/project",
        projectOverlayFile: "/tmp/config/project/overlay.json",
        repoPolicyFile: "/tmp/project/.pi-clearance/policy.json",
        projectKey: "project-key",
      },
      global: {
        version: 1,
        mode: "ask",
        packs: [],
        packEnablement: {},
        reviewer: {},
        display: {},
      } as never,
      project: {
        version: 1,
        packs: [],
        packEnablement: {},
        projectScope: {},
        promptAppends: [],
      } as never,
      repository: {
        version: 1,
        packs: [],
        promptAppends: [],
      } as never,
    },
  };
}

describe("mode config command plan", () => {
  it("writes only global mode", () => {
    const result = planModeCommandChange({
      mode: "auto",
      resolvedConfig: config(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.target.kind).toBe("global");
      expect(result.plan.patch).toEqual(
        expect.arrayContaining([
          { op: "replace", path: "/mode", before: "ask", value: "auto" },
        ]),
      );
    }
  });

  it("serializes the changed normalized config sparsely through the shared writer", async () => {
    const beforeResult = normalizeConfig(GlobalConfigSchema, { version: 1 });
    const afterResult = normalizeConfig(GlobalConfigSchema, {
      version: 1,
      mode: "auto",
      reviewer: { model: "openai/example" },
    });
    if (!beforeResult.ok || !afterResult.ok) {
      throw new Error("fixture config failed schema normalization");
    }

    const paths = resolveConfigPaths(cwd);
    const plan: ConfigCommandPlan = {
      id: "config-command:test-sparse",
      target: { kind: "global", path: paths.globalConfigFile },
      title: "Test sparse config write",
      summary: "Test sparse config write",
      patch: [
        { op: "replace", path: "/mode", before: "ask", value: "auto" },
        {
          op: "replace",
          path: "/reviewer/model",
          before: null,
          value: "openai/example",
        },
      ],
      before: beforeResult.value,
      after: afterResult.value,
      requiredAcknowledgementCodes: [],
      warnings: [],
    };

    const result = await applyConfigCommandPlan(
      plan,
      { confirmedPlanId: plan.id, acknowledgedWarningCodes: [] },
      {
        reloadConfig: () => loadConfig({ cwd }),
        validatePostWrite: async () => ({ ok: true }),
      },
    );

    expect(result).toMatchObject({ ok: true, changed: true });
    await expect(
      readFile(paths.globalConfigFile, "utf8").then((text) => JSON.parse(text)),
    ).resolves.toEqual({
      version: 1,
      mode: "auto",
      reviewer: { model: "openai/example" },
    });
  });

  it("preserves the primary write result when temp cleanup also fails", async () => {
    const normalized = normalizeConfig(GlobalConfigSchema, {
      version: 1,
      mode: "auto",
    });
    if (!normalized.ok) throw new Error("fixture config failed normalization");

    const paths = resolveConfigPaths(cwd);
    let tempPath: string | undefined;
    const diagnostics: string[] = [];
    const priorConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      diagnostics.push(args.map(String).join(" "));
    };
    let result: Awaited<ReturnType<typeof writeConfigTargetAndValidate>>;
    try {
      result = await writeConfigTargetAndValidate({
        planId: "config-command:cleanup-failure",
        targetPath: paths.globalConfigFile,
        configKind: "global",
        value: normalized.value,
        hadExistingFile: false,
        reloadConfig: async () => config(),
        validatePostWrite: async () => ({ ok: true }),
        writeFailureReason: "config command write failed",
        postWriteFailureReason: "post-write validation failed",
        renameTempFile: async (sourcePath) => {
          tempPath = sourcePath;
          throw new Error("rename failed");
        },
        cleanupTempFile: async () => {
          throw new Error("cleanup failed");
        },
      });
    } finally {
      console.error = priorConsoleError;
    }

    expect(result).toMatchObject({
      ok: false,
      reason: "config command write failed",
      errors: [
        "rename failed",
        "temporary config file cleanup failed: cleanup failed",
      ],
    });
    expect(diagnostics).toEqual([
      "Pi Clearance temporary config file cleanup failed: cleanup failed",
    ]);
    expect(tempPath).toBeDefined();
    if (tempPath !== undefined) await rm(tempPath, { force: true });
  });
});
