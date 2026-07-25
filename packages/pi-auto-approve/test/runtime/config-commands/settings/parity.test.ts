import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditLogger } from "../../../../src/audit/logger.ts";
import { inferScopePreset } from "../../../../src/config/config-command-plans.ts";
import { loadConfig } from "../../../../src/config/loader.ts";
import { resolveConfigPaths } from "../../../../src/config/paths.ts";
import type { ProjectScopeConfig } from "../../../../src/config/schema.ts";
import type { PackageRegistrationSnapshot } from "../../../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../../../src/packs/registry.ts";
import { createDefaultAnalyzerRegistry } from "../../../../src/parse/registry.ts";
import type { EffectivePolicy } from "../../../../src/policy/core.ts";
import type { AutoReviewerCommandDependencies } from "../../../../src/runtime/command-registry.ts";
import { dispatchSettingsAction } from "../../../../src/runtime/config-commands/settings/dispatcher.ts";
import {
  packItems,
  SettingsNativeUiComponent,
} from "../../../../src/runtime/config-commands/settings/native-ui.ts";
import { availableReviewerModels } from "../../../../src/runtime/config-commands/settings.ts";
import {
  buildSettingsReadModel,
  type SettingsReadModel,
} from "../../../../src/runtime/config-commands/settings/read-model.ts";
import type { PolicyResolver } from "../../../../src/runtime/policy-cache.ts";
import { createAuditLogRecentDecisionSource } from "../../../../src/runtime/reviewer-context-adapter.ts";
import { buildAutoReviewerStatusView } from "../../../../src/runtime/auto-reviewer-read-models.ts";

const ORIGINAL_ENV = { ...process.env };
const EMPTY_POLICY: EffectivePolicy = { rules: [] };

let tempRoot: string;
let cwd: string;
let configHome: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "pi-auto-approve-parity-"));
  cwd = path.join(tempRoot, "repo");
  configHome = path.join(tempRoot, "xdg-config");
  process.env = { ...ORIGINAL_ENV, XDG_CONFIG_HOME: configHome };
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function fakeContext(): ExtensionCommandContext & {
  readonly confirmCalls: readonly { title: string; message: string }[];
} {
  const confirmCalls: { title: string; message: string }[] = [];
  return {
    hasUI: true,
    cwd,
    isProjectTrusted: () => true,
    ui: {
      async confirm(title: string, message: string): Promise<boolean> {
        confirmCalls.push({ title, message });
        return true;
      },
      notify(): void {},
    },
    confirmCalls,
  } as unknown as ExtensionCommandContext & {
    readonly confirmCalls: readonly { title: string; message: string }[];
  };
}

function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return { requestId: null, packs: [], issues: [] };
}

function dependencies(): AutoReviewerCommandDependencies {
  const policyResolver: PolicyResolver = {
    async resolve(ctx) {
      const config = await loadConfig({
        cwd: ctx.cwd,
        isProjectTrusted: ctx.isProjectTrusted(),
      });
      return {
        ok: true,
        policy: {
          config,
          effectivePolicy: EMPTY_POLICY,
          registry: createPackRegistry({ resolvedConfig: config }),
          packageRegistration: emptyPackageRegistrationSnapshot(),
          warnings: [],
        },
      };
    },
    invalidate() {},
  };
  const audit: AuditLogger = { async log() {} };

  return {
    manager: {
      isRatchetActive: () => false,
      getStatus: () => ({
        active: false,
        previousActiveTools: [],
        ratchetToolNames: [],
      }),
      registerRatchetTool: () => {},
      enterRatchetMode: () => ({
        ok: true,
        status: {
          active: false,
          previousActiveTools: [],
          ratchetToolNames: [],
        },
        message: "unused",
      }),
      exitRatchetMode: () => ({
        ok: true,
        status: {
          active: false,
          previousActiveTools: [],
          ratchetToolNames: [],
        },
        message: "unused",
      }),
    },
    policyResolver,
    packageRegistration: emptyPackageRegistrationSnapshot,
    audit,
    recentDecisionSource: createAuditLogRecentDecisionSource(),
    analyzerRegistry: createDefaultAnalyzerRegistry(),
  };
}

async function readGlobalConfig(): Promise<Record<string, unknown>> {
  const paths = resolveConfigPaths(cwd);
  return JSON.parse(await readFile(paths.globalConfigFile, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("briefing display actions", () => {
  it("briefing.mode writes display.reviewNote.mode to global config", async () => {
    const ctx = fakeContext();
    const result = await dispatchSettingsAction(
      { id: "briefing.mode", args: { mode: "off" } },
      ctx,
      dependencies(),
    );

    expect(result.level).not.toBe("error");
    const global = await readGlobalConfig();
    expect(global).toMatchObject({
      display: { reviewNote: { mode: "off" } },
    });
  });

  it("briefing.model-label and briefing.accent toggle their flags", async () => {
    const ctx = fakeContext();
    const deps = dependencies();

    await dispatchSettingsAction(
      { id: "briefing.model-label", args: { enabled: true } },
      ctx,
      deps,
    );
    await dispatchSettingsAction(
      { id: "briefing.accent", args: { enabled: false } },
      ctx,
      deps,
    );

    const global = await readGlobalConfig();
    expect(global).toMatchObject({
      display: { reviewNote: { showModelLabel: true, accent: false } },
    });
  });

  it("rejects an unknown briefing mode before any write", async () => {
    const ctx = fakeContext();
    const result = await dispatchSettingsAction(
      { id: "briefing.mode", args: { mode: "loud" } },
      ctx,
      dependencies(),
    );

    expect(result.level).toBe("error");
    await expect(readGlobalConfig()).rejects.toThrow();
  });
});

describe("scope preset settings action", () => {
  it("scope.preset applies the bundle through the settings dispatcher", async () => {
    const ctx = fakeContext();
    const result = await dispatchSettingsAction(
      { id: "scope.preset", args: { preset: "project" } },
      ctx,
      dependencies(),
    );

    expect(result.level).not.toBe("error");
    const paths = resolveConfigPaths(cwd);
    const overlay = JSON.parse(
      await readFile(paths.projectOverlayFile, "utf8"),
    ) as Record<string, unknown>;
    expect(overlay).toMatchObject({
      projectScope: {
        safeHomeUseDefaults: false,
        agentSupportUseDefaults: false,
        homePathBehavior: "review",
        sensitivePathBehavior: "review",
      },
    });
  });
});

describe("inferScopePreset", () => {
  const base: ProjectScopeConfig = {
    roots: [],
    writableDirectories: [],
    tempDirectories: [],
    deniedDirectories: [],
    safeHomeDirectories: [],
    safeHomeUseDefaults: true,
    agentSupportUseDefaults: true,
    unknownPathBehavior: "review",
    sensitivePathBehavior: "review",
    homePathBehavior: "allow",
  };

  it("infers each preset from its exact field bundle", () => {
    expect(inferScopePreset(base)).toBe("home");
    expect(
      inferScopePreset({
        ...base,
        safeHomeUseDefaults: false,
        agentSupportUseDefaults: false,
        homePathBehavior: "review",
      }),
    ).toBe("project");
    expect(
      inferScopePreset({ ...base, sensitivePathBehavior: "deny" }),
    ).toBe("unrestricted");
  });

  it("reports custom for mixed fields", () => {
    expect(
      inferScopePreset({ ...base, safeHomeUseDefaults: false }),
    ).toBe("custom");
  });

  it("normalizes schema defaults for older overlays", () => {
    const { agentSupportUseDefaults, sensitivePathBehavior, homePathBehavior, ...older } = base;
    void agentSupportUseDefaults;
    void sensitivePathBehavior;
    void homePathBehavior;
    expect(inferScopePreset(older as ProjectScopeConfig)).toBe("home");
  });
});

describe("availableReviewerModels", () => {
  it("passes the MODEL (not the provider string) to hasConfiguredAuth", () => {
    // Regression: Pi's ModelRegistry.hasConfiguredAuth takes a Model; passing
    // model.provider silently filtered out every model.
    const ctx = {
      modelRegistry: {
        getAll: () => [
          { provider: "anthropic", id: "claude-opus-4", name: "Opus 4" },
          { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
        ],
        hasConfiguredAuth: (model: { provider: string }) =>
          model.provider === "anthropic",
      },
    } as unknown as ExtensionCommandContext;

    const models = availableReviewerModels(ctx);
    expect(models).toHaveLength(1);
    expect(models[0]?.spec).toBe("anthropic/claude-opus-4");
    expect(models[0]?.label).toBe("Opus 4 (anthropic/claude-opus-4)");
  });

  it("returns an empty list when no model registry is present", () => {
    expect(
      availableReviewerModels({} as unknown as ExtensionCommandContext),
    ).toEqual([]);
  });
});

describe("pack toggle items", () => {
  function modelWithPacks(
    packs: SettingsReadModel["packs"],
  ): SettingsReadModel {
    return {
      packs,
    } as unknown as SettingsReadModel;
  }

  it("disables a project-enabled pack in project scope, not global", () => {
    const items = packItems(
      modelWithPacks([
        {
          id: "pack.one",
          title: "Pack One",
          enabled: true,
          toggleable: true,
          source: "package",
          enabledInGlobal: false,
          enabledInProject: true,
        },
      ]),
    );

    const toggle = items[0];
    expect(toggle?.kind).toBe("selection");
    if (toggle?.kind !== "selection") return;
    expect(toggle.label).toContain("●");
    expect(toggle.selection).toMatchObject({
      kind: "action",
      action: {
        id: "packs.disable",
        args: { packId: "pack.one", scope: "project" },
      },
    });
  });

  it("enables an available pack in global scope", () => {
    const items = packItems(
      modelWithPacks([
        {
          id: "pack.two",
          title: "Pack Two",
          enabled: false,
          toggleable: true,
          source: "package",
          enabledInGlobal: false,
          enabledInProject: false,
        },
      ]),
    );

    const toggle = items[0];
    if (toggle?.kind !== "selection") return;
    expect(toggle.label).toContain("○");
    expect(toggle.selection).toMatchObject({
      kind: "action",
      action: {
        id: "packs.enable",
        args: { packId: "pack.two", scope: "global" },
      },
    });
  });
});

describe("dossier navigation", () => {
  it("returns to the panel the dossier was opened from", () => {
    const component = new SettingsNativeUiComponent({
      model: {} as unknown as SettingsReadModel,
      initialScreen: "pack-dossier",
      dossierOrigin: "scope",
      message: { level: "info", text: "scope details", dossier: "line\n".repeat(3) },
      theme: {},
      done: () => {},
    });

    component.handleInput("b");

    expect(component.getNavigationState().screen).toBe("scope");
  });
});

describe("buildSettingsReadModel", () => {
  it("defaults packs and reviewerModels to empty lists", async () => {
    const config = await loadConfig({ cwd, isProjectTrusted: true });
    const model = buildSettingsReadModel({
      status: buildAutoReviewerStatusView({
        ctx: fakeContext(),
        policy: {
          config,
          effectivePolicy: EMPTY_POLICY,
          registry: createPackRegistry({ resolvedConfig: config }),
          packageRegistration: emptyPackageRegistrationSnapshot(),
          warnings: [],
        },
        ratchet: {
          active: false,
          previousActiveTools: [],
          ratchetToolNames: [],
        },
      }),
      projectScope: config.projectScope,
    });

    expect(model.packs).toEqual([]);
    expect(model.reviewerModels).toEqual([]);
    expect(model.briefing.configurable).toBe(true);
  });
});
