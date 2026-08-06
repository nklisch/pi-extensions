import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type ResolvedConfig } from "../../src/config/loader.ts";
import {
  applyPackEnablementPlan,
  type PackEnablementPostWriteValidationResult,
} from "../../src/config/pack-enablement-writer.ts";
import { resolveConfigPaths } from "../../src/config/paths.ts";
import type { RawPolicyPack } from "../../src/config/schema.ts";
import {
  type PackEnablementPlan,
  planPackEnablementChange,
} from "../../src/packs/enablement.ts";
import type { PackSourceInfo } from "../../src/packs/registry.ts";
import { createPackRegistry } from "../../src/packs/registry.ts";
import { createPackAvailabilityValidationReport } from "../../src/packs/validation.ts";
import type { PolicyPack } from "../../src/policy/core.ts";
import { compilePack } from "../../src/policy/core.ts";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ENV = { ...process.env };

const PACKAGE_SOURCE: PackSourceInfo & { readonly kind: "package" } = {
  kind: "package",
  packageName: "demo-pkg",
  packageVersion: "1.0.0",
  packagePath: "/packages/demo-pkg",
};

let tempRoot: string;
let cwd: string;
let configHome: string;

beforeEach(async () => {
  setPlatform("linux");
  tempRoot = await mkdtemp(path.join(tmpdir(), "pi-clearance-writer-"));
  cwd = path.join(tempRoot, "repo");
  configHome = path.join(tempRoot, "xdg-config");
  process.env = { ...ORIGINAL_ENV, XDG_CONFIG_HOME: configHome };
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  process.env = { ...ORIGINAL_ENV };
});

describe("applyPackEnablementPlan", () => {
  it("creates a missing config file from version defaults and validates after write", async () => {
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const resolved = await loadConfig({ cwd });
    const plan = buildPackagePlan(resolved, [pkg]);
    const validatePostWrite = vi.fn(
      async (
        config: ResolvedConfig,
      ): Promise<PackEnablementPostWriteValidationResult> => {
        if (config.errors.length > 0) {
          return {
            ok: false,
            errors: config.errors.map((error) => error.message),
          };
        }
        return { ok: true, warnings: ["post-write ok"] };
      },
    );

    const result = await applyPackEnablementPlan(plan, acknowledge(plan), {
      reloadConfig: () => loadConfig({ cwd }),
      validatePostWrite,
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(validatePostWrite).toHaveBeenCalledTimes(1);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.backupPath).toBeUndefined();
    expect(result.warnings).toEqual(["post-write ok"]);

    const written = await readJson(plan.targetPath);
    expect(written).toEqual({
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:pkg"] },
    });
  });

  it("backs up an existing file and atomically replaces the target", async () => {
    const paths = resolveConfigPaths(cwd);
    const original = {
      version: 1,
      packEnablement: { disabledPackagePacks: ["pack:pkg"] },
    };
    await writeJson(paths.globalConfigFile, original);
    const resolved = await loadConfig({ cwd });
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const plan = buildPackagePlan(resolved, [pkg]);

    const result = await applyPackEnablementPlan(plan, acknowledge(plan), {
      reloadConfig: () => loadConfig({ cwd }),
      validatePostWrite: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.backupPath).toBe(`${paths.globalConfigFile}.bak`);
    await expect(readJson(`${paths.globalConfigFile}.bak`)).resolves.toEqual(
      original,
    );
    await expect(readJson(paths.globalConfigFile)).resolves.toEqual({
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:pkg"] },
    });
    const leftovers = await readdir(path.dirname(paths.globalConfigFile));
    expect(leftovers.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses confirmation mismatches before writing", async () => {
    const resolved = await loadConfig({ cwd });
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const plan = buildPackagePlan(resolved, [pkg]);

    const result = await applyPackEnablementPlan(
      plan,
      { confirmedPlanId: "stale-plan", acknowledgedWarningCodes: [] },
      {
        reloadConfig: () => loadConfig({ cwd }),
        validatePostWrite: async () => ({ ok: true }),
      },
    );

    expect(result).toMatchObject({ ok: false, wrote: false, restored: false });
    await expect(readFile(plan.targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses stale plans when packEnablement changed after preview", async () => {
    const paths = resolveConfigPaths(cwd);
    const resolved = await loadConfig({ cwd });
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const plan = buildPackagePlan(resolved, [pkg]);
    const concurrentConfig = {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:other"] },
    };
    await writeJson(paths.globalConfigFile, concurrentConfig);

    const result = await applyPackEnablementPlan(plan, acknowledge(plan), {
      reloadConfig: () => loadConfig({ cwd }),
      validatePostWrite: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({ ok: false, wrote: false, restored: false });
    expect(result.ok ? undefined : result.reason).toContain(
      "no longer matches",
    );
    await expect(readJson(paths.globalConfigFile)).resolves.toEqual(
      concurrentConfig,
    );
  });

  it("refuses stale plans when pack definitions changed after preview", async () => {
    const paths = resolveConfigPaths(cwd);
    const originalPack = rawPack("pack:authored");
    await writeJson(paths.globalConfigFile, {
      version: 1,
      packs: [originalPack],
    });
    const resolved = await loadConfig({ cwd });
    const plan = buildConfigPackDisablePlan(resolved, "pack:authored");
    const changedConfig = {
      version: 1,
      packs: [rawPack("pack:authored", { reason: "changed after preview" })],
    };
    await writeJson(paths.globalConfigFile, changedConfig);

    const result = await applyPackEnablementPlan(plan, acknowledge(plan), {
      reloadConfig: () => loadConfig({ cwd }),
      validatePostWrite: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({ ok: false, wrote: false, restored: false });
    expect(result.ok ? undefined : result.reason).toContain(
      "pack definitions no longer match",
    );
    await expect(readJson(paths.globalConfigFile)).resolves.toEqual(
      changedConfig,
    );
  });

  it("accepts unchanged project packs whose rule provenance was defaulted then rewritten", async () => {
    const paths = resolveConfigPaths(cwd);
    const projectPackWithoutProvenance = {
      version: 1,
      id: "pack:project-authored",
      rules: [
        {
          id: "pack:project-authored:rule",
          effect: "allow",
          match: { program: "node" },
          reason: "fixture project pack",
        },
      ],
    };
    await writeJson(paths.projectOverlayFile, {
      version: 1,
      packs: [projectPackWithoutProvenance],
    });
    const resolved = await loadConfig({ cwd });
    const plan = buildConfigPackDisablePlan(
      resolved,
      "pack:project-authored",
      "project",
    );

    const result = await applyPackEnablementPlan(plan, acknowledge(plan), {
      reloadConfig: () => loadConfig({ cwd }),
      validatePostWrite: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    await expect(readJson(paths.projectOverlayFile)).resolves.toMatchObject({
      packEnablement: { disabledConfigPacks: ["pack:project-authored"] },
    });
  });

  it("requires all warning acknowledgements before writing", async () => {
    const pkg = compilePackOrThrow(
      rawPack("pack:danger", {
        metadata: {
          warnings: [{ level: "danger", message: "Requires operator review." }],
        },
      }),
    );
    const resolved = await loadConfig({ cwd });
    const plan = buildPackagePlan(resolved, [pkg], "pack:danger");

    expect(plan.requiredAcknowledgementCodes).toEqual(["metadata-danger-0"]);

    const result = await applyPackEnablementPlan(
      plan,
      { confirmedPlanId: plan.id, acknowledgedWarningCodes: [] },
      {
        reloadConfig: () => loadConfig({ cwd }),
        validatePostWrite: async () => ({ ok: true }),
      },
    );

    expect(result).toMatchObject({ ok: false, wrote: false });
    await expect(readFile(plan.targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses schema-invalid patched config before writing", async () => {
    const resolved = await loadConfig({ cwd });
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const plan = buildPackagePlan(resolved, [pkg]);
    const invalidPlan: PackEnablementPlan = {
      ...plan,
      id: "pack-enable:invalid-schema",
      patch: [
        {
          op: "replace",
          path: "/packEnablement/enabledPackagePacks",
          value: [""],
        },
      ],
      requiredAcknowledgementCodes: [],
    };

    const result = await applyPackEnablementPlan(
      invalidPlan,
      acknowledge(invalidPlan),
      {
        reloadConfig: () => loadConfig({ cwd }),
        validatePostWrite: async () => ({ ok: true }),
      },
    );

    expect(result).toMatchObject({ ok: false, wrote: false });
    if (result.ok) {
      throw new Error("expected schema failure");
    }
    expect(result.reason).toBe("patched config failed schema validation");
    await expect(readFile(plan.targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores the target when post-write policy validation fails", async () => {
    const paths = resolveConfigPaths(cwd);
    const original = {
      version: 1,
      packEnablement: { disabledPackagePacks: ["pack:pkg"] },
    };
    await writeJson(paths.globalConfigFile, original);
    const resolved = await loadConfig({ cwd });
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const plan = buildPackagePlan(resolved, [pkg]);

    const result = await applyPackEnablementPlan(plan, acknowledge(plan), {
      reloadConfig: () => loadConfig({ cwd }),
      validatePostWrite: async () => ({
        ok: false,
        errors: ["sealed floor validation failed"],
      }),
    });

    expect(result).toEqual({
      ok: false,
      planId: plan.id,
      targetPath: plan.targetPath,
      reason: "post-write policy validation failed",
      wrote: true,
      restored: true,
      errors: ["sealed floor validation failed"],
    });
    await expect(readJson(paths.globalConfigFile)).resolves.toEqual(original);
    await expect(readJson(`${paths.globalConfigFile}.bak`)).resolves.toEqual(
      original,
    );
  });

  it("removes a newly created file when post-write validation fails", async () => {
    const resolved = await loadConfig({ cwd });
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const plan = buildPackagePlan(resolved, [pkg]);

    const result = await applyPackEnablementPlan(plan, acknowledge(plan), {
      reloadConfig: () => loadConfig({ cwd }),
      validatePostWrite: async () => ({ ok: false, errors: ["not ready"] }),
    });

    expect(result).toMatchObject({ ok: false, wrote: true, restored: true });
    await expect(readFile(plan.targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

function buildPackagePlan(
  resolved: ResolvedConfig,
  packs: readonly PolicyPack[],
  packId = "pack:pkg",
): PackEnablementPlan {
  const registry = createPackRegistry({
    resolvedConfig: resolved,
    packagePacks: packs.map((pack) => ({ pack, source: PACKAGE_SOURCE })),
  });
  const report = createPackAvailabilityValidationReport({
    registry,
    context: {
      resolvedConfig: {
        mode: resolved.mode,
        errors: resolved.errors,
        warnings: resolved.warnings,
      },
    },
  });
  const result = planPackEnablementChange({
    request: {
      action: "enable",
      scope: "global",
      subject: "package",
      packId,
    },
    paths: resolveConfigPaths(cwd),
    resolvedConfig: resolved,
    availabilityReport: report,
  });

  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.plan;
}

function buildConfigPackDisablePlan(
  resolved: ResolvedConfig,
  packId: string,
  scope: "global" | "project" = "global",
): PackEnablementPlan {
  const result = planPackEnablementChange({
    request: {
      action: "disable",
      scope,
      subject: "config-pack",
      packId,
    },
    paths: resolveConfigPaths(cwd),
    resolvedConfig: resolved,
    availabilityReport: createPackAvailabilityValidationReport({
      registry: createPackRegistry({ resolvedConfig: resolved }),
      context: {
        resolvedConfig: {
          mode: resolved.mode,
          errors: resolved.errors,
          warnings: resolved.warnings,
        },
      },
    }),
  });

  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.plan;
}

function acknowledge(plan: PackEnablementPlan) {
  return {
    confirmedPlanId: plan.id,
    acknowledgedWarningCodes: plan.requiredAcknowledgementCodes,
  };
}

function rawPack(
  id: string,
  options: {
    readonly metadata?: RawPolicyPack["metadata"];
    readonly reason?: string;
  } = {},
): RawPolicyPack {
  return {
    version: 1,
    id,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    rules: [
      {
        id: `${id}:rule`,
        effect: "allow",
        match: { program: "node" },
        reason: options.reason ?? `fixture ${id}`,
        provenance: { source: "package" },
      },
    ],
  } as RawPolicyPack;
}

function compilePackOrThrow(raw: RawPolicyPack): PolicyPack {
  const result = compilePack(raw);
  if (result.pack === null) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.pack;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
