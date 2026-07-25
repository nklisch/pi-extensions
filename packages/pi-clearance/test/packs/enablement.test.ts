import { describe, expect, it } from "vitest";

import type { ResolvedConfig } from "../../src/config/loader.ts";
import type { ConfigPaths } from "../../src/config/paths.ts";
import type { RawPolicyPack } from "../../src/config/schema.ts";
import {
  type PackEnablementRequest,
  planPackEnablementChange,
} from "../../src/packs/enablement.ts";
import type { PackSourceInfo } from "../../src/packs/registry.ts";
import { createPackRegistry } from "../../src/packs/registry.ts";
import {
  createPackAvailabilityValidationReport,
  type PackAvailabilityValidationReport,
} from "../../src/packs/validation.ts";
import type { PolicyPack } from "../../src/policy/core.ts";
import { compilePack } from "../../src/policy/core.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../fixtures/resolved-config.ts";

const PATHS: Pick<ConfigPaths, "globalConfigFile" | "projectOverlayFile"> = {
  globalConfigFile: "/config/pi-clearance/global.json",
  projectOverlayFile: "/config/pi-clearance/projects/repo/overlay.json",
};

const PACKAGE_SOURCE: PackSourceInfo & { readonly kind: "package" } = {
  kind: "package",
  packageName: "demo-pkg",
  packageVersion: "1.0.0",
  packagePath: "/packages/demo-pkg",
};

function resolvedConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    version: 1,
    cwd: "/repo",
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    display: defaultResolvedDisplay(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted: true,
    },
    reviewer: defaultResolvedReviewer(),
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function rawPack(
  id: string,
  options: {
    readonly effect?: "allow" | "deny" | "review";
    readonly match?: unknown;
    readonly metadata?: RawPolicyPack["metadata"];
    readonly provenanceSource?: "user-global" | "user-project" | "package";
  } = {},
): RawPolicyPack {
  return {
    version: 1,
    id,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    rules: [
      {
        id: `${id}:rule`,
        effect: options.effect ?? "allow",
        match: options.match ?? { program: "node" },
        reason: `fixture ${id}`,
        provenance: { source: options.provenanceSource ?? "package" },
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

function packageReport(
  packs: readonly PolicyPack[],
  config: ResolvedConfig = resolvedConfig(),
): PackAvailabilityValidationReport {
  const registry = createPackRegistry({
    resolvedConfig: config,
    packagePacks: packs.map((pack) => ({ pack, source: PACKAGE_SOURCE })),
  });
  return createPackAvailabilityValidationReport({
    registry,
    context: {
      resolvedConfig: {
        mode: config.mode,
        errors: config.errors,
        warnings: config.warnings,
      },
    },
  });
}

function plan(
  request: PackEnablementRequest,
  config: ResolvedConfig,
  report: PackAvailabilityValidationReport = packageReport([], config),
) {
  return planPackEnablementChange({
    request,
    paths: PATHS,
    resolvedConfig: config,
    availabilityReport: report,
  });
}

describe("planPackEnablementChange package packs", () => {
  it("plans global package enablement with exact id-array patches only", () => {
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const config = resolvedConfig({
      packEnablement: {
        ...defaultResolvedPackEnablement(),
        global: {
          enabledPackagePacks: [],
          disabledPackagePacks: ["pack:pkg"],
          disabledConfigPacks: [],
        },
      },
    });

    const result = plan(
      {
        action: "enable",
        scope: "global",
        subject: "package",
        packId: "pack:pkg",
      },
      config,
      packageReport([pkg], config),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.targetPath).toBe(PATHS.globalConfigFile);
    expect(result.plan.patch).toEqual([
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: [],
        value: ["pack:pkg"],
      },
      {
        op: "replace",
        path: "/packEnablement/disabledPackagePacks",
        before: ["pack:pkg"],
        value: [],
      },
    ]);
    expect(result.plan.after.packs).toEqual(result.plan.before.packs);

    const repeated = plan(
      {
        action: "enable",
        scope: "global",
        subject: "package",
        packId: "pack:pkg",
      },
      config,
      packageReport([pkg], config),
    );
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) {
      throw new Error(repeated.reason);
    }
    expect(repeated.plan.id).toBe(result.plan.id);
  });

  it("plans project package disablement without touching config packs", () => {
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const configPack = rawPack("pack:config", {
      provenanceSource: "user-project",
    });
    const config = resolvedConfig({
      projectPacks: [configPack],
      packEnablement: {
        ...defaultResolvedPackEnablement(),
        project: {
          enabledPackagePacks: ["pack:pkg", "pack:other"],
          disabledPackagePacks: [],
          disabledConfigPacks: [],
        },
      },
    });

    const result = plan(
      {
        action: "disable",
        scope: "project",
        subject: "package",
        packId: "pack:pkg",
      },
      config,
      packageReport([pkg], config),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.targetPath).toBe(PATHS.projectOverlayFile);
    expect(result.plan.patch).toEqual([
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: ["pack:pkg", "pack:other"],
        value: ["pack:other"],
      },
      {
        op: "replace",
        path: "/packEnablement/disabledPackagePacks",
        before: [],
        value: ["pack:pkg"],
      },
    ]);
    expect(result.plan.before.packs).toEqual([configPack]);
    expect(result.plan.after.packs).toEqual([configPack]);
    expect(result.plan.patch.map((operation) => operation.path)).not.toContain(
      "/packs",
    );
  });

  it("allows package disablement without an available or safe candidate", () => {
    const config = resolvedConfig({
      packEnablement: {
        ...defaultResolvedPackEnablement(),
        global: {
          enabledPackagePacks: ["pack:gone"],
          disabledPackagePacks: [],
          disabledConfigPacks: [],
        },
      },
    });

    const result = plan(
      {
        action: "disable",
        scope: "global",
        subject: "package",
        packId: "pack:gone",
      },
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.patch).toEqual([
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: ["pack:gone"],
        value: [],
      },
      {
        op: "replace",
        path: "/packEnablement/disabledPackagePacks",
        before: [],
        value: ["pack:gone"],
      },
    ]);
    expect(result.plan.requiredAcknowledgementCodes).toEqual([]);
  });

  it("returns a deterministic idempotent no-op plan", () => {
    const pkg = compilePackOrThrow(rawPack("pack:pkg"));
    const config = resolvedConfig({
      packEnablement: {
        ...defaultResolvedPackEnablement(),
        global: {
          enabledPackagePacks: ["pack:pkg"],
          disabledPackagePacks: [],
          disabledConfigPacks: [],
        },
      },
    });
    const request: PackEnablementRequest = {
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:pkg",
    };

    const first = plan(request, config, packageReport([pkg], config));
    const second = plan(request, config, packageReport([pkg], config));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("expected no-op plans");
    }
    expect(first.plan.patch).toEqual([]);
    expect(second.plan.id).toBe(first.plan.id);
    expect(first.plan.after).toEqual(first.plan.before);
  });

  it("refuses missing, duplicate, and unsafe package candidates", () => {
    const clean = compilePackOrThrow(rawPack("pack:dup"));
    const duplicateReport = packageReport([clean, clean]);
    const unsafe = compilePackOrThrow(
      rawPack("pack:unsafe", { match: { program: "sudo" } }),
    );
    const config = resolvedConfig();

    const missing = plan(
      {
        action: "enable",
        scope: "global",
        subject: "package",
        packId: "pack:missing",
      },
      config,
    );
    const duplicate = plan(
      {
        action: "enable",
        scope: "global",
        subject: "package",
        packId: "pack:dup",
      },
      config,
      duplicateReport,
    );
    const unsafeResult = plan(
      {
        action: "enable",
        scope: "global",
        subject: "package",
        packId: "pack:unsafe",
      },
      config,
      packageReport([unsafe], config),
    );

    expect(missing).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not available"),
    });
    expect(duplicate).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ambiguous"),
    });
    expect(unsafeResult).toMatchObject({
      ok: false,
      reason: expect.stringContaining("blocking issues"),
    });
    if (!unsafeResult.ok) {
      expect(unsafeResult.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("sealed-floor-overlap"),
        ]),
      );
    }
  });

  it("surfaces metadata danger warnings as required acknowledgements", () => {
    const pkg = compilePackOrThrow(
      rawPack("pack:danger", {
        metadata: {
          warnings: [
            {
              level: "danger",
              message: "Can approve broad package workflows.",
            },
          ],
        },
      }),
    );

    const result = plan(
      {
        action: "enable",
        scope: "global",
        subject: "package",
        packId: "pack:danger",
      },
      resolvedConfig(),
      packageReport([pkg]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "metadata-danger-0",
          level: "danger",
          requiresAcknowledgement: true,
        }),
      ]),
    );
    expect(result.plan.requiredAcknowledgementCodes).toContain(
      "metadata-danger-0",
    );
  });
});

describe("planPackEnablementChange config-owned packs", () => {
  it("disables a user-authored config pack by preserving its raw definition", () => {
    const authored = rawPack("pack:authored", {
      provenanceSource: "user-global",
    });
    const config = resolvedConfig({ globalPacks: [authored] });

    const result = plan(
      {
        action: "disable",
        scope: "global",
        subject: "config-pack",
        packId: "pack:authored",
      },
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.patch).toEqual([
      {
        op: "replace",
        path: "/packEnablement/disabledConfigPacks",
        before: [],
        value: ["pack:authored"],
      },
    ]);
    expect(result.plan.after.packs).toEqual([authored]);
  });

  it("validates an existing config pack before re-enabling it", () => {
    const unsafe = rawPack("pack:unsafe", {
      provenanceSource: "user-global",
      match: { program: "sudo" },
    });
    const config = resolvedConfig({
      globalPacks: [unsafe],
      packEnablement: {
        ...defaultResolvedPackEnablement(),
        global: {
          enabledPackagePacks: [],
          disabledPackagePacks: [],
          disabledConfigPacks: ["pack:unsafe"],
        },
      },
    });

    const result = plan(
      {
        action: "enable",
        scope: "global",
        subject: "config-pack",
        packId: "pack:unsafe",
      },
      config,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("blocking issues"),
    });
  });

  it("adds a validated raw config pack when enabling an absent authored pack", () => {
    const raw = rawPack("pack:new", { provenanceSource: "user-project" });
    const config = resolvedConfig({
      packEnablement: {
        ...defaultResolvedPackEnablement(),
        project: {
          enabledPackagePacks: [],
          disabledPackagePacks: [],
          disabledConfigPacks: ["pack:new"],
        },
      },
    });

    const result = plan(
      {
        action: "enable",
        scope: "project",
        subject: "config-pack",
        packId: "pack:new",
        rawPack: raw,
      },
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.patch).toEqual([
      {
        op: "replace",
        path: "/packEnablement/disabledConfigPacks",
        before: ["pack:new"],
        value: [],
      },
      { op: "add", path: "/packs/-", value: raw },
    ]);
    expect(result.plan.after.packs).toEqual([raw]);
  });

  it("refuses new raw config packs that duplicate available registry candidates", () => {
    const pkg = compilePackOrThrow(rawPack("pack:dupe"));
    const raw = rawPack("pack:dupe", { provenanceSource: "user-global" });
    const config = resolvedConfig();

    const result = plan(
      {
        action: "enable",
        scope: "global",
        subject: "config-pack",
        packId: "pack:dupe",
        rawPack: raw,
      },
      config,
      packageReport([pkg], config),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already exists"),
    });
    if (!result.ok) {
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "config-pack-id-conflict" }),
        ]),
      );
    }
  });

  it("refuses malformed raw config packs and duplicate config ids", () => {
    const duplicate = rawPack("pack:dup", { provenanceSource: "user-global" });
    const config = resolvedConfig({
      globalPacks: [duplicate],
      projectPacks: [rawPack("pack:dup", { provenanceSource: "user-project" })],
    });

    const malformed = plan(
      {
        action: "enable",
        scope: "global",
        subject: "config-pack",
        packId: "pack:bad",
        rawPack: { version: 1, id: "pack:bad", rules: [{ bad: true }] },
      },
      resolvedConfig(),
    );
    const dup = plan(
      {
        action: "disable",
        scope: "project",
        subject: "config-pack",
        packId: "pack:dup",
      },
      config,
    );

    expect(malformed).toMatchObject({
      ok: false,
      reason: expect.stringContaining("compiled"),
    });
    expect(dup).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ambiguous"),
    });
  });
});
