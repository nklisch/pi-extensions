import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditLogger } from "../../../src/audit/logger.ts";
import { loadConfig } from "../../../src/config/loader.ts";
import { resolveConfigPaths } from "../../../src/config/paths.ts";
import type { ProjectScopeConfig } from "../../../src/config/schema.ts";
import type { PackageRegistrationSnapshot } from "../../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../../src/packs/registry.ts";
import { createDefaultAnalyzerRegistry } from "../../../src/parse/registry.ts";
import type { EffectivePolicy } from "../../../src/policy/core.ts";
import type { AutoReviewerCommandDependencies } from "../../../src/runtime/command-registry.ts";
import { validateConfigCommandPostWrite } from "../../../src/runtime/config-commands/post-write-validation.ts";
import {
  getScopeArgumentCompletions,
  handleScopeCommand,
} from "../../../src/runtime/config-commands/scope.ts";
import type {
  PolicyResolver,
  PolicyResolverResult,
} from "../../../src/runtime/policy-cache.ts";
import type {
  RatchetModeManager,
  RatchetModeResult,
  RatchetModeStatus,
  RatchetToolDefinition,
} from "../../../src/runtime/ratchet-mode.ts";
import { createAuditLogRecentDecisionSource } from "../../../src/runtime/reviewer-context-adapter.ts";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ENV = { ...process.env };
const EMPTY_POLICY: EffectivePolicy = { rules: [] };
const INACTIVE_STATUS: RatchetModeStatus = {
  active: false,
  previousActiveTools: [],
  ratchetToolNames: [],
};

let tempRoot: string;
let cwd: string;
let configHome: string;

beforeEach(async () => {
  setPlatform("linux");
  tempRoot = await mkdtemp(path.join(tmpdir(), "pi-clearance-scope-"));
  cwd = path.join(tempRoot, "repo");
  configHome = path.join(tempRoot, "xdg-config");
  process.env = { ...ORIGINAL_ENV, XDG_CONFIG_HOME: configHome };
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  process.env = { ...ORIGINAL_ENV };
});

class FakeRatchetModeManager implements RatchetModeManager {
  isRatchetActive(): boolean {
    return false;
  }

  getStatus(): RatchetModeStatus {
    return INACTIVE_STATUS;
  }

  registerRatchetTool(_tool: RatchetToolDefinition): void {}

  enterRatchetMode(): RatchetModeResult {
    return {
      ok: true,
      status: INACTIVE_STATUS,
      message: "unused",
    };
  }

  exitRatchetMode(): RatchetModeResult {
    return {
      ok: true,
      status: INACTIVE_STATUS,
      message: "unused",
    };
  }
}

interface FakeContextOptions {
  readonly hasUI?: boolean;
  readonly trusted?: boolean;
  readonly confirmResult?: boolean;
}

interface FakeContext extends ExtensionCommandContext {
  readonly confirmCalls: readonly {
    readonly title: string;
    readonly message: string;
  }[];
}

function fakeContext(options: FakeContextOptions = {}): FakeContext {
  const confirmCalls: { title: string; message: string }[] = [];
  return {
    hasUI: options.hasUI ?? true,
    cwd,
    isProjectTrusted: () => options.trusted ?? true,
    ui: {
      async confirm(title: string, message: string): Promise<boolean> {
        confirmCalls.push({ title, message });
        return options.confirmResult ?? true;
      },
      notify(): void {},
    },
    confirmCalls,
  } as unknown as FakeContext;
}

function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return {
    requestId: null,
    packs: [],
    issues: [],
  };
}

function dependencies(): AutoReviewerCommandDependencies & {
  readonly invalidations: readonly (string | undefined)[];
} {
  const invalidations: (string | undefined)[] = [];
  const policyResolver: PolicyResolver = {
    async resolve(ctx): Promise<PolicyResolverResult> {
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
          warnings: config.warnings.map((warning) => warning.message),
        },
      };
    },
    invalidate(invalidatedCwd) {
      invalidations.push(invalidatedCwd);
    },
  };
  const audit: AuditLogger = { async log() {} };

  return {
    manager: new FakeRatchetModeManager(),
    policyResolver,
    packageRegistration: emptyPackageRegistrationSnapshot,
    audit,
    recentDecisionSource: createAuditLogRecentDecisionSource(),
    analyzerRegistry: createDefaultAnalyzerRegistry(),
    invalidations,
  };
}

describe("handleScopeCommand", () => {
  it("displays raw configured scope and resolved implicit cwd/temp defaults", async () => {
    const paths = resolveConfigPaths(cwd);
    await writeJson(paths.projectOverlayFile, {
      version: 1,
      projectScope: {
        roots: ["../workspace"],
        writableDirectories: ["build"],
        tempDirectories: ["local-tmp"],
        deniedDirectories: ["secrets"],
        safeHomeDirectories: ["dev"],
        safeHomeUseDefaults: false,
        unknownPathBehavior: "deny",
      },
    });

    const report = await handleScopeCommand([], fakeContext(), dependencies());

    expect(report.level).toBe("info");
    expect(report.markdown).toContain("# Auto-reviewer project scope");
    expect(report.markdown).toContain("lexical-only");
    expect(report.markdown).toContain("does not follow symlinks");
    expect(report.markdown).toContain("Unknown path behavior: deny");
    expect(report.markdown).toContain(
      `\`../workspace\` → \`${path.resolve(cwd, "../workspace")}\``,
    );
    expect(report.markdown).toContain(
      `\`build\` → \`${path.resolve(cwd, "build")}\``,
    );
    expect(report.markdown).toContain("Safe-home defaults: off");
    expect(report.markdown).toContain("### safeHomeDirectories");
    const homeDirectory = (
      report.details as { implicit: { homeDirectory: string } }
    ).implicit.homeDirectory;
    expect(report.markdown).toContain(
      `\`dev\` → \`${path.resolve(homeDirectory, "dev")}\``,
    );
    expect(report.markdown).toContain(
      `\`${path.resolve(cwd)}\` (implicit cwd root)`,
    );
    expect(report.markdown).toContain(
      `\`${path.resolve(cwd)}\` (implicit cwd writable)`,
    );
    expect(report.markdown).toContain(
      `\`${path.resolve(tmpdir())}\` (implicit OS temp)`,
    );
    expect(report.details).toMatchObject({
      raw: {
        roots: ["../workspace"],
        writableDirectories: ["build"],
        tempDirectories: ["local-tmp"],
        deniedDirectories: ["secrets"],
        safeHomeDirectories: ["dev"],
        safeHomeUseDefaults: false,
        unknownPathBehavior: "deny",
      },
    });
  });

  it("adds and removes every path-list field in the project overlay only", async () => {
    const paths = resolveConfigPaths(cwd);
    await writeJson(paths.projectOverlayFile, {
      version: 1,
      promptAppends: ["keep project note"],
    });
    const ctx = fakeContext();
    const deps = dependencies();
    const cases = [
      ["roots", "roots", "../shared-root"],
      ["writable", "writableDirectories", "generated"],
      ["temp", "tempDirectories", "local-tmp"],
      ["denied", "deniedDirectories", "/sensitive"],
      ["safe-home", "safeHomeDirectories", "dev"],
      ["agent-support", "agentSupportDirectories", "/opt/pi-support"],
    ] as const;

    for (const [command, field, rawPath] of cases) {
      const add = await handleScopeCommand(
        [command, "add", rawPath],
        ctx,
        deps,
      );
      expect(add.markdown).toContain("Changed: yes");
      await expect(readProjectScope(paths.projectOverlayFile)).resolves.toEqual(
        expect.objectContaining({ [field]: expect.arrayContaining([rawPath]) }),
      );

      const remove = await handleScopeCommand(
        [command, "remove", rawPath],
        ctx,
        deps,
      );
      expect(remove.markdown).toContain("Changed: yes");
      await expect(readProjectScope(paths.projectOverlayFile)).resolves.toEqual(
        expect.objectContaining({ [field]: [] }),
      );
    }

    await expect(readJson(paths.projectOverlayFile)).resolves.toMatchObject({
      promptAppends: ["keep project note"],
    });
    await expect(
      readFile(paths.globalConfigFile, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(ctx.confirmCalls).toHaveLength(12);
    expect(deps.invalidations).toEqual([
      cwd,
      cwd,
      cwd,
      cwd,
      cwd,
      cwd,
      cwd,
      cwd,
      cwd,
      cwd,
      cwd,
      cwd,
    ]);
  });

  it("reports duplicate add and missing remove as confirmed no-op changes", async () => {
    const paths = resolveConfigPaths(cwd);
    await writeJson(paths.projectOverlayFile, {
      version: 1,
      projectScope: { roots: ["src"] },
    });
    const ctx = fakeContext();
    const deps = dependencies();

    const duplicate = await handleScopeCommand(
      ["roots", "add", "src"],
      ctx,
      deps,
    );
    const missing = await handleScopeCommand(
      ["roots", "remove", "missing"],
      ctx,
      deps,
    );

    expect(duplicate.markdown).toContain("Changed: no");
    expect(missing.markdown).toContain("Changed: no");
    expect(ctx.confirmCalls).toHaveLength(2);
    expect(ctx.confirmCalls[0]?.message).toContain("No-op");
    expect(deps.invalidations).toEqual([]);
    await expect(readProjectScope(paths.projectOverlayFile)).resolves.toEqual(
      expect.objectContaining({ roots: ["src"] }),
    );
  });

  it("rejects writable directories outside all configured roots before confirmation or writing", async () => {
    const paths = resolveConfigPaths(cwd);
    const ctx = fakeContext();
    const deps = dependencies();

    const report = await handleScopeCommand(
      ["writable", "add", "/outside/project/build"],
      ctx,
      deps,
    );

    expect(report.level).toBe("error");
    expect(report.summary).toContain("outside all configured project roots");
    expect(ctx.confirmCalls).toEqual([]);
    expect(deps.invalidations).toEqual([]);
    await expect(
      readFile(paths.projectOverlayFile, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("post-write validation fails closed on resolved project-scope errors", async () => {
    const paths = resolveConfigPaths(cwd);
    await writeJson(paths.projectOverlayFile, {
      version: 1,
      projectScope: { writableDirectories: ["../outside"] },
    });
    const resolved = await loadConfig({ cwd, isProjectTrusted: true });

    await expect(
      validateConfigCommandPostWrite(resolved, {
        audit: dependencies().audit,
        packageRegistration: emptyPackageRegistrationSnapshot,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: [
        expect.stringContaining(
          `resolved config error after write (schema) at ${paths.projectOverlayFile}`,
        ),
      ],
    });
  });

  it("accepts only review or deny for unknown-path behavior", async () => {
    const paths = resolveConfigPaths(cwd);
    const ctx = fakeContext();
    const deps = dependencies();

    const allow = await handleScopeCommand(
      ["unknown-path", "allow"],
      ctx,
      deps,
    );

    expect(allow.level).toBe("error");
    expect(allow.markdown).toContain("allow");
    expect(ctx.confirmCalls).toEqual([]);

    const deny = await handleScopeCommand(["unknown-path", "deny"], ctx, deps);

    expect(deny.level).toBe("warning");
    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.confirmCalls[0]?.message).toContain(
      "unknown-path behavior to deny",
    );
    // The derived scope-behavior pack now consumes the deny intent, so the
    // stale "fails closed to review" warning is gone.
    expect(ctx.confirmCalls[0]?.message).not.toContain(
      "fail closed to review",
    );
    await expect(readProjectScope(paths.projectOverlayFile)).resolves.toEqual(
      expect.objectContaining({ unknownPathBehavior: "deny" }),
    );
    expect(deps.invalidations).toEqual([cwd]);
  });

  it("applies a scope preset as one bundle write", async () => {
    const paths = resolveConfigPaths(cwd);
    const ctx = fakeContext();
    const deps = dependencies();

    const result = await handleScopeCommand(
      ["preset", "unrestricted"],
      ctx,
      deps,
    );

    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.confirmCalls[0]?.message).toContain(
      "Apply scope preset: Full minus danger list",
    );
    // The unrestricted preset breadth warning requires acknowledgement.
    expect(ctx.confirmCalls[0]?.message).toContain(
      "requires acknowledgement",
    );
    expect(result.level).not.toBe("error");
    await expect(readProjectScope(paths.projectOverlayFile)).resolves.toEqual(
      expect.objectContaining({
        sensitivePathBehavior: "deny",
        homePathBehavior: "allow",
        unknownPathBehavior: "review",
      }),
    );
    expect(deps.invalidations).toEqual([cwd]);
  });

  it("rejects an unknown preset name", async () => {
    const ctx = fakeContext();
    const deps = dependencies();

    const result = await handleScopeCommand(["preset", "everything"], ctx, deps);

    expect(result.title).toBe("Pi Clearance usage");
    expect(ctx.confirmCalls).toEqual([]);
  });

  it("toggles safe-home defaults in the project overlay only", async () => {
    const paths = resolveConfigPaths(cwd);
    const ctx = fakeContext();
    const deps = dependencies();

    const off = await handleScopeCommand(
      ["safe-home-defaults", "off"],
      ctx,
      deps,
    );

    expect(off.level).toBe("warning");
    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.confirmCalls[0]?.message).toContain(
      "Disable safe-home defaults",
    );
    await expect(readProjectScope(paths.projectOverlayFile)).resolves.toEqual(
      expect.objectContaining({ safeHomeUseDefaults: false }),
    );
    await expect(
      readFile(paths.globalConfigFile, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(deps.invalidations).toEqual([cwd]);
  });

  it("toggles agent-support defaults in the project overlay only", async () => {
    const paths = resolveConfigPaths(cwd);
    const ctx = fakeContext();
    const deps = dependencies();

    const off = await handleScopeCommand(
      ["agent-support-defaults", "off"],
      ctx,
      deps,
    );

    expect(off.level).toBe("warning");
    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.confirmCalls[0]?.message).toContain(
      "Disable agent-support defaults",
    );
    await expect(readProjectScope(paths.projectOverlayFile)).resolves.toEqual(
      expect.objectContaining({ agentSupportUseDefaults: false }),
    );
  });

  it("refuses mutations without UI and does not write when confirmation is cancelled", async () => {
    const paths = resolveConfigPaths(cwd);
    const deps = dependencies();

    const noUi = await handleScopeCommand(
      ["roots", "add", "src"],
      fakeContext({ hasUI: false }),
      deps,
    );

    expect(noUi.level).toBe("error");
    expect(noUi.markdown).toContain("require Pi UI confirmation");

    const cancelledCtx = fakeContext({ confirmResult: false });
    const cancelled = await handleScopeCommand(
      ["roots", "add", "src"],
      cancelledCtx,
      deps,
    );

    expect(cancelled.level).toBe("warning");
    expect(cancelled.markdown).toContain("No config changes were written");
    expect(cancelledCtx.confirmCalls).toHaveLength(1);
    expect(deps.invalidations).toEqual([]);
    await expect(
      readFile(paths.projectOverlayFile, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes scope subcommands, actions, and unknown-path values", () => {
    expect(completionValues(getScopeArgumentCompletions([], ""))).toEqual([
      "roots",
      "writable",
      "temp",
      "denied",
      "safe-home",
      "agent-support",
      "safe-home-defaults",
      "agent-support-defaults",
      "unknown-path",
      "preset",
    ]);
    expect(
      completionValues(getScopeArgumentCompletions(["preset"], "")),
    ).toEqual(["project", "home", "unrestricted"]);
    expect(
      completionValues(getScopeArgumentCompletions(["roots"], "")),
    ).toEqual(["add", "remove"]);
    expect(
      completionValues(getScopeArgumentCompletions(["unknown-path"], "")),
    ).toEqual(["review", "deny"]);
    expect(
      completionValues(getScopeArgumentCompletions(["safe-home-defaults"], "")),
    ).toEqual(["on", "off"]);
    expect(
      completionValues(
        getScopeArgumentCompletions(["agent-support-defaults"], ""),
      ),
    ).toEqual(["on", "off"]);
  });
});

function completionValues(
  values: ReturnType<typeof getScopeArgumentCompletions>,
): readonly string[] {
  return values?.map((item) => item.value) ?? [];
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readProjectScope(
  filePath: string,
): Promise<ProjectScopeConfig | undefined> {
  const value = await readJson(filePath);
  return value.projectScope as ProjectScopeConfig | undefined;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
